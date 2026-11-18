import { publishEvent } from '~/server/events'
import { freeCancellationUntil } from '~/shared/availability-settings'
import type Stripe from 'stripe'
import { HTTPError } from 'nitro'
import { execute, executeBatch, queryFirst, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { createStripeClient } from '~/server/utils/stripe-client'
import { paymentsStripe, paymentsStripeKeys, validatedSurchargeBasisPoints } from '~/server/utils/stripe-connect'
import { claimCheckoutReturn, tokenHash } from './buyer'
import { approvedStayBooking, type Payment } from './index'
import { isStayPurchase, type PaymentReview } from './checkout'
import { PRICE_TAX_BEHAVIORS, type Price } from '~/shared/prices'
import { checkoutHoldSql, reconcilePaymentIntent, confirmationHoldUntil, releaseApprovedStayConfirmation, type CheckoutHold } from './events'
import { assertBookingBatchWrite, bookingBatchWriteRefused } from '~/server/utils/availability'
import { approvedStayPaymentPredicate } from '~/server/domain/stays'
import { accountActivityPath } from '~/shared/account-activity'
import { isRecord } from '~/server/utils/type-guards'
import { ownerPicture, type PicturePlacement } from '~/server/notifications/hero'
import { mediaPlacementsQuery } from '~/server/utils/media-asset-manager'
import { getGuestRequest, type GuestThreadPayload } from '~/server/domain/requests'
import { createReplayableReservationCancelToken, hashReservationCancelToken } from '~/server/utils/reservation-cancel-token'

/**
 * The payment the buyer confirms on the site: Stripe's Payment Element collects
 * the method, the server attaches it to the PaymentIntent and reads what Stripe
 * says about a surcharge for that card, the buyer sees the final amount, and
 * only then is the intent confirmed. Each step is bound to the purchase claim
 * the checkout handed the browser, so another buyer cannot pay or review it.
 */
type IntentWithSurcharge = Stripe.PaymentIntent & { amount_details?: { surcharge?: { status?: string; maximum_amount?: number; amount?: number } } }
export type PaymentHandoffState = 'open' | 'processing' | 'verifying' | 'paid' | 'failed' | 'expired' | 'taken'

type CheckoutPayment = Payment & {
  confirmation_in_flight: number; stripe_payment_intent_id: string; checkout_expires_at: string; return_expires_at: string
  surcharge_basis_points: number | null; checkout_hold: string | null; stripe_customer_id: string | null
  hold_starts_at: string | null; hold_ends_at: string | null; hold_timezone: string | null
  hold_quantity: number | null; hold_conversation_id: string | null
  product_kind: string | null; product_slug: string | null; location_slug: string | null; advance_notice_minutes: number | null
  picture_placements: string | null
}
type CheckoutRead = 'claim' | 'handoff' | 'review' | 'settlement'

const handoffProductId = `NULLIF(CASE WHEN json_type(p.price_snapshot_json,'$.stay') IS NOT NULL
  THEN json_extract(p.price_snapshot_json,'$.stay.product_id')
  WHEN json_type(p.price_snapshot_json,'$.product_id')='text' THEN json_extract(p.price_snapshot_json,'$.product_id') END, '')`
const handoffLocationId = "NULLIF(COALESCE(h.location_id,p.location_id),'')"
const handoffOwnerId = `COALESCE(${handoffProductId},${handoffLocationId})`
const handoffPicturePlacements = mediaPlacementsQuery({
  organizationId: { sql: 'p.organization_id' },
  ownerType: { sql: `(CASE WHEN ${handoffProductId} IS NULL THEN 'business_location' ELSE 'product' END)` },
  owners: { sql: `SELECT ${handoffOwnerId}` },
  includeOrganizationFallback: true,
})

async function readCheckoutPayment(db: DbClient, organizationId: string, paymentId: string, claim: string, now: string, read: CheckoutRead): Promise<CheckoutPayment> {
  // A malformed claim is a 400 only for a checkout that exists on this site.
  const hash = /^[a-f0-9-]{72}$/u.test(claim) ? await tokenHash(claim) : null
  const handoff = read === 'handoff'
  const pricing = handoff || read === 'review'
  const payment = await queryFirst<CheckoutPayment>(db, `SELECT p.*,
    CASE WHEN h.status='active' AND h.expires_at>? AND json_type(p.review_json,'$.confirmation_started_at')='text' THEN 1 ELSE 0 END AS confirmation_in_flight
    ${pricing ? ', a.surcharge_basis_points' : ''}
    ${read === 'settlement' ? `, (${checkoutHoldSql}) AS checkout_hold` : ''}
    ${handoff ? `, customer.stripe_customer_id, h.starts_at AS hold_starts_at, h.ends_at AS hold_ends_at, h.timezone AS hold_timezone,
      h.quantity AS hold_quantity, h.conversation_id AS hold_conversation_id,
      product.kind AS product_kind, product.slug AS product_slug, location.slug AS location_slug, config.advance_notice_minutes,
      CASE WHEN ${handoffOwnerId} IS NOT NULL THEN (
        SELECT json_group_array(json_object('owner_type',owner_type,'slot',slot,'kind',kind,
          'public_url',public_url,'thumbnail_url',thumbnail_url,'alt_text',alt_text))
        FROM (${handoffPicturePlacements.query})
      ) END AS picture_placements` : ''}
    FROM payments p
    LEFT JOIN payment_checkout_holds h ON h.payment_id=p.id AND h.organization_id=p.organization_id
    ${pricing ? 'LEFT JOIN stripe_connected_accounts a ON a.organization_id=p.organization_id AND a.stripe_account_id=p.stripe_account_id AND a.livemode=p.livemode' : ''}
    ${handoff ? `LEFT JOIN stripe_connected_customers customer ON customer.user_id=p.buyer_user_id AND customer.stripe_account_id=p.stripe_account_id AND customer.livemode=p.livemode
      LEFT JOIN products product ON product.organization_id=p.organization_id
        AND product.id=${handoffProductId}
      LEFT JOIN product_booking_configs config ON config.organization_id=p.organization_id AND config.product_id=product.id
      LEFT JOIN business_locations location ON location.organization_id=p.organization_id
        AND location.id=${handoffLocationId}` : ''}
    WHERE p.id=? AND p.organization_id=? AND (? IS NULL OR p.return_token_hash=?)`, [now, ...(handoff ? handoffPicturePlacements.params ?? [] : []), paymentId, organizationId, hash, hash])
  if (!payment) throw new HTTPError({ statusCode: 404, statusMessage: 'Payment not found' })
  if (hash === null) throw new HTTPError({ statusCode: 400, statusMessage: 'Purchase claim required' })
  if (!payment.stripe_payment_intent_id || !payment.checkout_expires_at || !payment.return_expires_at) throw new HTTPError({ statusCode: 404, statusMessage: 'Payment not found' })
  if (payment.subject_type === 'booking' && payment.captured_amount > 0 && !payment.subject_id) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'Payment was received, but the booking could not be confirmed', data: { code: 'payment_booking_unconfirmed' } })
  }
  return payment
}

