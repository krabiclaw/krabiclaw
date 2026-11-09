import { freeCancellationUntil } from '~/shared/availability-settings'
import type Stripe from 'stripe'
import { HTTPError } from 'nitro'
import { execute, queryFirst, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { connectedBuyerCustomer } from '~/server/utils/billing-customer'
import { claimCheckoutReturn, tokenHash } from './buyer'
import { requirePayment, type Payment } from './index'
import { isStayPurchase, surchargeBasisPoints, type PaymentReview } from './checkout'
import { PRICE_TAX_BEHAVIORS, type Price } from '~/shared/prices'
import { reconcilePaymentIntent, confirmationHoldUntil } from './events'
import { notifyPaymentFinancialEvent } from './notifications'
import { loadOwnerPictures } from '~/server/notifications/hero'
import { getGuestRequest } from '~/server/domain/requests'
import { createReplayableReservationCancelToken, hashReservationCancelToken } from '~/server/utils/reservation-cancel-token'

/**
 * The payment the buyer confirms on the site: Stripe's Payment Element collects
 * the method, the server attaches it to the PaymentIntent and reads what Stripe
 * says about a surcharge for that card, the buyer sees the final amount, and
 * only then is the intent confirmed. Each step is bound to the purchase claim
 * the checkout handed the browser, so another buyer cannot pay or review it.
 */
type IntentWithSurcharge = Stripe.PaymentIntent & { amount_details?: { surcharge?: { status?: string; maximum_amount?: number; amount?: number } } }
export type PaymentHandoffState = 'open' | 'processing' | 'verifying' | 'paid' | 'failed' | 'expired'

/** The purchase its return token authorizes, with what Stripe says of its intent now. */
export async function requireClaimedPayment(db: DbClient, stripe: Stripe, organizationId: string, paymentId: string, claim: string): Promise<{ payment: Payment; intent: Stripe.PaymentIntent; state: PaymentHandoffState }> {
  if (!/^[a-f0-9-]{72}$/u.test(claim)) throw new HTTPError({ statusCode: 400, statusMessage: 'Purchase claim required' })
  const payment = await queryFirst<Payment>(db, 'SELECT * FROM payments WHERE id=? AND organization_id=? AND return_token_hash=?', [paymentId, organizationId, await tokenHash(claim)])
  if (!payment?.stripe_payment_intent_id || !payment.checkout_expires_at || !payment.return_expires_at) throw new HTTPError({ statusCode: 404, statusMessage: 'Payment not found' })
  const intent = await stripe.paymentIntents.retrieve(payment.stripe_payment_intent_id, { expand: ['latest_charge'] }, { stripeAccount: payment.stripe_account_id })
  const now = new Date().toISOString()
  const state: PaymentHandoffState = payment.captured_amount > 0 || intent.status === 'succeeded' ? 'paid' : intent.status === 'requires_capture' || intent.status === 'processing' ? 'processing' : intent.status === 'canceled' ? 'failed' : intent.next_action?.type === 'verify_with_microdeposits' ? 'verifying' : payment.checkout_expires_at <= now || payment.return_expires_at <= now ? 'expired' : 'open'
  return { payment, intent, state }
}

/** Stripe's own page for confirming the microdeposits. */
function bankVerificationUrl(intent: Stripe.PaymentIntent): string {
  const url = intent.next_action?.verify_with_microdeposits?.hosted_verification_url
  if (!url) throw new Error('Stripe asked for bank verification without its verification page')
  return url
}

function parseReview(value: string | null): PaymentReview | null {
  if (!value) return null
  const review = JSON.parse(value) as PaymentReview
  if (typeof review.payment_method_id !== 'string' || ![review.subtotal, review.tax, review.tax_included, review.surcharge].every(Number.isSafeInteger) || review.total !== review.subtotal + review.tax + review.surcharge) throw new Error('Stored payment review is invalid')
  return review
}

function snapshotOf(payment: Payment) {
  const snapshot = JSON.parse(payment.price_snapshot_json) as { title?: unknown; quantity?: unknown; method_configuration_id?: unknown; stay?: unknown; price?: { unit_amount?: unknown; tax_behavior?: unknown }; product_id?: unknown; automatic_tax?: unknown; tax_code?: unknown }
  if (typeof snapshot.title !== 'string' || !Number.isSafeInteger(snapshot.quantity) || typeof snapshot.method_configuration_id !== 'string' || !Number.isSafeInteger(snapshot.price?.unit_amount)
    || typeof snapshot.automatic_tax !== 'boolean' || (snapshot.tax_code !== null && typeof snapshot.tax_code !== 'string')
    || !PRICE_TAX_BEHAVIORS.includes(snapshot.price!.tax_behavior as Price['tax_behavior'])) throw new Error('Payment purchase snapshot is invalid')
  if (payment.subject_type === 'stay' && !isStayPurchase(snapshot.stay)) throw new Error('Stay payment has no valid stay purchase')
  const stay = payment.subject_type === 'stay' && isStayPurchase(snapshot.stay)
    ? { check_in_date: snapshot.stay.check_in_date, check_out_date: snapshot.stay.check_out_date, nights: snapshot.stay.nightly.length, nightly: snapshot.stay.nightly.map(night => night.price_minor), adults: snapshot.stay.adults, children: snapshot.stay.children, infants: snapshot.stay.infants, cancellation_policy: snapshot.stay.cancellation_policy, product_id: snapshot.stay.product_id }
    : null
  return {
    title: snapshot.title, quantity: snapshot.quantity as number, unit_amount: snapshot.price!.unit_amount as number, product_id: typeof snapshot.product_id === 'string' ? snapshot.product_id : null, stay,
    automatic_tax: snapshot.automatic_tax, tax_code: snapshot.tax_code as string | null, tax_behavior: snapshot.price!.tax_behavior as Price['tax_behavior'],
  }
}

/**
 * What the buyer is confirming, as Airbnb's summary card shows it: the thing's
 * picture, the time it holds and what kind of booking it is. The time is the
 * checkout hold's — the one the purchase reserved.
 */
async function handoffSubject(db: DbClient, organizationId: string, payment: Payment, snapshot: ReturnType<typeof snapshotOf>) {
  const hold = payment.subject_type === 'booking' || payment.subject_type === 'reservation'
    ? await queryFirst<{ starts_at: string; ends_at: string; timezone: string; location_id: string | null }>(db, 'SELECT starts_at,ends_at,timezone,location_id FROM payment_checkout_holds WHERE payment_id=? AND organization_id=? ORDER BY created_at DESC LIMIT 1', [payment.id, organizationId])
    : null
  if ((payment.subject_type === 'booking' || payment.subject_type === 'reservation') && !hold) throw new Error('Payment has no checkout hold for its time')
  const productId = snapshot.stay?.product_id ?? snapshot.product_id
  // A payment outlives its product: a deleted product leaves its kind unknown, and the summary omits what depends on it.
  const product = productId ? await queryFirst<{ kind: string; slug: string }>(db, 'SELECT kind,slug FROM products WHERE id=? AND organization_id=?', [productId, organizationId]) : null
  const locationId = hold?.location_id ?? payment.location_id
  const location = locationId ? await queryFirst<{ slug: string }>(db, 'SELECT slug FROM business_locations WHERE id=? AND organization_id=?', [locationId, organizationId]) : null
  // Null once it has passed: paying now buys a booking that is already non-refundable. A stay's terms are its booked policy.
  const freeUntil = hold ? freeCancellationUntil(hold.starts_at) : null
  const [ownerType, ownerId] = productId ? ['product', productId] as const : ['business_location', hold?.location_id ?? payment.location_id] as const
  const picture = ownerId ? (await loadOwnerPictures(db, organizationId, ownerType, [ownerId])).get(ownerId) ?? null : null
  return {
    kind: product?.kind ?? (productId ? null : payment.subject_type), image_url: picture?.imageUrl ?? null, starts_at: hold?.starts_at ?? null, ends_at: hold?.ends_at ?? null, timezone: hold?.timezone ?? null,
    // Where the offering's page is, so the buyer can read its full terms or change what they picked.
    product_slug: product?.slug ?? null, location_slug: location?.slug ?? null,
    free_cancellation_until: freeUntil && new Date().toISOString() <= freeUntil ? freeUntil : null,
  }
}

/** What the pay page needs to mount Stripe's Payment Element on the connected account. */
export async function paymentHandoff(db: DbClient, stripe: Stripe, publishableKey: string, organizationId: string, paymentId: string, claim: string) {
  const { payment, intent, state } = await requireClaimedPayment(db, stripe, organizationId, paymentId, claim)
  const snapshot = snapshotOf(payment)
  if (!publishableKey) throw new HTTPError({ statusCode: 503, statusMessage: 'Stripe is not configured' })
  // The methods Stripe resolved for this intent from the business's configuration, with nothing that redirects; the Element offers exactly these.
  if (intent.metadata.krabiclaw_payment_id !== payment.id) throw new Error('Stripe PaymentIntent does not match the purchase')
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
    payment_id: payment.id, state, title: snapshot.title, quantity: snapshot.quantity, unit_amount: snapshot.unit_amount, stay: snapshot.stay,
    ...await handoffSubject(db, organizationId, payment, snapshot), subtotal: payment.amount, currency: payment.currency, expires_at: payment.checkout_expires_at,
    stripe_account_id: payment.stripe_account_id, publishable_key: publishableKey, payment_method_types: intent.payment_method_types,
    customer_session_client_secret: customerSession,
    bank_verification_url: state === 'verifying' ? bankVerificationUrl(intent) : null,
    surcharge_basis_points: await surchargeBasisPoints(db, organizationId, payment.stripe_account_id),
  }
}

