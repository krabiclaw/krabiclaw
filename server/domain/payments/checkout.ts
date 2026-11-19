import { publishEvent } from '~/server/events'
import { STAY_BOOKED_POLICIES } from '~/shared/stay-cancellation'
import { bookingPolicy, type BookingPolicy } from '~/server/utils/booking-policy-summary'
import type Stripe from 'stripe'
import { HTTPError } from 'nitro'
import { execute, executeBatch, queryFirst, type DbClient, type BatchQuery } from '~/server/db'
import { assertPriceShape, PRICE_TAX_BEHAVIORS, type Price } from '~/shared/prices'
import { isRecord } from '~/server/utils/type-guards'
import { formAnswerSnapshotsSchema, type FormAnswerSnapshot } from '~/shared/form-questions'
import { paidQuantity, type ResolvedBookingSession } from '~/server/utils/availability'
import { paymentsStripe, requireStripeCheckoutAcceptance, validatedSurchargeBasisPoints, type StripeConnectedAccount } from '~/server/utils/stripe-connect'
import type { CloudflareEnv } from '~/server/utils/auth'
import { tokenHash } from './buyer'
import { connectedBuyerCustomer, type ConnectedBuyer } from '~/server/utils/billing-customer'
import { conversionOriginSnapshotQuery } from '~/server/utils/organization-conversions'
import { approvedStayBooking, assertMinorAmount, type ApprovedStayBooking, type Payment } from './index'
import { isCurrencyCode } from '~/shared/currencies'
import { quotePaymentsBillingFx, requireBillingFxQuote } from './fx'
import type { CheckoutStay, StayQuote } from '~/server/domain/stays'
import type { readCheckoutSeller } from '~/server/utils/billing-access'

interface CheckoutInputBase {
  organizationId: string
  buyerUserId: string | null
  buyer?: ConnectedBuyer | null
  /** The existing guest conversation for a session or approved stay. Instant stays open theirs on payment. */
  requestId: string | null
  requestFingerprint: string
  quantity: number
  idempotencyKey: string
  previous: CheckoutAttempt | undefined
  seller?: Awaited<ReturnType<typeof readCheckoutSeller>>
  following: (paymentId: string) => BatchQuery[]
  /**
   * The guest's own browser request and the pageview it came from, which say
   * how the guest arrived; null when the business creates the checkout, whose
   * staff browsing is never the guest's source.
   */
  origin: { request: { headers: Headers }; pageEventId: string | null } | null
}
/** A checkout freezes the purchase terms for a session or a stay. */
export type CheckoutInput = CheckoutInputBase & (
  /** `answers` are the guest's answers accepted for a new checkout, frozen with its purchase; null on a retry, which is held to the ones it froze. */
  | { unit: 'slot'; productId: string; variantId: string; sessionId: string; answers: FormAnswerSnapshot[] | null; terms?: { resolved: ResolvedBookingSession; price: Price; title: string; taxCode: string | null } }
  /** A retry uses the same frozen stay terms. */
  | { unit: 'nights'; stay: StayRequest; guest: CheckoutStay['guest']; terms?: { quote: StayQuote; policy: BookingPolicy; taxCode: string | null }; approval?: StayCheckoutApproval }
)

/** Which stay a guest asked for: the home, the nights and the party. */
export type StayRequest = Pick<StayQuote, 'product_id' | 'check_in_date' | 'check_out_date' | 'adults' | 'children' | 'infants'>

interface StayCheckoutApproval extends ApprovedStayBooking {
  conversationId: string
  buyerUserId: string
  expiresAt: string
}

/** The stay a checkout froze: the quote's nights and money, and the guest who is paying. */
export type StayPurchase = CheckoutStay['quote'] & Pick<StayQuote, 'location_id' | 'timezone' | 'nightly'> & { guest: CheckoutStay['guest'] }