async function readCheckoutIntent(stripe: Stripe, payment: CheckoutPayment, now: string) {
  const intent = await stripe.paymentIntents.retrieve(payment.stripe_payment_intent_id, { expand: ['latest_charge'] }, { stripeAccount: payment.stripe_account_id })
  const confirming = payment.confirmation_in_flight === 1 && (intent.status === 'requires_confirmation' || intent.status === 'requires_payment_method')
  const state: PaymentHandoffState = payment.captured_amount > 0 ? 'paid'
    : intent.status === 'canceled' ? (intent.cancellation_reason === 'abandoned' && !payment.subject_id && payment.checkout_expires_at > now ? 'taken' : 'failed')
    : ['succeeded', 'requires_capture', 'processing'].includes(intent.status) || confirming ? 'processing'
    : intent.next_action?.type === 'verify_with_microdeposits' ? 'verifying'
    : payment.checkout_expires_at <= now || payment.return_expires_at <= now ? 'expired' : 'open'
  return { intent, state, confirming }
}

/** The purchase its return token authorizes, with what Stripe says of its intent now. */
export async function requireClaimedPayment(db: DbClient, env: CloudflareEnv, organizationId: string, paymentId: string, claim: string, read: Exclude<CheckoutRead, 'handoff'> = 'claim') {
  const now = new Date().toISOString()
  const payment = await readCheckoutPayment(db, organizationId, paymentId, claim, now, read)
  const stripe = paymentsStripe(env, Boolean(payment.livemode))
  return { payment, stripe, ...await readCheckoutIntent(stripe, payment, now) }
}