/** The buyer goes back to change a stay only after Stripe cancels the purchase and its held nights are released. */
export async function cancelStayPayment(db: DbClient, stripe: Stripe, env: CloudflareEnv, organizationId: string, paymentId: string, claim: string): Promise<{ status: 'canceled' }> {
  const { payment, intent: current, state } = await requireClaimedPayment(db, stripe, organizationId, paymentId, claim)
  if (payment.subject_type !== 'stay') throw new HTTPError({ statusCode: 409, statusMessage: 'This payment does not hold a stay' })
  if (state === 'processing') throw new HTTPError({ statusCode: 409, statusMessage: 'This payment has started processing and cannot be changed here', data: { code: 'payment_in_progress' } })
  if (state === 'paid') throw new HTTPError({ statusCode: 409, statusMessage: 'This stay is already paid; open its booking to request a change', data: { code: 'payment_paid' } })
  if (current.livemode !== Boolean(payment.livemode) || current.currency.toUpperCase() !== payment.currency || current.metadata.krabiclaw_payment_id !== payment.id) throw new Error('Stripe PaymentIntent does not match the purchase')
  if (state !== 'open' && state !== 'verifying' && current.status !== 'canceled') throw new HTTPError({ statusCode: 409, statusMessage: state === 'expired' ? 'This payment has expired; start the booking again' : 'This payment was not accepted; start the booking again', data: { code: `payment_${state}` } })
  if (current.status !== 'canceled' && !['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(current.status)) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'This payment has started processing and cannot be changed here', data: { code: 'payment_in_progress' } })
  }
  const canceled = current.status === 'canceled' ? current : await stripe.paymentIntents.cancel(current.id, { cancellation_reason: 'requested_by_customer' }, { stripeAccount: payment.stripe_account_id, idempotencyKey: `krabiclaw-cancel:${payment.id}` })
  if (canceled.status !== 'canceled') throw new Error('Stripe did not cancel the purchase')
  await reconcilePaymentIntent(db, stripe, payment, canceled, env)
  const released = await queryFirst<{ status: string }>(db, 'SELECT status FROM payment_checkout_holds WHERE payment_id=? AND organization_id=?', [payment.id, organizationId])
  if (released?.status !== 'released') throw new Error('The canceled purchase still holds its stay')
  return { status: 'canceled' }
}

/**
 * The buyer's chosen method, priced before anything is confirmed. A business
 * that collects tax through Stripe Tax has it calculated by Stripe from the
 * method's billing address, or the buyer's IP address when the method carries
 * none, and the calculation is attached to the intent so Stripe records the tax
 * transaction when it succeeds and reverses it on refund. Stripe then says
 * whether the method may carry a surcharge on that taxed amount and how much at
 * most; the business's rate is applied inside that bound and an ineligible card
 * carries none. Stripe's answer missing is an error, never a free payment.
 */
export async function reviewPayment(db: DbClient, stripe: Stripe, organizationId: string, paymentId: string, claim: string, paymentMethodId: string, buyerIp: string | null) {
  const { payment, intent: current, state } = await requireClaimedPayment(db, stripe, organizationId, paymentId, claim)
  if (state !== 'open') throw new HTTPError({ statusCode: 409, statusMessage: state === 'paid' ? 'This payment is already complete' : state === 'processing' || state === 'verifying' ? 'This payment is already in progress' : state === 'expired' ? 'This payment has expired; start the booking again' : 'This payment was not accepted; start the booking again', data: { code: `payment_${state}` } })
  if (!/^pm_[A-Za-z0-9]+$/u.test(paymentMethodId)) throw new HTTPError({ statusCode: 400, statusMessage: 'Payment method required' })
  const snapshot = snapshotOf(payment)
  const rate = await surchargeBasisPoints(db, organizationId, payment.stripe_account_id)
  const method = await stripe.paymentMethods.retrieve(paymentMethodId, {}, { stripeAccount: payment.stripe_account_id })
  const tax = snapshot.automatic_tax ? await calculateTax(stripe, payment, snapshot, method, buyerIp) : null
  const amount = tax?.amount_total ?? payment.amount
  const intent = await stripe.paymentIntents.update(current.id, {
    payment_method: method.id,
    amount,
    ...(tax ? { hooks: { inputs: { tax: { calculation: tax.id } } } } : {}),
    ...(rate !== null ? { amount_details: { surcharge: { enforce_validation: 'enabled' } } } : {}),
  } as Stripe.PaymentIntentUpdateParams, { stripeAccount: payment.stripe_account_id }) as IntentWithSurcharge
  if (intent.metadata.krabiclaw_payment_id !== payment.id || intent.livemode !== Boolean(payment.livemode) || intent.amount !== amount || intent.currency.toUpperCase() !== payment.currency) throw new Error('Stripe PaymentIntent does not match the purchase')
  let surcharge = 0
  if (rate !== null) {
    const native = intent.amount_details?.surcharge
    if (native?.status !== 'available' && native?.status !== 'unavailable') throw new Error('Stripe did not report surcharge availability for this payment method')
    if (native.status === 'available') {
      if (!Number.isSafeInteger(native.maximum_amount)) throw new Error('Stripe did not report the maximum surcharge')
      surcharge = Math.min(Math.floor(amount * rate / 10_000), native.maximum_amount as number)
    }
  }
  const review: PaymentReview = { payment_method_id: method.id, subtotal: payment.amount, tax: tax?.tax_amount_exclusive ?? 0, tax_included: tax?.tax_amount_inclusive ?? 0, surcharge, total: amount + surcharge, reviewed_at: new Date().toISOString() }
  if (review.total !== review.subtotal + review.tax + review.surcharge) throw new Error('Stripe Tax returned a total that does not add up')
  await execute(db, 'UPDATE payments SET review_json=?,updated_at=? WHERE id=?', [JSON.stringify(review), review.reviewed_at, payment.id])
  return { ...review, currency: payment.currency, method: { type: method.type, brand: method.card?.brand ?? null, last4: method.card?.last4 ?? method.us_bank_account?.last4 ?? null, funding: method.card?.funding ?? null, wallet: method.card?.wallet?.type ?? null, bank_name: method.us_bank_account?.bank_name ?? null } }
}

/** Stripe Tax's calculation for the purchase, located where Stripe says it can locate the buyer. */
async function calculateTax(stripe: Stripe, payment: Payment, snapshot: ReturnType<typeof snapshotOf>, method: Stripe.PaymentMethod, buyerIp: string | null) {
  const address = method.billing_details.address
  const located = address?.country
    ? { address: { country: address.country, line1: address.line1, line2: address.line2, city: address.city, state: address.state, postal_code: address.postal_code }, address_source: 'billing' as const }
    : buyerIp ? { ip_address: buyerIp } : null
  if (!located) throw new HTTPError({ statusCode: 409, statusMessage: 'Enter your billing address so tax can be calculated', data: { code: 'customer_tax_location_invalid' } })
  try {
    return await stripe.tax.calculations.create({
      currency: payment.currency.toLowerCase(),
      // An unspecified price takes the account's default tax behavior in Stripe Tax settings.
      line_items: [{ amount: payment.amount, reference: payment.id, ...(snapshot.tax_behavior !== 'unspecified' ? { tax_behavior: snapshot.tax_behavior } : {}), ...(snapshot.tax_code ? { tax_code: snapshot.tax_code } : {}) }],
      customer_details: located,
    }, { stripeAccount: payment.stripe_account_id })
  } catch (error) {
    if (error instanceof stripe.errors.StripeInvalidRequestError && error.code === 'customer_tax_location_invalid') throw new HTTPError({ statusCode: 409, statusMessage: error.message, data: { code: error.code }, cause: error })
    throw error
  }
}

/**
 * Confirms exactly what was reviewed: the same method on the intent, the same
 * total. A card or Link is authorized, booked, then captured here or, after 3DS,
 * from the webhook or the return; a bank debit clears later and books then.
 * Every path settles idempotently from Stripe's own status.
 */
export async function confirmPayment(db: DbClient, stripe: Stripe, env: CloudflareEnv, organizationId: string, paymentId: string, claim: string, input: { payment_method_id: string; total: number }, siteOrigin: string) {
  const { payment, intent: current, state } = await requireClaimedPayment(db, stripe, organizationId, paymentId, claim)
  if (state !== 'open') throw new HTTPError({ statusCode: 409, statusMessage: state === 'paid' ? 'This payment is already complete' : state === 'processing' || state === 'verifying' ? 'This payment is already in progress' : 'This payment can no longer be confirmed; start the booking again', data: { code: `payment_${state}` } })
  const review = parseReview(payment.review_json)
  if (!review || review.payment_method_id !== input.payment_method_id || review.total !== input.total) throw new HTTPError({ statusCode: 409, statusMessage: 'Review the payment again before confirming', data: { code: 'review_required' } })
  const attached = typeof current.payment_method === 'string' ? current.payment_method : current.payment_method?.id
  if (current.status !== 'requires_confirmation' || attached !== review.payment_method_id || current.amount !== review.subtotal + review.tax) throw new HTTPError({ statusCode: 409, statusMessage: 'The payment changed since it was reviewed; review it again', data: { code: 'review_required' } })
  // The capacity is kept before Stripe can take the money, against the hold itself: a hold that has gone stops the payment here.
  const started = new Date().toISOString()
  const held = await execute(db, "UPDATE payment_checkout_holds SET expires_at=MAX(expires_at,?) WHERE payment_id=? AND status='active' AND expires_at>?", [confirmationHoldUntil(payment), payment.id, started])
  if (held.meta.changes !== 1) throw new HTTPError({ statusCode: 409, statusMessage: 'This payment can no longer be confirmed; start the booking again', data: { code: 'payment_expired' } })
  const confirmed = await stripe.paymentIntents.confirm(current.id, {
    // A method that leaves the site comes back to this pay page, which completes the return there.
    return_url: new URL(`/pay/${encodeURIComponent(payment.id)}?claim=${encodeURIComponent(claim)}`, siteOrigin).toString(),
    // The surcharged total is what Stripe charges; the surcharge inside it is named so receipts and refunds carry it.
    ...(review.surcharge > 0 ? { amount_to_confirm: review.total, amount_details: { surcharge: { amount: review.surcharge, enforce_validation: 'enabled' } } } : {}),
  } as Stripe.PaymentIntentConfirmParams, { stripeAccount: payment.stripe_account_id, idempotencyKey: `krabiclaw-confirm:${payment.id}:${review.reviewed_at}` })
  const settled = await reconcilePaymentIntent(db, stripe, payment, confirmed, env)
  // Automatic confirmation lets whoever holds this secret confirm the intent, so only a payment that needs the browser gets it. Bank verification happens on Stripe's own page.
  const verifying = settled.next_action?.type === 'verify_with_microdeposits'
  const authenticating = settled.status === 'requires_action' && !verifying
  return { status: settled.status, client_secret: authenticating ? settled.client_secret : null, requires_action: authenticating, bank_verification_url: verifying ? bankVerificationUrl(settled) : null }
}

/**
 * Where the buyer's receipt is once the payment is back: the business's own
 * confirmation of the visit or stay it paid for, read with the same proof an
 * unpaid booking's confirmation carries.
 */
export type PaymentReturn =
  | { state: 'paid'; kind: 'booking' | 'reservation'; request_id: string; cancellation_token: string }
  | { state: 'paid'; kind: 'stay'; activity_id: string; receipt_token: string }
  /** Stripe is still clearing the payment; nothing is booked until it captures. */
  | { state: 'processing' }
  /** A bank debit cleared after what it paid for was taken; the payment is refunded in full, or Stripe is still settling that refund. */
  | { state: 'refunded' }
  /** What it was for has gone, so the authorization was cancelled and nothing was charged. */
  | { state: 'expired' }

async function paymentReceipt(db: DbClient, env: CloudflareEnv, payment: Payment): Promise<PaymentReturn> {
  const hold = await queryFirst<{ status: string; request_id: string | null; converted_stay_id: string | null }>(db, 'SELECT status,request_id,converted_stay_id FROM payment_checkout_holds WHERE payment_id=? AND organization_id=?', [payment.id, payment.organization_id])
  if (!hold) throw new Error('Captured payment has no checkout hold')
  if (hold.status !== 'converted') {
    if (payment.refunded_amount > 0) return { state: 'refunded' }
    // A bank debit that cleared after its capacity went is refunded in full; Stripe may still be settling that refund.
    const refund = await queryFirst<{ status: string; error: string | null }>(db, 'SELECT status, error FROM payment_refunds WHERE payment_id=? ORDER BY created_at DESC LIMIT 1', [payment.id])
    if (refund && ['creating', 'pending', 'requires_action', 'succeeded'].includes(refund.status)) return { state: 'refunded' }
    if (refund) throw new Error(`Captured payment has no booking and its refund ${refund.status}${refund.error ? `: ${refund.error}` : ''}`)
    throw new Error('Captured payment has no booking it paid for')
  }
  if (payment.subject_type === 'stay') {
    // The stay is read by its activity ID, as the guest's account reads it.
    const stay = await queryFirst<{ id: string }>(db, 'SELECT COALESCE(request_id,id) AS id FROM stays WHERE id=? AND organization_id=?', [hold.converted_stay_id, payment.organization_id])
    if (!stay) throw new Error('Converted stay hold has no stay')
    return { state: 'paid', kind: 'stay', activity_id: stay.id, receipt_token: (await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET ?? '', stay.id)).token }
  }
  if (payment.subject_type !== 'booking' && payment.subject_type !== 'reservation') throw new Error(`Payment subject ${payment.subject_type} has no guest confirmation`)
  if (!hold.request_id) throw new Error('Captured visit payment has no guest request')
  const request = await getGuestRequest(db, hold.request_id, payment.organization_id, payment.subject_type)
  const cancellation = await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET ?? '', hold.request_id)
  if (!request || request.kind !== payment.subject_type || await hashReservationCancelToken(cancellation.token) !== request.payload.cancellation.token_hash) throw new Error('Paid booking is missing its receipt capability')
  return { state: 'paid', kind: payment.subject_type, request_id: hold.request_id, cancellation_token: cancellation.token }
}