export function isStayPurchase(value: unknown): value is StayPurchase {
  if (!isRecord(value) || !isRecord(value.guest) || !Array.isArray(value.nightly)) return false
  const guest = value.guest
  return typeof value.product_id === 'string' && typeof value.location_id === 'string' && typeof value.timezone === 'string'
    && typeof value.check_in_date === 'string' && typeof value.check_out_date === 'string' && value.check_out_date > value.check_in_date
    && [value.adults, value.children, value.infants, value.total_minor].every(Number.isSafeInteger) && isCurrencyCode(value.currency)
    && value.nightly.every(night => isRecord(night) && typeof night.date === 'string' && Number.isSafeInteger(night.price_minor))
    && (STAY_BOOKED_POLICIES as readonly unknown[]).includes(value.cancellation_policy)
    && typeof guest.name === 'string' && !!guest.name.trim() && typeof guest.email === 'string'
    && (guest.phone === null || typeof guest.phone === 'string') && (guest.notes === null || typeof guest.notes === 'string')
    // A purchase frozen before homes asked questions carries no answers, and none were asked.
    && (guest.answers === undefined || formAnswerSnapshotsSchema.safeParse(guest.answers).success)
}
/**
 * The amount the buyer was shown and confirmed on the site, kept on the attempt
 * until Stripe answers: the purchase, the tax Stripe Tax added on top of it (and
 * the tax already inside it), and the card surcharge on that taxed amount.
 */
export interface PaymentReview { payment_method_id: string; subtotal: number; tax: number; tax_included: number; surcharge: number; total: number; reviewed_at: string }
export interface PaymentHandoff { payment_id: string; pay_path: string; purchase_claim: string; expires_at: string }

export type CheckoutAttempt = Payment & {
  hold_status: string | null; hold_expires_at: string | null; hold_quantity: number | null
  hold_conversation_id: string | null; hold_fingerprint: string | null; confirmation_in_flight: number | null
  surcharge_basis_points: number | null
}

function checkoutKey(organizationId: string, idempotencyKey: string): string {
  return `checkout:${organizationId}:${idempotencyKey.trim()}`
}

export function checkoutAttemptQuery(organization: string | BatchQuery, idempotencyKey: string): BatchQuery {
  const scope = typeof organization === 'string' ? { query: '?', params: [organization] } : organization
  const key = typeof organization === 'string' ? { query: '?', params: [checkoutKey(organization, idempotencyKey)] }
    : { query: `('checkout:' || ${scope.query} || ':' || ?)`, params: [...scope.params ?? [], idempotencyKey.trim()] }
  return { query: `
    SELECT p.*, h.status AS hold_status, h.expires_at AS hold_expires_at, h.quantity AS hold_quantity,
      r.id AS hold_conversation_id, json_extract(r.payload_json, '$.provenance.fingerprint') AS hold_fingerprint,
      h.status='active' AND h.expires_at>? AND json_type(p.review_json,'$.confirmation_started_at')='text' AS confirmation_in_flight,
      a.surcharge_basis_points
    FROM payments p LEFT JOIN payment_checkout_holds h ON h.payment_id=p.id AND h.organization_id=p.organization_id
    LEFT JOIN conversations r ON r.id=h.conversation_id AND r.organization_id=p.organization_id
    LEFT JOIN stripe_connected_accounts a ON a.organization_id=p.organization_id AND a.stripe_account_id=p.stripe_account_id AND a.livemode=p.livemode
    WHERE p.idempotency_key=${key.query} AND p.organization_id=${scope.query}`,
    params: [new Date().toISOString(), ...key.params, ...scope.params ?? []] }
}

export function readCheckoutAttempt(db: DbClient, organizationId: string, idempotencyKey: string) {
  const read = checkoutAttemptQuery(organizationId, idempotencyKey)
  return queryFirst<CheckoutAttempt>(db, read.query, read.params)
}