/** Stripe's own page for confirming the microdeposits. */
function bankVerificationUrl(intent: Stripe.PaymentIntent): string {
  const url = intent.next_action?.verify_with_microdeposits?.hosted_verification_url
  if (!url) throw new Error('Stripe asked for bank verification without its verification page')
  return url
}

type StoredPaymentReview = PaymentReview & { confirmation_started_at?: string; tax_calculation_id?: string }

function parseReview(value: string | null): StoredPaymentReview | null {
  if (!value) return null
  const review = JSON.parse(value) as StoredPaymentReview
  if (typeof review.payment_method_id !== 'string' || ![review.subtotal, review.tax, review.tax_included, review.surcharge].every(Number.isSafeInteger) || review.total !== review.subtotal + review.tax + review.surcharge) throw new Error('Stored payment review is invalid')
  return review
}

/** Read the frozen purchase terms shared by the buyer handoff and tax review. */
function snapshotOf(payment: Payment) {
  const snapshot = JSON.parse(payment.price_snapshot_json) as Record<string, unknown> & { title?: unknown; quantity?: unknown; method_configuration_id?: unknown; stay?: unknown; price?: { unit_amount?: unknown; tax_behavior?: unknown }; product_id?: unknown; automatic_tax?: unknown; tax_code?: unknown }
  if (typeof snapshot.title !== 'string' || !Number.isSafeInteger(snapshot.quantity) || typeof snapshot.method_configuration_id !== 'string' || !Number.isSafeInteger(snapshot.price?.unit_amount)
    || typeof snapshot.automatic_tax !== 'boolean' || (snapshot.tax_code !== null && typeof snapshot.tax_code !== 'string')
    || !PRICE_TAX_BEHAVIORS.includes(snapshot.price!.tax_behavior as Price['tax_behavior'])) throw new Error('Payment purchase snapshot is invalid')
  // A booking's purchase of nights carries its stay; one of a session's seats names its session.
  const stay = isStayPurchase(snapshot.stay) ? snapshot.stay : null
  if (snapshot.stay !== undefined && !stay) throw new Error('Stay payment has no valid stay purchase')
  return {
    title: snapshot.title, quantity: snapshot.quantity as number, unit_amount: snapshot.price!.unit_amount as number, product_id: typeof snapshot.product_id === 'string' ? snapshot.product_id : null,
    stay: stay ? { check_in_date: stay.check_in_date, check_out_date: stay.check_out_date, nights: stay.nightly.length, nightly: stay.nightly.map(night => night.price_minor), adults: stay.adults, children: stay.children, infants: stay.infants, cancellation_policy: stay.cancellation_policy, product_id: stay.product_id } : null,
    stayGuest: stay?.guest ?? null, approval: approvedStayBooking(snapshot),
    automatic_tax: snapshot.automatic_tax, tax_code: snapshot.tax_code as string | null, tax_behavior: snapshot.price!.tax_behavior as Price['tax_behavior'],
  }
}

/**
 * What the buyer is confirming, as Airbnb's summary card shows it: the thing's
 * picture, the selected time and the kind of booking.
 */
