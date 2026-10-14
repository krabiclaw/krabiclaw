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

interface CheckoutInputBase {
  organizationId: string
  buyerUserId: string | null
  requestId: string
  requestFingerprint: string
  quantity: number
  idempotencyKey: string
  returnOrigin: string
  following: (paymentId: string) => BatchQuery[]
}
export type CheckoutInput = CheckoutInputBase & (
  | { subjectType: 'booking'; productId: string; variantId: string; sessionId: string }
  | { subjectType: 'reservation'; locationId: string; startsAt: string; endsAt: string; timezone: string }
)
/** Stripe Checkout owns payment; one atomic batch owns the guest request, expiring capacity hold and immutable purchase. */
export async function createPaymentCheckout(db: DbClient, stripe: Stripe, env: CloudflareEnv, input: CheckoutInput, retry = false) {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 99 || !input.idempotencyKey.trim() || input.idempotencyKey.trim().length > 200) throw new HTTPError({ statusCode: 400, statusMessage: 'A quantity of 1–99 and an idempotency key of 1–200 characters are required' })
  const origin = new URL(input.returnOrigin)
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Payments return origin must be an HTTPS origin')
  const key = `checkout:${input.organizationId}:${input.idempotencyKey.trim()}`
  const previous = await queryFirst<{id:string;payment_id:string;checkout_url:string|null;expires_at:string;return_token:string;status:string}>(db,'SELECT id,payment_id,checkout_url,expires_at,return_token,status FROM payment_attempts WHERE idempotency_key=?',[key])
  if(previous?.status==='failed')throw new HTTPError({statusCode:409,statusMessage:'Checkout was rejected; start a new request',data:{code:'checkout_failed'}})
  const now = new Date().toISOString()
  let price: Pick<Price, 'unit_amount' | 'currency' | 'tax_behavior'> | undefined
  let catalogPriceId: string | null = null
  let reservation: Record<string, unknown> | null = null
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
  const amount = price.unit_amount*purchaseQuantity
  assertMinorAmount(amount)
  const id = previous?.payment_id ?? crypto.randomUUID(), attemptId = previous?.id ?? crypto.randomUUID(), holdId = crypto.randomUUID()
  const returnToken=previous?.return_token ?? crypto.randomUUID()+crypto.randomUUID()
  const returnHash=await tokenHash(returnToken)
  const expiresAt = previous?.expires_at ?? new Date(Date.now()+60*60*1000).toISOString()
  if (expiresAt<=now) throw new HTTPError({statusCode:409,statusMessage:'Checkout hold expired; start a new request',data:{code:'checkout_expired'}})
  if (previous?.checkout_url) {
    await recordCheckoutStarted(db, await requirePayment(db,input.organizationId,previous.payment_id), null)
    return {payment_id:previous.payment_id,checkout_url:previous.checkout_url,expires_at:expiresAt}
  }
  if (!previous) {
    const billingFx = await quotePaymentsBillingFx(stripe, price.currency)
    let hold: BatchQuery
    const following: BatchQuery[] = []
    if (input.subjectType === 'booking') {
      if (!session || !catalogPriceId) throw new Error('The selected session or price is missing')
      await refreshProductBusy(db, env, input.organizationId, input.productId)
      const allocation = await sessionAllocationPredicate(db, { organizationId: input.organizationId, productId: input.productId, sessionId: session.id, partySize: input.quantity, now })
      hold = { query: `INSERT INTO payment_checkout_holds(id,organization_id,product_id,variant_id,price_id,session_id,buyer_user_id,request_id,payment_id,quantity,amount,currency,starts_at,ends_at,status,expires_at,created_at,assigned_member_id,location_id,timezone)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,s.starts_at,s.ends_at,'active',?,?,${sessionMemberSql('s')},s.location_id,s.timezone FROM product_sessions s JOIN product_booking_configs c ON c.product_id=s.product_id AND c.organization_id=s.organization_id WHERE s.id=? AND s.organization_id=? AND s.product_id=? AND ${allocation.query}`,
        params: [holdId,input.organizationId,input.productId,input.variantId,catalogPriceId,session.id,input.buyerUserId,input.requestId,id,input.quantity,amount,price.currency,expiresAt,now,session.id,input.organizationId,input.productId,...allocation.params!] }
      following.push({ query: "UPDATE product_sessions SET assigned_member_id=(SELECT assigned_member_id FROM payment_checkout_holds WHERE payment_id=?) WHERE id=? AND EXISTS(SELECT 1 FROM payment_checkout_holds WHERE payment_id=? AND status='active')", params:[id,session.id,id] })
    } else {
      if (!reservation || typeof reservation.policy_updated_at !== 'string') throw new Error('The selected reservation policy is missing')
      const allocation = await reservationAllocationPredicate(db, { organizationId: input.organizationId, locationId: input.locationId, startsAt: input.startsAt, endsAt: input.endsAt, timezone: input.timezone, partySize: input.quantity, policyUpdatedAt: reservation.policy_updated_at })
      hold = { query: `INSERT INTO payment_checkout_holds(id,organization_id,location_id,timezone,buyer_user_id,request_id,payment_id,quantity,amount,currency,starts_at,ends_at,status,expires_at,created_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'active',?,? WHERE ${allocation.query}`, params: [holdId,input.organizationId,input.locationId,input.timezone,input.buyerUserId,input.requestId,id,input.quantity,amount,price.currency,input.startsAt,input.endsAt,expiresAt,now,...allocation.params!] }
    }
    const purchase = { title: projectionTitle, tax_code: projectionTaxCode, price, quantity: purchaseQuantity, automatic_tax: automaticTax, method_configuration_id: methodConfigurationId, request_fingerprint: input.requestFingerprint, billing_fx: billingFx,
      ...(input.subjectType === 'booking' ? { product_id: input.productId, variant_id: input.variantId, session_id: input.sessionId } : { reservation }) }
    try { await executeBatch(db,[
      { query: `INSERT INTO payments(id,organization_id,buyer_user_id,stripe_account_id,livemode,subject_type,subject_id,location_id,currency,amount,price_snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, params:[id,input.organizationId,input.buyerUserId,connected.stripeAccountId,Number(connected.livemode),input.subjectType,null,input.subjectType === 'booking' ? session!.location_id : input.locationId,price.currency,amount,JSON.stringify(purchase),now,now] },
      hold, ...following,
      {query:`INSERT INTO payment_attempts(id,payment_id,idempotency_key,return_token,status,expires_at,created_at,updated_at) SELECT ?,?,?,?,'creating',?,?,? WHERE EXISTS(SELECT 1 FROM payment_checkout_holds WHERE payment_id=? AND status='active')`,params:[attemptId,id,key,returnToken,expiresAt,now,now,id]},
      ...input.following(id),
      {query:'INSERT INTO payment_claims(token_hash,payment_id,expires_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM payment_attempts WHERE id=?)',params:[returnHash,id,new Date(Date.now()+86400000).toISOString(),attemptId]},
    ],{operation:'Reserve payment checkout'})
    } catch(error) {
      const raced=await queryFirst(db,'SELECT id FROM payment_attempts WHERE idempotency_key=?',[key])
      if(raced && !retry) return await createPaymentCheckout(db,stripe,env,input,true)
      throw error
    }
    const attempt = await queryFirst(db,'SELECT id FROM payment_attempts WHERE id=?',[attemptId])
    if (!attempt) {
      await execute(db,"UPDATE payments SET state='failed',updated_at=? WHERE id=?",[now,id])
      throw new HTTPError({statusCode:409,statusMessage:'This time no longer has capacity for your party'})
    }
  }
  // A signed-in buyer's Customer at this business: Stripe's Checkout offers, saves and removes their cards here only.
  const customer=input.buyerUserId?await connectedBuyerCustomer(db,stripe,input.buyerUserId,connected.stripeAccountId,connected.livemode):null
  let opened:string
  try {
  const checkout = await stripe.checkout.sessions.create({mode:'payment',integration_identifier:'krabiclaw_payments_aqpfkmvz',...(customer?{customer:customer.customerId,saved_payment_method_options:{payment_method_save:'enabled' as const,payment_method_remove:'enabled' as const,allow_redisplay_filters:['always' as const]}}:{}),automatic_tax:{enabled:automaticTax},line_items:[{price_data:{currency:price.currency.toLowerCase(),unit_amount:price.unit_amount,tax_behavior:price.tax_behavior,product_data:{name:projectionTitle,...(projectionTaxCode?{tax_code:projectionTaxCode}:{}),metadata:input.subjectType === 'booking' ? {krabiclaw_variant_id:input.variantId} : {krabiclaw_location_id:input.locationId}}},quantity:purchaseQuantity}],payment_method_configuration:methodConfigurationId,
    payment_intent_data:{application_fee_amount:0,metadata:{krabiclaw_payment_id:id}},metadata:{krabiclaw_payment_id:id},client_reference_id:id,
    expires_at:Math.floor(Date.parse(expiresAt)/1000),success_url:new URL(`/account?payment_id=${encodeURIComponent(id)}&purchase_claim=${encodeURIComponent(returnToken)}`,origin).toString(),cancel_url:new URL('/account?payment=cancelled',origin).toString(),
  },{stripeAccount:connected.stripeAccountId,idempotencyKey:key})
  if (!checkout.url || checkout.livemode !== connected.livemode) throw new Error('Stripe Checkout returned invalid scoped handoff')
  await execute(db,`UPDATE payment_attempts SET stripe_checkout_id=?,checkout_url=?,status='open',error=NULL,updated_at=? WHERE id=?`,[checkout.id,checkout.url,new Date().toISOString(),attemptId])
  opened=checkout.url
  } catch(error) {
    // A prior attempt may have reached Stripe even when its handoff was lost.
    // Only a first-call content/auth rejection proves no Checkout was created.
    const rejected=!previous&&(error instanceof stripe.errors.StripeInvalidRequestError||error instanceof stripe.errors.StripeAuthenticationError||error instanceof stripe.errors.StripePermissionError)&&error.headers?.['stripe-should-retry']!=='true'
    const failedAt=new Date().toISOString()
    await executeBatch(db,[
      {query:"UPDATE payment_attempts SET error=?,updated_at=?,status=CASE WHEN ? THEN 'failed' ELSE status END WHERE id=?",params:[error instanceof Error?error.message.slice(0,500):'Provider checkout failed',failedAt,Number(rejected),attemptId]},
      ...(rejected?[
        {query:"UPDATE payment_checkout_holds SET status='released' WHERE payment_id=? AND status='active'",params:[id]},
        {query:"UPDATE payments SET state='failed',updated_at=? WHERE id=? AND captured_amount=0",params:[failedAt,id]},
      ]:[]),
    ],{operation:'Record rejected or uncertain Checkout creation'})
    throw error
  }
  await recordCheckoutStarted(db, await requirePayment(db,input.organizationId,id), customer?.savedCards ?? 0)
  return {payment_id:id,checkout_url:opened,expires_at:expiresAt}
}