/** Stripe owns payment state. The checkout records the immutable purchase and guest request. */
export async function createPaymentCheckout(db: DbClient, env: CloudflareEnv, input: CheckoutInput, retry = false) {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 99 || !input.idempotencyKey.trim() || input.idempotencyKey.trim().length > 200) throw new HTTPError({ statusCode: 400, statusMessage: 'A quantity of 1–99 and an idempotency key of 1–200 characters are required' })
  if (input.buyer && input.buyer.id !== input.buyerUserId) throw new Error('Checkout buyer does not match the user')
  const key = checkoutKey(input.organizationId, input.idempotencyKey)
  const approval = input.unit === 'nights' ? input.approval : undefined
  const previous = input.previous
  // Stripe rejected this checkout before creating a PaymentIntent.
  if(previous&&!previous.stripe_payment_intent_id&&previous.hold_status==='released')throw new HTTPError({statusCode:409,statusMessage:'Checkout was rejected; start a new request',data:{code:'checkout_failed'}})
  const now = new Date().toISOString()
  let price: Pick<Price, 'unit_amount' | 'currency' | 'tax_behavior'> | undefined
  let catalogPriceId: string | null = null
  let stay: StayPurchase | null = null
  let policy: BookingPolicy
  let answers: FormAnswerSnapshot[] = []
  // A seat is paid per guest; a table's deposit once for the booking; a stay once for its nights.
  let purchaseQuantity = 1
  let connected: Pick<StripeConnectedAccount, 'stripe_account_id' | 'livemode'> | undefined
  let projectionTitle: string
  let projectionTaxCode: string | null
  let automaticTax: boolean | undefined
  let methodConfigurationId: string | undefined
  if (previous) {
    const frozen = previous
    const snapshot: unknown = JSON.parse(frozen.price_snapshot_json)
    if (frozen.subject_type !== 'booking' || !isRecord(snapshot) || isRecord(snapshot.stay) !== (input.unit === 'nights') || typeof snapshot.title !== 'string' || !snapshot.title.trim()
      || (snapshot.tax_code !== null && (typeof snapshot.tax_code !== 'string' || !snapshot.tax_code.trim()))
      || typeof snapshot.quantity !== 'number' || !Number.isSafeInteger(snapshot.quantity) || snapshot.quantity < 1
      || (input.unit === 'slot' ? previous.hold_quantity !== input.quantity : snapshot.quantity !== 1)
      || typeof snapshot.automatic_tax !== 'boolean'
      || typeof snapshot.method_configuration_id !== 'string' || !snapshot.method_configuration_id.trim()
      || snapshot.request_fingerprint !== input.requestFingerprint || !isRecord(snapshot.price)
      || !isCurrencyCode(snapshot.price.currency) || !Number.isSafeInteger(snapshot.price.unit_amount)
      || !PRICE_TAX_BEHAVIORS.includes(snapshot.price.tax_behavior as Price['tax_behavior'])) {
      throw new HTTPError({ statusCode: 409, statusMessage: 'Checkout retry does not match its immutable purchase' })
    }
    const booked = approvedStayBooking(snapshot)
    if (booked?.bookingId !== approval?.bookingId || booked?.version !== approval?.version) {
      throw new HTTPError({ statusCode: 409, statusMessage: 'Checkout no longer matches the approved stay' })
    }
    purchaseQuantity = snapshot.quantity
    const frozenPrice = snapshot.price as Pick<Price, 'unit_amount' | 'currency' | 'tax_behavior'>
    if (frozenPrice.unit_amount * purchaseQuantity !== frozen.amount || frozenPrice.currency !== frozen.currency) throw new HTTPError({statusCode:409,statusMessage:'Stored checkout snapshot does not match its payment'})
    if (input.buyerUserId !== null && frozen.buyer_user_id !== input.buyerUserId) throw new HTTPError({statusCode:403,statusMessage:'Checkout belongs to another buyer'})
    if (input.unit === 'slot') {
      if (snapshot.product_id !== input.productId || snapshot.variant_id !== input.variantId || snapshot.session_id !== input.sessionId
        || typeof snapshot.price.id !== 'string' || !snapshot.price.id.trim() || snapshot.price.organization_id !== input.organizationId
        || snapshot.price.product_variant_id !== input.variantId || snapshot.price.type !== 'one_time' || !isRecord(snapshot.policy)) throw new HTTPError({ statusCode: 409, statusMessage: 'Stored booking purchase is invalid' })
      const frozenAnswers = formAnswerSnapshotsSchema.safeParse(snapshot.answers)
      if (!frozenAnswers.success || (input.answers !== null && JSON.stringify(input.answers) !== JSON.stringify(frozenAnswers.data))) throw new HTTPError({ statusCode: 409, statusMessage: 'Stored booking purchase is invalid', data: { code: 'idempotency_conflict', field: 'answers' } })
      assertPriceShape(snapshot.price as unknown as Price)
      policy = snapshot.policy as unknown as BookingPolicy
      answers = frozenAnswers.data
    } else {
      const frozenStay = snapshot.stay
      if (!isStayPurchase(frozenStay) || frozenStay.product_id !== input.stay.product_id || frozenStay.check_in_date !== input.stay.check_in_date
        || frozenStay.check_out_date !== input.stay.check_out_date || frozenStay.adults !== input.stay.adults || frozenStay.children !== input.stay.children
        || frozenStay.infants !== input.stay.infants || frozenStay.total_minor !== frozen.amount || !isRecord(snapshot.policy)) throw new HTTPError({ statusCode: 409, statusMessage: 'Stored stay purchase is invalid', data: { code: 'idempotency_conflict', field: 'idempotency_key' } })
      stay = frozenStay
      policy = snapshot.policy as unknown as BookingPolicy
    }
    connected = { stripe_account_id: frozen.stripe_account_id, livemode: frozen.livemode === 1 }
    projectionTitle=snapshot.title
    projectionTaxCode=snapshot.tax_code
    price = frozenPrice
    requireBillingFxQuote(snapshot.billing_fx, frozenPrice.currency)
    automaticTax = snapshot.automatic_tax
    methodConfigurationId=snapshot.method_configuration_id
  } else if (input.unit === 'slot') {
    if (!input.terms) throw new Error('A new checkout requires the selected offering and its price')
    const { price: timedPrice, resolved: { config }, title, taxCode } = input.terms
    purchaseQuantity = paidQuantity(config, input.quantity)
    price = timedPrice
    catalogPriceId = timedPrice.id
    policy = bookingPolicy(config, timedPrice)
    if (input.answers === null) throw new Error('A new checkout carries the answers the guest gave')
    answers = input.answers
    projectionTitle = title
    projectionTaxCode = taxCode
  } else {
    if (!input.terms) throw new Error('A new stay checkout requires the quoted nights and their booking terms')
    const guest = input.guest
    const { quote, taxCode } = input.terms
    if (quote.product_id !== input.stay.product_id || quote.check_in_date !== input.stay.check_in_date || quote.check_out_date !== input.stay.check_out_date) throw new Error('The stay quote does not match the stay requested')
    price = { unit_amount: quote.total_minor, currency: quote.currency, tax_behavior: quote.tax_behavior }
    projectionTitle = quote.name
    projectionTaxCode = taxCode
    stay = {
      product_id: quote.product_id, location_id: quote.location_id, timezone: quote.timezone, check_in_date: quote.check_in_date, check_out_date: quote.check_out_date,
      adults: quote.adults, children: quote.children, infants: quote.infants, nightly: quote.nightly, total_minor: quote.total_minor, currency: quote.currency, cancellation_policy: quote.cancellation_policy, guest,
    }
    // The terms the guest booked under are frozen with the purchase, as a session booking's are.
    policy = input.terms.policy
  }
  const acceptance = previous ? null : await requireStripeCheckoutAcceptance(db, env, input.organizationId, input.seller)
  if (acceptance) {
    connected = acceptance.connected
    methodConfigurationId = acceptance.methodConfigurationId
    automaticTax = acceptance.automaticTax
  }
  if(!price || !connected?.stripe_account_id || automaticTax === undefined || !methodConfigurationId)throw new Error('Immutable checkout price or connected account is missing')
  const amount = price.unit_amount*purchaseQuantity
  assertMinorAmount(amount)
  const id = previous?.id ?? crypto.randomUUID(), holdId = crypto.randomUUID()
  const returnToken=previous?.return_token ?? crypto.randomUUID()+crypto.randomUUID()
  const returnHash=await tokenHash(returnToken)
  const expiresAt = previous?.checkout_expires_at ?? approval?.expiresAt ?? new Date(Date.now()+60*60*1000).toISOString()
  const resuming = approval && previous?.stripe_payment_intent_id && previous.confirmation_in_flight === 1
  if (expiresAt <= now && !resuming) throw new HTTPError({statusCode:409,statusMessage:'Checkout expired; start a new request',data:{code:'checkout_expired'}})
  const handoff = (paymentId: string): PaymentHandoff => ({ payment_id: paymentId, pay_path: `/pay/${encodeURIComponent(paymentId)}`, purchase_claim: returnToken, expires_at: expiresAt })
  if (approval && previous?.hold_status !== undefined && previous.hold_status !== 'active') {
    throw new HTTPError({ statusCode: 409, statusMessage: 'Checkout is no longer available for this stay', data: { code: 'checkout_expired' } })
  }
  const publishCheckout = (savedCardsOffered: number | null) => publishEvent(env, {
    type: 'payment.checkout_started', organization_id: input.organizationId, payment_id: id, saved_cards_offered: savedCardsOffered,
  })
  if (previous?.stripe_payment_intent_id) {
    await publishCheckout(null)
    return handoff(previous.id)
  }
  const stripe = acceptance?.stripe ?? paymentsStripe(env, connected.livemode)
  const surcharge = acceptance ? acceptance.surchargeBasisPoints : validatedSurchargeBasisPoints(previous!.surcharge_basis_points)
  if (!previous) {
    const billingFx = await quotePaymentsBillingFx(stripe, price.currency)
    let hold: BatchQuery
    const session = input.unit === 'slot' ? input.terms?.resolved.session : undefined
    if (input.unit === 'slot') {
      if (!session || !catalogPriceId) throw new Error('The selected session or price is missing')
      hold = { query: `INSERT INTO payment_checkout_holds(id,organization_id,product_id,variant_id,price_id,session_id,buyer_user_id,conversation_id,payment_id,quantity,amount,currency,starts_at,ends_at,status,expires_at,created_at,location_id,timezone)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?)`,
        params: [holdId,input.organizationId,input.productId,input.variantId,catalogPriceId,session.id,input.buyerUserId,input.requestId,id,input.quantity,amount,price.currency,session.starts_at,session.ends_at,expiresAt,now,session.location_id,session.timezone] }
    } else {
      if (!stay) throw new Error('The selected stay is missing')
      hold = { query: `INSERT INTO payment_checkout_holds(id,organization_id,product_id,location_id,timezone,buyer_user_id,conversation_id,payment_id,quantity,amount,currency,starts_at,ends_at,status,expires_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?)`,
        params: [holdId,input.organizationId,stay.product_id,stay.location_id,stay.timezone,input.buyerUserId,approval?.conversationId ?? null,id,stay.adults+stay.children,amount,price.currency,stay.check_in_date,stay.check_out_date,expiresAt,now] }
    }
    const purchase = { title: projectionTitle, tax_code: projectionTaxCode, price, quantity: purchaseQuantity, automatic_tax: automaticTax, method_configuration_id: methodConfigurationId, request_fingerprint: input.requestFingerprint, billing_fx: billingFx,
      policy, ...(input.unit === 'slot' ? { product_id: input.productId, variant_id: input.variantId, session_id: input.sessionId, answers } : { stay, ...(approval ? { approved_stay: { bookingId: approval.bookingId, version: approval.version } } : {}) }) }
    const origin = conversionOriginSnapshotQuery(input.organizationId, input.origin)
    try { await executeBatch(db,[
      { query: `INSERT INTO payments(id,organization_id,buyer_user_id,stripe_account_id,livemode,subject_type,subject_id,location_id,currency,amount,price_snapshot_json,idempotency_key,checkout_expires_at,return_token,return_token_hash,return_expires_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,json_set(?, '$.checkout_origin', json((${origin.query}))),?,?,?,?,?,?,?)`,
        params:[id,input.organizationId,input.buyerUserId,connected.stripe_account_id,Number(connected.livemode),'booking',null,input.unit === 'slot' ? session!.location_id : stay!.location_id,price.currency,amount,JSON.stringify(purchase),...(origin.params ?? []),key,expiresAt,returnToken,returnHash,new Date(Date.now()+86400000).toISOString(),now,now] },
      ...(input.unit === 'slot' ? (input.terms?.resolved.preceding ?? []) : []), hold,
      ...input.following(id),
    ],{operation:'Save payment checkout'})
    } catch(error) {
      const raced = retry ? undefined : await readCheckoutAttempt(db, input.organizationId, input.idempotencyKey)
      if (raced) return await createPaymentCheckout(db, env, { ...input, previous: raced }, true)
      throw error
    }
  }
  // A signed-in buyer's Customer at this business: the Payment Element offers, saves and removes their cards here only.
  const customer = input.buyerUserId ? await connectedBuyerCustomer(db, stripe, input.buyer ?? input.buyerUserId, connected.stripe_account_id, connected.livemode) : null
  try {
    const intent = await stripe.paymentIntents.create({
      amount, currency: price.currency.toLowerCase(),
      ...(customer ? { customer: customer.customerId } : {}),
      // Stripe selects eligible methods from the business's connected configuration.
      payment_method_configuration: methodConfigurationId,
      automatic_payment_methods: { enabled: true, allow_redirects: 'always' },
      // Cards and Link are authorized before the booking is saved. ACH clears asynchronously.
      payment_method_options: { card: { capture_method: 'manual' }, link: { capture_method: 'manual' } },
      application_fee_amount: 0,
      description: projectionTitle,
      metadata: { krabiclaw_payment_id: id },
      // Stripe reports, per card, whether a surcharge may apply and how much at most; the amount is set when the buyer confirms.
      ...(surcharge !== null ? { amount_details: { surcharge: { enforce_validation: 'enabled' } } } : {}),
    } as Stripe.PaymentIntentCreateParams, { stripeAccount: connected.stripe_account_id, idempotencyKey: key })
    if (intent.livemode !== connected.livemode || !intent.client_secret) throw new Error('Stripe returned a PaymentIntent outside the connected mode')
    const linked = await execute(db, 'UPDATE payments SET stripe_payment_intent_id=?,updated_at=? WHERE id=? AND organization_id=?', [intent.id, new Date().toISOString(), id, input.organizationId])
    if (linked.meta.changes !== 1) throw new HTTPError({ statusCode: 404, statusMessage: 'Payment not found' })
  } catch(error) {
    // A prior attempt may have reached Stripe even when its response was lost.
    // Only a first-call content/auth rejection proves no intent was created.
    const rejected=!previous&&(error instanceof stripe.errors.StripeInvalidRequestError||error instanceof stripe.errors.StripeAuthenticationError||error instanceof stripe.errors.StripePermissionError)&&error.headers?.['stripe-should-retry']!=='true'
    if (rejected) {
      await execute(db, "UPDATE payment_checkout_holds SET status='released' WHERE payment_id=? AND status='active'", [id])
    }
    throw error
  }
  await publishCheckout(customer?.savedCards ?? 0)
  return handoff(id)
}