async function handoffSubject(db: DbClient, organizationId: string, payment: CheckoutPayment, snapshot: ReturnType<typeof snapshotOf>, state: PaymentHandoffState) {
  // A session's time is saved on its checkout record.
  const slot = payment.subject_type === 'booking' && snapshot.stay === null
  const heldSlot = slot || snapshot.approval
  if (heldSlot && !payment.hold_conversation_id) throw new Error('Payment has no checkout conversation')
  let guest: GuestThreadPayload['guest'] | null = state === 'open' ? snapshot.stayGuest : null
  if (state === 'open' && slot && payment.hold_conversation_id) {
    const request = await getGuestRequest(db, payment.hold_conversation_id, organizationId, 'booking')
    const contact = request?.kind === 'booking' ? request.payload.guest : null
    if (!contact?.name || !contact.email) throw new Error('Open checkout has no guest contact in its booking conversation')
    guest = { name: contact.name, email: contact.email, phone: contact.phone }
  }
  const productId = snapshot.stay?.product_id ?? snapshot.product_id
  // A payment outlives its product: a deleted product leaves its kind unknown, and the summary omits what depends on it.
  // Null once it has passed: paying now buys a booking that is already non-refundable. A stay's terms are its booked policy.
  const freeUntil = heldSlot && payment.hold_starts_at ? freeCancellationUntil(payment.hold_starts_at, payment.advance_notice_minutes) : null
  const ownerType = productId ? 'product' : 'business_location'
  const placements = payment.picture_placements
    ? JSON.parse(payment.picture_placements) as (PicturePlacement & { owner_type: string })[]
    : []
  const picture = ownerPicture(ownerType, placements.filter(row => row.owner_type === ownerType), placements.filter(row => row.owner_type === 'organization'))
  return {
    approved_stay_path: snapshot.approval && payment.hold_conversation_id ? accountActivityPath('stay', payment.hold_conversation_id) : null,
    kind: payment.product_kind ?? (productId ? null : payment.subject_type), image_url: picture?.imageUrl ?? null,
    starts_at: heldSlot ? payment.hold_starts_at : null, ends_at: heldSlot ? payment.hold_ends_at : null, timezone: heldSlot ? payment.hold_timezone : null,
    // The party the booking is for: a table's deposit is one per booking, whatever the party.
    party_size: heldSlot ? payment.hold_quantity : null,
    billing_details: guest ? { name: guest.name, email: guest.email, ...(guest.phone ? { phone: guest.phone } : {}) } : null,
    // Where the offering's page is, so the buyer can read its full terms or change what they picked.
    product_slug: payment.product_slug, location_slug: payment.location_slug,
    free_cancellation_until: freeUntil && new Date().toISOString() <= freeUntil ? freeUntil : null,
  }
}

/** What the pay page needs to mount Stripe's Payment Element on the connected account. */
export async function paymentHandoff(db: DbClient, env: CloudflareEnv, organizationId: string, paymentId: string, claim: string) {
  const now = new Date().toISOString()
  const payment = await readCheckoutPayment(db, organizationId, paymentId, claim, now, 'handoff')
  const keys = paymentsStripeKeys(env, Boolean(payment.livemode))
  if (!keys?.publishableKey) throw new HTTPError({ statusCode: 503, statusMessage: 'Stripe is not configured' })
  const stripe = createStripeClient(keys.secretKey, 'payments')
  const { intent, state } = await readCheckoutIntent(stripe, payment, now)
  const snapshot = snapshotOf(payment)
  // The methods Stripe resolved for this intent from the business's configuration, with nothing that redirects; the Element offers exactly these.
  if (intent.metadata.krabiclaw_payment_id !== payment.id) throw new Error('Stripe PaymentIntent does not match the purchase')
  // Stripe's own saved-card features for a signed-in buyer, scoped to this business's customer.
  let customerSession: string | null = null
  const customerId = typeof intent.customer === 'string' ? intent.customer : intent.customer?.id
  if (state === 'open' && customerId && payment.stripe_customer_id === customerId) {
    const session = await stripe.customerSessions.create({ customer: customerId, components: { payment_element: { enabled: true, features: { payment_method_save: 'enabled', payment_method_save_usage: 'off_session', payment_method_redisplay: 'enabled', payment_method_redisplay_limit: 10, payment_method_remove: 'enabled' } } } }, { stripeAccount: payment.stripe_account_id })
    customerSession = session.client_secret
  }
  return {
    payment_id: payment.id, state, title: snapshot.title, quantity: snapshot.quantity, unit_amount: snapshot.unit_amount, stay: snapshot.stay,
    ...await handoffSubject(db, organizationId, payment, snapshot, state), subtotal: payment.amount, currency: payment.currency, expires_at: payment.checkout_expires_at,
    stripe_account_id: payment.stripe_account_id, publishable_key: keys.publishableKey, payment_method_types: intent.payment_method_types,
    customer_session_client_secret: customerSession,
    bank_verification_url: state === 'verifying' ? bankVerificationUrl(intent) : null,
    surcharge_basis_points: validatedSurchargeBasisPoints(payment.surcharge_basis_points),
  }
}