/**
 * The buyer is back from paying, on the business's site. Stripe is asked
 * whether the intent succeeded before the purchase is attached to the site's
 * buyer and its receipt is named; a payment still clearing claims nothing.
 */
export async function completePaymentReturn(db: DbClient, stripe: Stripe, env: CloudflareEnv, organizationId: string, paymentId: string, claim: string, buyer: () => Promise<string>): Promise<PaymentReturn> {
  const { payment, intent } = await requireClaimedPayment(db, stripe, organizationId, paymentId, claim)
  if (intent.livemode !== Boolean(payment.livemode) || intent.metadata.krabiclaw_payment_id !== payment.id || (intent.status !== 'succeeded' && intent.status !== 'processing' && intent.status !== 'requires_capture')) throw new HTTPError({ statusCode: 409, statusMessage: 'Stripe has not authenticated this purchase' })
  const settled = await reconcilePaymentIntent(db, stripe, payment, intent, env)
  if (settled.status === 'processing') return { state: 'processing' }
  if (settled.status !== 'succeeded') return { state: 'expired' }
  await claimCheckoutReturn(db, await buyer(), claim)
  const owned = await requirePayment(db, organizationId, payment.id)
  const charge = typeof intent.latest_charge === 'string' ? null : intent.latest_charge
  // The capture alert names the buyer who has now proved the purchase; the event key makes it the same alert.
  await notifyPaymentFinancialEvent(db, stripe, env, owned, { kind: 'payment_captured', nativeId: settled.id, status: settled.status, amount: settled.amount_received, email: charge?.billing_details.email ?? null })
  return paymentReceipt(db, env, owned)
}
