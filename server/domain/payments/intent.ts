import type Stripe from 'stripe'
import { HTTPError } from 'nitro'
import { execute, queryFirst, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { connectedBuyerCustomer } from '~/server/utils/billing-customer'
import { tokenHash } from './buyer'
import { requirePayment, type Payment } from './index'
import { surchargeBasisPoints, type PaymentReview } from './checkout'
import { reconcilePaymentIntent } from './events'

/**
 * The payment the buyer confirms on the site: Stripe's Payment Element collects
 * the method, the server attaches it to the PaymentIntent and reads what Stripe
 * says about a surcharge for that card, the buyer sees the final amount, and
 * only then is the intent confirmed. Each step is bound to the purchase claim
 * the checkout handed the browser, so another buyer cannot pay or review it.
 */
interface OpenAttempt { id: string; payment_id: string; stripe_payment_intent_id: string; expires_at: string; status: string; review_json: string | null }
type IntentWithSurcharge = Stripe.PaymentIntent & { amount_details?: { surcharge?: { status?: string; maximum_amount?: number; amount?: number } } }
export type PaymentHandoffState = 'open' | 'paid' | 'failed' | 'expired'

export async function requireOpenAttempt(db: DbClient, organizationId: string, paymentId: string, claim: string): Promise<{ payment: Payment; attempt: OpenAttempt; state: PaymentHandoffState }> {
  if (!/^[a-f0-9-]{72}$/u.test(claim)) throw new HTTPError({ statusCode: 400, statusMessage: 'Purchase claim required' })
  const attempt = await queryFirst<OpenAttempt>(db, `SELECT a.id,a.payment_id,a.stripe_payment_intent_id,a.expires_at,a.status,a.review_json FROM payment_attempts a JOIN payment_claims c ON c.payment_id=a.payment_id JOIN payments p ON p.id=a.payment_id
    WHERE a.payment_id=? AND p.organization_id=? AND c.token_hash=? AND a.stripe_payment_intent_id IS NOT NULL ORDER BY a.created_at DESC LIMIT 1`, [paymentId, organizationId, await tokenHash(claim)])
  if (!attempt) throw new HTTPError({ statusCode: 404, statusMessage: 'Payment not found' })
  const payment = await requirePayment(db, organizationId, paymentId)
  const state: PaymentHandoffState = payment.captured_amount > 0 ? 'paid' : payment.state === 'failed' ? 'failed' : attempt.expires_at <= new Date().toISOString() ? 'expired' : 'open'
  return { payment, attempt, state }
}

function parseReview(value: string | null): PaymentReview | null {
  if (!value) return null
  const review = JSON.parse(value) as PaymentReview
  if (typeof review.payment_method_id !== 'string' || !Number.isSafeInteger(review.subtotal) || !Number.isSafeInteger(review.surcharge) || review.total !== review.subtotal + review.surcharge) throw new Error('Stored payment review is invalid')
  return review
}

function snapshotOf(payment: Payment) {
  const snapshot = JSON.parse(payment.price_snapshot_json) as { title?: unknown; quantity?: unknown; method_configuration_id?: unknown }
  if (typeof snapshot.title !== 'string' || !Number.isSafeInteger(snapshot.quantity) || typeof snapshot.method_configuration_id !== 'string') throw new Error('Payment purchase snapshot is invalid')
  return { title: snapshot.title, quantity: snapshot.quantity as number, methodConfigurationId: snapshot.method_configuration_id }
}

/** What the pay page needs to mount Stripe's Payment Element on the connected account. */
export async function paymentHandoff(db: DbClient, stripe: Stripe, publishableKey: string, organizationId: string, paymentId: string, claim: string) {
  const { payment, attempt, state } = await requireOpenAttempt(db, organizationId, paymentId, claim)
  const snapshot = snapshotOf(payment)
  if (!publishableKey) throw new HTTPError({ statusCode: 503, statusMessage: 'Stripe is not configured' })
  // Stripe's own saved-card features for a signed-in buyer, scoped to this business's customer.
  let customerSession: string | null = null
  if (state === 'open' && payment.buyer_user_id) {
    const customer = await connectedBuyerCustomer(db, stripe, payment.buyer_user_id, payment.stripe_account_id, Boolean(payment.livemode))
    if (customer) {
      const session = await stripe.customerSessions.create({ customer: customer.customerId, components: { payment_element: { enabled: true, features: { payment_method_save: 'enabled', payment_method_save_usage: 'off_session', payment_method_redisplay: 'enabled', payment_method_redisplay_limit: 10, payment_method_remove: 'enabled' } } } }, { stripeAccount: payment.stripe_account_id })
      customerSession = session.client_secret
    }
  }
  return {
    payment_id: payment.id, state, title: snapshot.title, quantity: snapshot.quantity, subtotal: payment.amount, currency: payment.currency, expires_at: attempt.expires_at,
    stripe_account_id: payment.stripe_account_id, publishable_key: publishableKey, method_configuration_id: snapshot.methodConfigurationId,
    customer_session_client_secret: customerSession,
    surcharge_basis_points: await surchargeBasisPoints(db, organizationId, payment.stripe_account_id),
    review: parseReview(attempt.review_json),
  }
}

/**
 * The buyer's chosen method, attached to the intent so Stripe can say whether
 * this card may carry a surcharge and how much at most. The business's rate is
 * applied inside that bound; an ineligible card carries none. Stripe's answer
 * missing is an error, never a free payment.
 */
export async function reviewPayment(db: DbClient, stripe: Stripe, organizationId: string, paymentId: string, claim: string, paymentMethodId: string) {
  const { payment, attempt, state } = await requireOpenAttempt(db, organizationId, paymentId, claim)
  if (state !== 'open') throw new HTTPError({ statusCode: 409, statusMessage: state === 'paid' ? 'This payment is already complete' : state === 'expired' ? 'This payment has expired; start the booking again' : 'This payment was not accepted; start the booking again', data: { code: `payment_${state}` } })
  if (!/^pm_[A-Za-z0-9]+$/u.test(paymentMethodId)) throw new HTTPError({ statusCode: 400, statusMessage: 'Payment method required' })
  const rate = await surchargeBasisPoints(db, organizationId, payment.stripe_account_id)
  const intent = await stripe.paymentIntents.update(attempt.stripe_payment_intent_id, {
    payment_method: paymentMethodId,
    expand: ['payment_method'],
    ...(rate !== null ? { amount_details: { surcharge: { enforce_validation: 'enabled' } } } : {}),
  } as Stripe.PaymentIntentUpdateParams, { stripeAccount: payment.stripe_account_id }) as IntentWithSurcharge
  if (intent.metadata.krabiclaw_payment_id !== payment.id || intent.livemode !== Boolean(payment.livemode) || intent.amount !== payment.amount || intent.currency.toUpperCase() !== payment.currency) throw new Error('Stripe PaymentIntent does not match the purchase')
  const method = intent.payment_method
  if (!method || typeof method === 'string') throw new Error('Stripe did not return the attached payment method')
  let surcharge = 0
  if (rate !== null) {
    const native = intent.amount_details?.surcharge
    if (native?.status !== 'available' && native?.status !== 'unavailable') throw new Error('Stripe did not report surcharge availability for this payment method')
    if (native.status === 'available') {
      if (!Number.isSafeInteger(native.maximum_amount)) throw new Error('Stripe did not report the maximum surcharge')
      surcharge = Math.min(Math.floor(payment.amount * rate / 10_000), native.maximum_amount as number)
    }
  }
  const review: PaymentReview = { payment_method_id: method.id, subtotal: payment.amount, surcharge, total: payment.amount + surcharge, reviewed_at: new Date().toISOString() }
  await execute(db, 'UPDATE payment_attempts SET review_json=?,updated_at=? WHERE id=?', [JSON.stringify(review), review.reviewed_at, attempt.id])
  return { ...review, currency: payment.currency, method: { type: method.type, brand: method.card?.brand ?? null, last4: method.card?.last4 ?? null, funding: method.card?.funding ?? null, wallet: method.card?.wallet?.type ?? null } }
}

/**
 * Confirms exactly what was reviewed: the same method on the intent, the same
 * total. Stripe's own 3DS and capture follow; a succeeded intent settles here
 * and again, idempotently, from the webhook.
 */
export async function confirmPayment(db: DbClient, stripe: Stripe, env: CloudflareEnv, organizationId: string, paymentId: string, claim: string, input: { payment_method_id: string; total: number }) {
  const { payment, attempt, state } = await requireOpenAttempt(db, organizationId, paymentId, claim)
  if (state !== 'open') throw new HTTPError({ statusCode: 409, statusMessage: state === 'paid' ? 'This payment is already complete' : 'This payment can no longer be confirmed; start the booking again', data: { code: `payment_${state}` } })
  const review = parseReview(attempt.review_json)
  if (!review || review.payment_method_id !== input.payment_method_id || review.total !== input.total) throw new HTTPError({ statusCode: 409, statusMessage: 'Review the payment again before confirming', data: { code: 'review_required' } })
  const current = await stripe.paymentIntents.retrieve(attempt.stripe_payment_intent_id, {}, { stripeAccount: payment.stripe_account_id })
  const attached = typeof current.payment_method === 'string' ? current.payment_method : current.payment_method?.id
  if (current.status !== 'requires_confirmation' || attached !== review.payment_method_id || current.amount !== review.subtotal) throw new HTTPError({ statusCode: 409, statusMessage: 'The payment changed since it was reviewed; review it again', data: { code: 'review_required' } })
  if (!env.NUXT_PUBLIC_PLATFORM_DOMAIN) throw new Error('Platform domain is not configured')
  const returnUrl = new URL(`/account?payment_id=${encodeURIComponent(payment.id)}&purchase_claim=${encodeURIComponent(claim)}`, env.NUXT_PUBLIC_PLATFORM_DOMAIN).toString()
  const confirmed = await stripe.paymentIntents.confirm(attempt.stripe_payment_intent_id, {
    return_url: returnUrl,
    // The surcharged total is what Stripe charges; the surcharge inside it is named so receipts and refunds carry it.
    ...(review.surcharge > 0 ? { amount_to_confirm: review.total, amount_details: { surcharge: { amount: review.surcharge, enforce_validation: 'enabled' } } } : {}),
  } as Stripe.PaymentIntentConfirmParams, { stripeAccount: payment.stripe_account_id, idempotencyKey: `krabiclaw-confirm:${payment.id}:${review.reviewed_at}` })
  if (confirmed.status === 'succeeded') await reconcilePaymentIntent(db, stripe, payment, confirmed, env)
  return { status: confirmed.status, client_secret: confirmed.client_secret, requires_action: confirmed.status === 'requires_action', return_url: returnUrl }
}
