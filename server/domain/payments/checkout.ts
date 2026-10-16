import { STAY_BOOKED_POLICIES } from '~/shared/stay-cancellation'
import { refreshProductBusy } from '~/server/domain/member-scheduling'
import { getSourceLocale } from '~/server/utils/organization-locales'
import { platformLocale } from '~/shared/platform-locales'
import { requireLocationReservationConfig, reservationAllocationPredicate, reservationPolicySummarySource } from '~/server/utils/reservations'
import { sessionMemberSql } from '~/server/utils/provider-allocation'
import type Stripe from 'stripe'
import { HTTPError } from 'nitro'
import { execute, executeBatch, queryAll, queryFirst, type DbClient, type BatchQuery } from '~/server/db'
import { assertPriceShape, PRICE_TAX_BEHAVIORS, selectPrice, type Price } from '~/shared/prices'
import { isRecord } from '~/server/utils/type-guards'
import { sessionAllocationPredicate } from '~/server/utils/availability'
import { requireStripeCheckoutAcceptance, type StripeConnectedAccount } from '~/server/utils/stripe-connect'
import type { CloudflareEnv } from '~/server/utils/auth'
import { tokenHash } from './buyer'
import { connectedBuyerCustomer } from '~/server/utils/billing-customer'
import { assertMinorAmount, requirePayment } from './index'
import { recordCheckoutStarted } from '~/server/domain/booking-analytics'
import { isCurrencyCode } from '~/shared/currencies'
import { quotePaymentsBillingFx, requireBillingFxQuote } from './fx'
import { isStayNightConflict, stayHoldClaimQueries, stayHoldPredicate, type CheckoutStay, type StayQuote } from '~/server/domain/stays'

interface CheckoutInputBase {
  organizationId: string
  buyerUserId: string | null
  /** The guest conversation the hold waits in; a stay's conversation opens when its payment is captured. */
  requestId: string | null
  requestFingerprint: string
  quantity: number
  idempotencyKey: string
  returnOrigin: string
  following: (paymentId: string) => BatchQuery[]
}
export type CheckoutInput = CheckoutInputBase & (
  | { subjectType: 'booking'; productId: string; variantId: string; sessionId: string }
  | { subjectType: 'reservation'; locationId: string; startsAt: string; endsAt: string; timezone: string }
  /** `quote` is read only for a new checkout; a retry is held to the stay it froze, whose nights it already holds. */
  | { subjectType: 'stay'; stay: StayRequest; guest: CheckoutStay['guest']; quote: () => Promise<StayQuote> }
)