/** The buyer goes back to change a stay only after Stripe cancels the purchase. */
export async function cancelStayPayment(db: DbClient, env: CloudflareEnv, organizationId: string, paymentId: string, claim: string): Promise<{ status: 'canceled' }> {
  const { payment, stripe, intent: current, state } = await requireClaimedPayment(db, env, organizationId, paymentId, claim)
  const snapshot = snapshotOf(payment)
  if (snapshot.stay === null) throw new HTTPError({ statusCode: 409, statusMessage: 'This payment is not for a stay' })
  if (snapshot.approval) throw new HTTPError({ statusCode: 409, statusMessage: 'Manage changes from your approved stay' })
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
export async function reviewPayment(db: DbClient, env: CloudflareEnv, organizationId: string, paymentId: string, claim: string, paymentMethodId: string, buyerIp: string | null) {
  const { payment, stripe, intent: current, state, confirming } = await requireClaimedPayment(db, env, organizationId, paymentId, claim, 'review')
  if (confirming) throw new HTTPError({ statusCode: 409, statusMessage: 'This payment is already in progress', data: { code: 'payment_in_progress' } })
  if (state !== 'open') throw new HTTPError({ statusCode: 409, statusMessage: state === 'paid' ? 'This payment is already complete' : state === 'processing' || state === 'verifying' ? 'This payment is already in progress' : state === 'expired' ? 'This payment has expired; start the booking again' : 'This payment was not accepted; start the booking again', data: { code: `payment_${state}` } })
  if (!/^pm_[A-Za-z0-9]+$/u.test(paymentMethodId)) throw new HTTPError({ statusCode: 400, statusMessage: 'Payment method required' })
  const snapshot = snapshotOf(payment)
  const rate = validatedSurchargeBasisPoints(payment.surcharge_basis_points)
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
  if (snapshot.approval && tax && !tax.id) throw new Error('Stripe Tax returned a calculation without an ID')
  const stored: StoredPaymentReview = { ...review, ...(snapshot.approval && tax?.id ? { tax_calculation_id: tax.id } : {}) }
  const saved = await execute(db, `UPDATE payments SET review_json=?,updated_at=? WHERE id=?${snapshot.approval ? `
    AND NOT EXISTS (SELECT 1 FROM payment_checkout_holds h WHERE h.payment_id=payments.id AND h.status='active'
      AND h.expires_at>? AND json_type(payments.review_json,'$.confirmation_started_at')='text')` : ''}`,
    [JSON.stringify(stored), review.reviewed_at, payment.id, ...(snapshot.approval ? [review.reviewed_at] : [])])
  if (saved.meta.changes !== 1) throw new HTTPError({ statusCode: 409, statusMessage: 'This payment is already in progress', data: { code: 'payment_in_progress' } })
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
 * total. A card or Link is captured before booking here or, after 3DS,
 * from the webhook or the return; a bank debit clears later and books then.
 * Every path settles idempotently from Stripe's own status.
 */
export async function confirmPayment(db: DbClient, env: CloudflareEnv, organizationId: string, paymentId: string, claim: string, input: { payment_method_id: string; total: number }, siteOrigin: string) {
  const { payment, stripe, intent: current, state, confirming } = await requireClaimedPayment(db, env, organizationId, paymentId, claim, 'settlement')
  const hold = payment.checkout_hold ? JSON.parse(payment.checkout_hold) as CheckoutHold : null
  if (confirming) throw new HTTPError({ statusCode: 409, statusMessage: 'This payment is already in progress', data: { code: 'payment_in_progress' } })
  if (state !== 'open') throw new HTTPError({ statusCode: 409, statusMessage: state === 'paid' ? 'This payment is already complete' : state === 'processing' || state === 'verifying' ? 'This payment is already in progress' : 'This payment can no longer be confirmed; start the booking again', data: { code: `payment_${state}` } })
  const review = parseReview(payment.review_json)
  if (!review || review.payment_method_id !== input.payment_method_id || review.total !== input.total) throw new HTTPError({ statusCode: 409, statusMessage: 'Review the payment again before confirming', data: { code: 'review_required' } })
  const { approval, stay, automatic_tax } = snapshotOf(payment)
  if (approval && review.confirmation_started_at) throw new HTTPError({ statusCode: 409, statusMessage: 'This payment is already in progress', data: { code: 'payment_in_progress' } })
  if (approval && automatic_tax && !review.tax_calculation_id) throw new HTTPError({ statusCode: 409, statusMessage: 'Review the payment again before confirming', data: { code: 'review_required' } })
  const attached = typeof current.payment_method === 'string' ? current.payment_method : current.payment_method?.id
  if (current.status !== 'requires_confirmation' || attached !== review.payment_method_id || current.amount !== review.subtotal + review.tax) throw new HTTPError({ statusCode: 409, statusMessage: 'The payment changed since it was reviewed; review it again', data: { code: 'review_required' } })
  let confirmingPayment = payment
  if (approval) {
    const started = new Date().toISOString()
    const expiresAt = confirmationHoldUntil(started)
    if (!stay || !hold?.conversation_id || !hold.buyer_user_id) throw new Error('Approved stay payment has no stay or guest conversation')
    const bookable = approvedStayPaymentPredicate({
      ...approval, organizationId, productId: stay.product_id, checkIn: stay.check_in_date, checkOut: stay.check_out_date,
      conversationId: hold.conversation_id, buyerUserId: hold.buyer_user_id, through: started,
    })
    try {
      const [written] = await executeBatch(db, [
        { query: `UPDATE payments SET review_json=json_set(review_json,'$.confirmation_started_at',?) WHERE id=? AND organization_id=?
          AND captured_amount=0 AND review_json=? AND ${bookable.query}
          AND EXISTS (SELECT 1 FROM payment_checkout_holds h WHERE h.payment_id=payments.id AND h.status='active')
          RETURNING review_json`,
        params: [started, payment.id, organizationId, payment.review_json, ...bookable.params] },
        assertBookingBatchWrite({ query: 'changes() = 1', params: [] }),
        { query: "UPDATE payment_checkout_holds SET expires_at=? WHERE payment_id=? AND status='active'", params: [expiresAt, payment.id] },
      ], { operation: 'Begin payment for approved stay' })
      const updated = written?.results[0]
      if (!isRecord(updated) || typeof updated.review_json !== 'string') throw new Error('Approved stay confirmation has no saved payment review')
      confirmingPayment = { ...payment, review_json: updated.review_json }
    } catch (error) {
      if (bookingBatchWriteRefused(error)) throw new HTTPError({ statusCode: 409, statusMessage: 'This payment can no longer be confirmed; start the booking again', data: { code: 'payment_expired' } })
      throw error
    }
    await publishEvent(env, { type: 'business.wake', kind: 'checkout', organization_id: organizationId, due_at: Date.parse(expiresAt) })
  }
  let confirmed: Stripe.PaymentIntent
  try {
    confirmed = await stripe.paymentIntents.confirm(current.id, {
      expand: ['latest_charge', 'payment_method'],
      // A method that leaves the site comes back to this pay page, which completes the return there.
      return_url: new URL(`/pay/${encodeURIComponent(payment.id)}?claim=${encodeURIComponent(claim)}`, siteOrigin).toString(),
      // A concurrent review can change the attached method before Stripe receives this confirmation.
      ...(approval ? { payment_method: review.payment_method_id } : {}),
      ...(approval && review.tax_calculation_id ? { hooks: { inputs: { tax: { calculation: review.tax_calculation_id } } } } : {}),
      ...(approval || review.surcharge > 0 ? { amount_to_confirm: review.total } : {}),
      // The surcharged total is what Stripe charges; the surcharge inside it is named so receipts and refunds carry it.
      ...(review.surcharge > 0 ? { amount_details: { surcharge: { amount: review.surcharge, enforce_validation: 'enabled' } } } : {}),
    } as Stripe.PaymentIntentConfirmParams, { stripeAccount: payment.stripe_account_id, idempotencyKey: `krabiclaw-confirm:${payment.id}:${review.reviewed_at}` })
  } catch (error) {
    if (approval && error instanceof stripe.errors.StripeCardError && error.payment_intent) {
      await reconcilePaymentIntent(db, stripe, confirmingPayment, error.payment_intent, env, hold)
    } else if (approval && (error instanceof stripe.errors.StripeAuthenticationError || error instanceof stripe.errors.StripePermissionError ||
      (error instanceof stripe.errors.StripeInvalidRequestError && error.statusCode === 400 && error.code !== 'payment_intent_unexpected_state'
        && (error.param || error.code?.startsWith('parameter_')))) && error.headers?.['stripe-should-retry'] !== 'true') {
      await releaseApprovedStayConfirmation(db, env, confirmingPayment)
    }
    throw error
  }
  const settled = await reconcilePaymentIntent(db, stripe, confirmingPayment, confirmed, env, hold)
  // Automatic confirmation lets whoever holds this secret confirm the intent, so only a payment that needs the browser gets it. Bank verification happens on Stripe's own page.
  const verifying = settled.next_action?.type === 'verify_with_microdeposits'
  const authenticating = settled.status === 'requires_action' && !verifying
  return { status: settled.status, taken: settled.status === 'canceled' && settled.cancellation_reason === 'abandoned' && !payment.subject_id && Date.parse(payment.checkout_expires_at) > Date.now(), client_secret: authenticating ? settled.client_secret : null, requires_action: authenticating, bank_verification_url: verifying ? bankVerificationUrl(settled) : null }
}

/**
 * Where the buyer's receipt is once the payment is back: the business's own
 * confirmation of the visit or stay it paid for, read with the same proof an
 * unpaid booking's confirmation carries.
 */
export type PaymentReturn =
  | { state: 'paid'; kind: 'booking'; conversation_id: string; cancellation_token: string }
  | { state: 'paid'; kind: 'stay'; activity_id: string; receipt_token: string }
  | { state: 'processing' }
  | { state: 'taken' }
  | { state: 'expired' }

async function paymentReceipt(env: CloudflareEnv, payment: Payment, receipt: CheckoutHold | null): Promise<PaymentReturn> {
  if (receipt?.status !== 'converted') throw new Error('Captured payment has no saved booking')
  if (payment.subject_type !== 'booking') throw new Error(`Payment subject ${payment.subject_type} has no guest confirmation`)
  const conversationId = receipt.receipt_conversation_id
  if (!conversationId) throw new Error('Converted hold has no booking conversation')
  if (receipt.session_id === null) {
    // A stay is read by its conversation, as the guest's account reads it.
    return { state: 'paid', kind: 'stay', activity_id: conversationId, receipt_token: (await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET ?? '', conversationId)).token }
  }
  const cancellation = await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET ?? '', conversationId)
  if (await hashReservationCancelToken(cancellation.token) !== receipt.receipt_cancellation_hash) throw new Error('Paid booking is missing its receipt capability')
  return { state: 'paid', kind: 'booking', conversation_id: conversationId, cancellation_token: cancellation.token }
}

/** Read the receipt after confirm or the Stripe webhook has saved and captured the booking. */
export async function completePaymentReturn(db: DbClient, env: CloudflareEnv, organizationId: string, paymentId: string, claim: string, buyer: () => Promise<string>): Promise<PaymentReturn> {
  const now = new Date().toISOString()
  const payment = await readCheckoutPayment(db, organizationId, paymentId, claim, now, 'settlement')
  // Reconciliation writes captured_amount only after it verifies Stripe's succeeded intent.
  if (payment.captured_amount <= 0) {
    const { intent, state } = await readCheckoutIntent(paymentsStripe(env, Boolean(payment.livemode)), payment, now)
    if (intent.livemode !== Boolean(payment.livemode) || intent.metadata.krabiclaw_payment_id !== payment.id) throw new HTTPError({ statusCode: 409, statusMessage: 'Stripe has not authenticated this purchase' })
    if (state === 'taken') return { state: 'taken' }
    if (state === 'failed' || state === 'expired') return { state: 'expired' }
    if (intent.status === 'requires_payment_method' && intent.last_payment_error) {
      throw new HTTPError({ statusCode: 409, statusMessage: 'Stripe declined this payment', data: { code: 'payment_declined' } })
    }
    if (state === 'processing' || state === 'verifying') return { state: 'processing' }
    throw new HTTPError({ statusCode: 409, statusMessage: 'Stripe has not authenticated this purchase' })
  }
  // The approval checkout began in the buyer's account; the business's site may have a different browser session.
  const snapshot = snapshotOf(payment)
  if (!snapshot.approval) await claimCheckoutReturn(db, await buyer(), claim, payment)
  const hold = payment.checkout_hold ? JSON.parse(payment.checkout_hold) as CheckoutHold : null
  return paymentReceipt(env, payment, hold)
}