/** Which stay a guest asked for: the home, the nights and the party. */
export type StayRequest = Pick<StayQuote, 'product_id' | 'check_in_date' | 'check_out_date' | 'adults' | 'children' | 'infants'>

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
}
/** The amount the buyer was shown and confirmed on the site, kept on the attempt until Stripe answers. */
export interface PaymentReview { payment_method_id: string; subtotal: number; surcharge: number; total: number; reviewed_at: string }
export interface PaymentHandoff { payment_id: string; pay_path: string; purchase_claim: string; expires_at: string }
/** Stripe's PaymentIntent owns payment; one atomic batch owns the guest request, expiring capacity hold and immutable purchase. */
export async function createPaymentCheckout(db: DbClient, stripe: Stripe, env: CloudflareEnv, input: CheckoutInput, retry = false) {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 99 || !input.idempotencyKey.trim() || input.idempotencyKey.trim().length > 200) throw new HTTPError({ statusCode: 400, statusMessage: 'A quantity of 1–99 and an idempotency key of 1–200 characters are required' })
  const origin = new URL(input.returnOrigin)
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Payments return origin must be an HTTPS origin')
  const key = `checkout:${input.organizationId}:${input.idempotencyKey.trim()}`
  const previous = await queryFirst<{id:string;payment_id:string;stripe_payment_intent_id:string|null;expires_at:string;return_token:string;status:string}>(db,'SELECT id,payment_id,stripe_payment_intent_id,expires_at,return_token,status FROM payment_attempts WHERE idempotency_key=?',[key])
  if(previous?.status==='failed')throw new HTTPError({statusCode:409,statusMessage:'Checkout was rejected; start a new request',data:{code:'checkout_failed'}})
  const now = new Date().toISOString()
  let price: Pick<Price, 'unit_amount' | 'currency' | 'tax_behavior'> | undefined
  let catalogPriceId: string | null = null
  let reservation: Record<string, unknown> | null = null
  let stay: StayPurchase | null = null
  const purchaseQuantity = input.subjectType === 'booking' ? input.quantity : 1
  let connected: Pick<StripeConnectedAccount, 'stripeAccountId' | 'livemode'> | undefined
  let projectionTitle: string
  let projectionTaxCode: string | null
  let automaticTax: boolean | undefined
  let methodConfigurationId: string | undefined
  let session: {id:string;location_id:string|null;starts_at:string;ends_at:string;online_payment_required:number;timezone:string} | null = null
  if (previous) {
    const frozen = await requirePayment(db,input.organizationId,previous.payment_id)
    const snapshot: unknown = JSON.parse(frozen.price_snapshot_json)
    if (frozen.subject_type !== input.subjectType || !isRecord(snapshot) || typeof snapshot.title !== 'string' || !snapshot.title.trim()
      || (snapshot.tax_code !== null && (typeof snapshot.tax_code !== 'string' || !snapshot.tax_code.trim()))
      || snapshot.quantity !== purchaseQuantity || typeof snapshot.automatic_tax !== 'boolean'
      || typeof snapshot.method_configuration_id !== 'string' || !snapshot.method_configuration_id.trim()
      || snapshot.request_fingerprint !== input.requestFingerprint || !isRecord(snapshot.price)
      || !isCurrencyCode(snapshot.price.currency) || !Number.isSafeInteger(snapshot.price.unit_amount)
      || !PRICE_TAX_BEHAVIORS.includes(snapshot.price.tax_behavior as Price['tax_behavior'])) {
      throw new HTTPError({ statusCode: 409, statusMessage: 'Checkout retry does not match its immutable purchase' })
    }
    const frozenPrice = snapshot.price as Pick<Price, 'unit_amount' | 'currency' | 'tax_behavior'>
    if (frozenPrice.unit_amount * purchaseQuantity !== frozen.amount || frozenPrice.currency !== frozen.currency) throw new HTTPError({statusCode:409,statusMessage:'Stored checkout snapshot does not match its payment'})
    if (input.buyerUserId !== null && frozen.buyer_user_id !== input.buyerUserId) throw new HTTPError({statusCode:403,statusMessage:'Checkout belongs to another buyer'})
    if (input.subjectType === 'booking') {
      if (snapshot.product_id !== input.productId || snapshot.variant_id !== input.variantId || snapshot.session_id !== input.sessionId
        || typeof snapshot.price.id !== 'string' || !snapshot.price.id.trim() || snapshot.price.organization_id !== input.organizationId
        || snapshot.price.product_variant_id !== input.variantId || snapshot.price.type !== 'one_time') throw new HTTPError({ statusCode: 409, statusMessage: 'Stored booking purchase is invalid' })
      assertPriceShape(snapshot.price as unknown as Price)
    } else if (input.subjectType === 'stay') {
      const frozenStay = snapshot.stay
      if (!isStayPurchase(frozenStay) || frozenStay.product_id !== input.stay.product_id || frozenStay.check_in_date !== input.stay.check_in_date
        || frozenStay.check_out_date !== input.stay.check_out_date || frozenStay.adults !== input.stay.adults || frozenStay.children !== input.stay.children
        || frozenStay.infants !== input.stay.infants || frozenStay.total_minor !== frozen.amount) throw new HTTPError({ statusCode: 409, statusMessage: 'Stored stay purchase is invalid', data: { code: 'idempotency_conflict', field: 'idempotency_key' } })
      stay = frozenStay
    } else {
      if (!isRecord(snapshot.reservation) || snapshot.reservation.location_id !== input.locationId
        || snapshot.reservation.starts_at !== input.startsAt || snapshot.reservation.ends_at !== input.endsAt
        || snapshot.reservation.timezone !== input.timezone || snapshot.reservation.party_size !== input.quantity) throw new HTTPError({ statusCode: 409, statusMessage: 'Stored reservation purchase is invalid' })
      reservation = snapshot.reservation
    }
    connected = { stripeAccountId: frozen.stripe_account_id, livemode: frozen.livemode === 1 }
    projectionTitle=snapshot.title
    projectionTaxCode=snapshot.tax_code
    price = frozenPrice
    requireBillingFxQuote(snapshot.billing_fx, frozenPrice.currency)
    automaticTax = snapshot.automatic_tax
    methodConfigurationId=snapshot.method_configuration_id
  } else if (input.subjectType === 'booking') {
    const product = await queryFirst<{name:string;tax_code:string|null;currency:string}>(db,`SELECT p.name,p.tax_code,o.default_currency AS currency FROM products p JOIN organization o ON o.id=p.organization_id JOIN product_variants v ON v.product_id=p.id AND v.organization_id=p.organization_id WHERE p.organization_id=? AND p.id=? AND v.id=? AND p.active=1 AND v.active=1`,[input.organizationId,input.productId,input.variantId])
    if (!product || !isCurrencyCode(product.currency)) throw new HTTPError({statusCode:409,statusMessage:'An active offering with a supported currency is required'})
    session = await queryFirst(db,`SELECT s.*,c.online_payment_required FROM product_sessions s JOIN product_booking_configs c ON c.product_id=s.product_id AND c.organization_id=s.organization_id WHERE s.organization_id=? AND s.id=? AND s.product_id=?`,[input.organizationId,input.sessionId,input.productId])
    if (!session) throw new HTTPError({statusCode:404,statusMessage:'Session not found'})
    if (!session.online_payment_required) throw new HTTPError({statusCode:409,statusMessage:'This offering uses pay-later booking'})
    const rawPrices = await queryAll<Price>(db,'SELECT * FROM prices WHERE organization_id=? AND product_variant_id=?',[input.organizationId,input.variantId])
    price = selectPrice(rawPrices.map(p=>({...p,active:Boolean(p.active)})),{currency:product.currency,location_id:session.location_id,at:now,billing:{type:'one_time'}}) ?? undefined
    if (!price) throw new HTTPError({statusCode:409,statusMessage:'Offering has no current one-time price'})
    if (price.unit_amount === 0) throw new HTTPError({statusCode:409,statusMessage:'Free offerings use the canonical booking flow without checkout'})
    catalogPriceId = (price as Price).id
    projectionTitle = product.name
    projectionTaxCode = product.tax_code
  } else if (input.subjectType === 'stay') {
    const guest = input.guest
    const quote = await input.quote()
    if (quote.product_id !== input.stay.product_id || quote.check_in_date !== input.stay.check_in_date || quote.check_out_date !== input.stay.check_out_date) throw new Error('The stay quote does not match the stay requested')
    const product = await queryFirst<{ tax_code: string | null }>(db, 'SELECT tax_code FROM products WHERE organization_id = ? AND id = ?', [input.organizationId, quote.product_id])
    if (!product) throw new HTTPError({ statusCode: 404, statusMessage: 'That place to stay is not open for booking', data: { code: 'STAY_NOT_FOUND', field: 'slug' } })
    price = { unit_amount: quote.total_minor, currency: quote.currency, tax_behavior: quote.tax_behavior }
    projectionTitle = quote.name
    projectionTaxCode = product.tax_code
    stay = {
      product_id: quote.product_id, location_id: quote.location_id, timezone: quote.timezone, check_in_date: quote.check_in_date, check_out_date: quote.check_out_date,
      adults: quote.adults, children: quote.children, infants: quote.infants, nightly: quote.nightly, total_minor: quote.total_minor, currency: quote.currency, cancellation_policy: quote.cancellation_policy, guest,
    }
  } else {
    const [policy, location, locale] = await Promise.all([
      requireLocationReservationConfig(db, { organizationId: input.organizationId, locationId: input.locationId }),
      queryFirst<{ title: string; currency: string }>(db, 'SELECT l.title, o.default_currency AS currency FROM business_locations l JOIN organization o ON o.id = l.organization_id WHERE l.id = ? AND l.organization_id = ?', [input.locationId, input.organizationId]),
      getSourceLocale(db, input.organizationId),
    ])
    if (!location || !isCurrencyCode(location.currency)) throw new HTTPError({ statusCode: 409, statusMessage: 'A reservation location with a supported business currency is required' })
    if (!policy.deposit_required || policy.deposit_trigger_party_size !== null && input.quantity < policy.deposit_trigger_party_size) throw new HTTPError({ statusCode: 409, statusMessage: 'This reservation does not require a deposit' })
    if (!policy.deposit_amount || !policy.deposit_currency || !policy.deposit_tax_behavior) throw new HTTPError({ statusCode: 409, statusMessage: 'Set the reservation deposit amount, currency and tax treatment', data: { missing: [...(!policy.deposit_amount ? ['deposit_amount'] : []), ...(!policy.deposit_currency ? ['deposit_currency'] : []), ...(!policy.deposit_tax_behavior ? ['deposit_tax_behavior'] : [])] } })
    price = { unit_amount: policy.deposit_amount, currency: policy.deposit_currency, tax_behavior: policy.deposit_tax_behavior }
    const label = platformLocale(locale)?.messages['reservations.deposit_label']
    if (!label) throw new Error('The source language has no reservation deposit label')
    projectionTitle = `${location.title} — ${label}`
    projectionTaxCode = null
    reservation = { ...reservationPolicySummarySource(policy), location_id: input.locationId, starts_at: input.startsAt, ends_at: input.endsAt, timezone: input.timezone, party_size: input.quantity, policy_updated_at: policy.updated_at }
  }
  if (!previous) {
    const acceptance = await requireStripeCheckoutAcceptance(db, stripe, env, input.organizationId)
    connected = acceptance.connected
    methodConfigurationId = acceptance.methodConfigurationId
    automaticTax = acceptance.automaticTax
  }
  if(!price || !connected?.stripeAccountId || automaticTax === undefined || !methodConfigurationId)throw new Error('Immutable checkout price or connected account is missing')
  // Stripe Tax calculated the hosted Checkout's tax. The on-site payment does not run Stripe Tax calculations yet, so a business registered for it is refused rather than charged without tax.
  if (automaticTax) throw new HTTPError({ statusCode: 409, statusMessage: 'This business collects tax through Stripe Tax, which online payments on the site do not calculate yet', data: { code: 'stripe_tax_unsupported' } })
  const amount = price.unit_amount*purchaseQuantity
  assertMinorAmount(amount)
  const id = previous?.payment_id ?? crypto.randomUUID(), attemptId = previous?.id ?? crypto.randomUUID(), holdId = crypto.randomUUID()
  const returnToken=previous?.return_token ?? crypto.randomUUID()+crypto.randomUUID()
  const returnHash=await tokenHash(returnToken)
  const expiresAt = previous?.expires_at ?? new Date(Date.now()+60*60*1000).toISOString()
  if (expiresAt<=now) throw new HTTPError({statusCode:409,statusMessage:'Checkout hold expired; start a new request',data:{code:'checkout_expired'}})
  const handoff = (paymentId: string): PaymentHandoff => ({ payment_id: paymentId, pay_path: `/pay/${encodeURIComponent(paymentId)}`, purchase_claim: returnToken, expires_at: expiresAt })
  if (previous?.stripe_payment_intent_id) {
    await recordCheckoutStarted(db, await requirePayment(db,input.organizationId,previous.payment_id), null)
    return handoff(previous.payment_id)
  }
  if (!previous) {
    const billingFx = await quotePaymentsBillingFx(stripe, price.currency)
    let hold: BatchQuery
    const preceding: BatchQuery[] = []
    const following: BatchQuery[] = []
    if (input.subjectType === 'booking') {
      if (!session || !catalogPriceId) throw new Error('The selected session or price is missing')
      await refreshProductBusy(db, env, input.organizationId, input.productId)
      const allocation = await sessionAllocationPredicate(db, { organizationId: input.organizationId, productId: input.productId, sessionId: session.id, partySize: input.quantity, now })
      hold = { query: `INSERT INTO payment_checkout_holds(id,organization_id,product_id,variant_id,price_id,session_id,buyer_user_id,request_id,payment_id,quantity,amount,currency,starts_at,ends_at,status,expires_at,created_at,assigned_member_id,location_id,timezone)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,s.starts_at,s.ends_at,'active',?,?,${sessionMemberSql('s')},s.location_id,s.timezone FROM product_sessions s JOIN product_booking_configs c ON c.product_id=s.product_id AND c.organization_id=s.organization_id WHERE s.id=? AND s.organization_id=? AND s.product_id=? AND ${allocation.query}`,
        params: [holdId,input.organizationId,input.productId,input.variantId,catalogPriceId,session.id,input.buyerUserId,input.requestId,id,input.quantity,amount,price.currency,expiresAt,now,session.id,input.organizationId,input.productId,...allocation.params!] }
      following.push({ query: "UPDATE product_sessions SET assigned_member_id=(SELECT assigned_member_id FROM payment_checkout_holds WHERE payment_id=?) WHERE id=? AND EXISTS(SELECT 1 FROM payment_checkout_holds WHERE payment_id=? AND status='active')", params:[id,session.id,id] })
    } else if (input.subjectType === 'stay') {
      if (!stay) throw new Error('The selected stay is missing')
      const scope = { organizationId: input.organizationId, productId: stay.product_id, checkIn: stay.check_in_date, checkOut: stay.check_out_date }
      const bookable = stayHoldPredicate(scope)
      // A lapsed hold on these nights is cleared before this one claims them; the hold's nights are claimed after it.
      const [clearLapsed, claim] = stayHoldClaimQueries({ ...scope, holdId })
      preceding.push(clearLapsed!)
      hold = { query: `INSERT INTO payment_checkout_holds(id,organization_id,product_id,location_id,timezone,buyer_user_id,request_id,payment_id,quantity,amount,currency,starts_at,ends_at,status,expires_at,created_at)
        SELECT ?,?,?,?,?,?,NULL,?,?,?,?,?,?,'active',?,? WHERE ${bookable.query}`,
        params: [holdId,input.organizationId,stay.product_id,stay.location_id,stay.timezone,input.buyerUserId,id,stay.adults+stay.children,amount,price.currency,stay.check_in_date,stay.check_out_date,expiresAt,now,...bookable.params] }
      following.push(claim!)
    } else {
      if (!reservation || typeof reservation.policy_updated_at !== 'string') throw new Error('The selected reservation policy is missing')
      const allocation = await reservationAllocationPredicate(db, { organizationId: input.organizationId, locationId: input.locationId, startsAt: input.startsAt, endsAt: input.endsAt, timezone: input.timezone, partySize: input.quantity, policyUpdatedAt: reservation.policy_updated_at })
      hold = { query: `INSERT INTO payment_checkout_holds(id,organization_id,location_id,timezone,buyer_user_id,request_id,payment_id,quantity,amount,currency,starts_at,ends_at,status,expires_at,created_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'active',?,? WHERE ${allocation.query}`, params: [holdId,input.organizationId,input.locationId,input.timezone,input.buyerUserId,input.requestId,id,input.quantity,amount,price.currency,input.startsAt,input.endsAt,expiresAt,now,...allocation.params!] }
    }
    const purchase = { title: projectionTitle, tax_code: projectionTaxCode, price, quantity: purchaseQuantity, automatic_tax: automaticTax, method_configuration_id: methodConfigurationId, request_fingerprint: input.requestFingerprint, billing_fx: billingFx,
      ...(input.subjectType === 'booking' ? { product_id: input.productId, variant_id: input.variantId, session_id: input.sessionId } : input.subjectType === 'stay' ? { stay } : { reservation }) }
    try { await executeBatch(db,[
      { query: `INSERT INTO payments(id,organization_id,buyer_user_id,stripe_account_id,livemode,subject_type,subject_id,location_id,currency,amount,price_snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, params:[id,input.organizationId,input.buyerUserId,connected.stripeAccountId,Number(connected.livemode),input.subjectType,null,input.subjectType === 'booking' ? session!.location_id : input.subjectType === 'stay' ? stay!.location_id : input.locationId,price.currency,amount,JSON.stringify(purchase),now,now] },
      ...preceding, hold, ...following,
      {query:`INSERT INTO payment_attempts(id,payment_id,idempotency_key,return_token,status,expires_at,created_at,updated_at) SELECT ?,?,?,?,'creating',?,?,? WHERE EXISTS(SELECT 1 FROM payment_checkout_holds WHERE payment_id=? AND status='active')`,params:[attemptId,id,key,returnToken,expiresAt,now,now,id]},
      ...input.following(id),
      {query:'INSERT INTO payment_claims(token_hash,payment_id,expires_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM payment_attempts WHERE id=?)',params:[returnHash,id,new Date(Date.now()+86400000).toISOString(),attemptId]},
    ],{operation:'Reserve payment checkout'})
    } catch(error) {
      const raced=await queryFirst(db,'SELECT id FROM payment_attempts WHERE idempotency_key=?',[key])
      if(raced && !retry) return await createPaymentCheckout(db,stripe,env,input,true)
      if (input.subjectType === 'stay' && isStayNightConflict(error)) throw new HTTPError({ statusCode: 409, statusMessage: 'Some of these nights are no longer available', data: { code: 'STAY_NIGHTS_UNAVAILABLE', field: 'check_in_date' }, cause: error })
      throw error
    }
    const attempt = await queryFirst(db,'SELECT id FROM payment_attempts WHERE id=?',[attemptId])
    if (!attempt) {
      await execute(db,"UPDATE payments SET state='failed',updated_at=? WHERE id=?",[now,id])
      if (input.subjectType === 'stay') throw new HTTPError({ statusCode: 409, statusMessage: 'This place to stay is no longer open for these nights', data: { code: 'STAY_NIGHTS_UNAVAILABLE', field: 'check_in_date' } })
      throw new HTTPError({statusCode:409,statusMessage:'This time no longer has capacity for your party'})
    }
  }
  // A signed-in buyer's Customer at this business: the Payment Element offers, saves and removes their cards here only.
  const customer=input.buyerUserId?await connectedBuyerCustomer(db,stripe,input.buyerUserId,connected.stripeAccountId,connected.livemode):null
  const surcharge = await surchargeBasisPoints(db, input.organizationId, connected.stripeAccountId)
  try {
    const intent = await stripe.paymentIntents.create({
      amount, currency: price.currency.toLowerCase(),
      ...(customer ? { customer: customer.customerId } : {}),
      // The connected configuration the acceptance check verified: cards, Link, wallets, and ACH Direct Debit.
      payment_method_configuration: methodConfigurationId,
      automatic_payment_methods: { enabled: true, allow_redirects: 'always' },
      application_fee_amount: 0,
      description: projectionTitle,
      metadata: { krabiclaw_payment_id: id },
      // Stripe reports, per card, whether a surcharge may apply and how much at most; the amount is set when the buyer confirms.
      ...(surcharge !== null ? { amount_details: { surcharge: { enforce_validation: 'enabled' } } } : {}),
    } as Stripe.PaymentIntentCreateParams, { stripeAccount: connected.stripeAccountId, idempotencyKey: key })
    if (intent.livemode !== connected.livemode || !intent.client_secret) throw new Error('Stripe returned a PaymentIntent outside the connected mode')
    await executeBatch(db, [
      { query: `UPDATE payment_attempts SET stripe_payment_intent_id=?,status='open',error=NULL,updated_at=? WHERE id=?`, params: [intent.id, new Date().toISOString(), attemptId] },
      { query: 'UPDATE payments SET stripe_payment_intent_id=?,updated_at=? WHERE id=?', params: [intent.id, new Date().toISOString(), id] },
    ], { operation: 'Record the payment intent' })
  } catch(error) {
    // A prior attempt may have reached Stripe even when its response was lost.
    // Only a first-call content/auth rejection proves no intent was created.
    const rejected=!previous&&(error instanceof stripe.errors.StripeInvalidRequestError||error instanceof stripe.errors.StripeAuthenticationError||error instanceof stripe.errors.StripePermissionError)&&error.headers?.['stripe-should-retry']!=='true'
    const failedAt=new Date().toISOString()
    await executeBatch(db,[
      {query:"UPDATE payment_attempts SET error=?,updated_at=?,status=CASE WHEN ? THEN 'failed' ELSE status END WHERE id=?",params:[error instanceof Error?error.message.slice(0,500):'Provider payment intent failed',failedAt,Number(rejected),attemptId]},
      ...(rejected?[
        {query:"UPDATE payment_checkout_holds SET status='released' WHERE payment_id=? AND status='active'",params:[id]},
        {query:"UPDATE payments SET state='failed',updated_at=? WHERE id=? AND captured_amount=0",params:[failedAt,id]},
      ]:[]),
    ],{operation:'Record rejected or uncertain payment intent creation'})
    throw error
  }
  await recordCheckoutStarted(db, await requirePayment(db,input.organizationId,id), customer?.savedCards ?? 0)
  return handoff(id)
}

/** The business's pass-on-credit-card-fees rate on this connected account, or null when it does not pass them on. */
export async function surchargeBasisPoints(db: DbClient, organizationId: string, stripeAccountId: string): Promise<number | null> {
  const row = await queryFirst<{ surcharge_basis_points: number | null }>(db, 'SELECT surcharge_basis_points FROM stripe_connected_accounts WHERE organization_id=? AND stripe_account_id=?', [organizationId, stripeAccountId])
  const points = row?.surcharge_basis_points ?? null
  if (points === null) return null
  if (!Number.isSafeInteger(points) || points <= 0 || points > 10_000) throw new Error('Surcharge rate is invalid')
  return points
}
