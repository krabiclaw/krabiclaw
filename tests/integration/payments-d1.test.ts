import { PLATFORM_MESSAGE_AUTHOR_KIND } from '../../shared/messages-contract.ts'
import { OPEN_TERMS, OPEN_TERMS_JSON } from './support/booking-terms.ts'
import { publishedCatalogResponse } from './support/stripe-published-catalog.ts'
import assert from 'node:assert/strict'
import { nameConversationBooking } from './support/booking-state.ts'
import { captureEvents } from './support/events.ts'
import test, { type TestContext } from 'node:test'
import Stripe from 'stripe'
import { HTTPError } from 'nitro'
import { Miniflare } from 'miniflare'
import { bindDatabaseEvents } from '../../server/db/index.ts'
import { claimSessionCapacity, listBookableSessions, setProductBookingConfig } from '../../server/utils/availability.ts'
import { createProductBooking, quoteTimedBooking } from '../../server/domain/product-bookings.ts'
import publicBookingRoute from '../../server/api/public/products/[slug]/book.post.ts'
import { projectStripeConnectedAccount, reserveStripeConnectedAccount } from '../../server/utils/stripe-connect.ts'
import { H3Event } from 'h3'
import { ingestStripeFeeReport, stripeFeeMinor, stripeFeeScaled } from '../../server/domain/payments/costs.ts'
import { buyerActivities, buyerPaymentActivityPath, claimCheckoutReturn, tokenHash } from '../../server/domain/payments/buyer.ts'
import { loadBuyerBookingDetails } from '../../server/utils/dashboard-booking-details.ts'
import { cancelBookingRequest, requestInsertQueries, threadPayloadForGuest } from '../../server/domain/requests.ts'
import { appendMessage, markConversationRead, readGuestConversation, resolveConversationAccess } from '../../server/domain/conversations.ts'
import { transferBookingGuestSeat } from '../../server/domain/conversation-participants.ts'
import { conversationPageFor } from './support/conversation-page.ts'
import { archiveConversation, listConversations } from '../../server/domain/guest-threads/repository.ts'
import { sendConversationMessage } from '../../server/domain/send-conversation-message.ts'
import { retainPaymentsForTenantDeletion } from '../../server/domain/payments/retention.ts'
import { deliverPaymentsUsage, paymentsUsage } from '../../server/domain/payments/usage.ts'
import { storeIntegration, readIntegration } from '../../server/utils/organization-integrations.ts'
import { releaseIntegration } from '../../server/utils/integration-release.ts'
import { hashPassword } from 'better-auth/crypto'
import { H3 } from 'nitro/h3'
import { createAuth } from '../../server/utils/auth.ts'
import paymentCancelRoute from '../../server/api/public/payments/[payment_id]/cancel.post.ts'
import paymentConfirmRoute from '../../server/api/public/payments/[payment_id]/confirm.post.ts'
import paymentHandoffRoute from '../../server/api/public/payments/[payment_id].get.ts'
import { readHomeCalendar } from '../../server/domain/stays.ts'
import bookingReceiptRoute from '../../server/api/public/booking-requests/[conversation_id].get.ts'
import { createReplayableReservationCancelToken, hashReservationCancelToken } from '../../server/utils/reservation-cancel-token.ts'
import { getStripe } from '../../server/utils/billing.ts'
import { executeGuestThreadOperation } from '../../server/domain/guest-threads/operations.ts'
import { approveRefundAuthorization, requirePayment } from '../../server/domain/payments/index.ts'
import { paymentTransactionDestination } from '../../server/domain/payments/earnings.ts'
import { completePaymentReturn, reviewPayment, confirmPayment, paymentHandoff, preparePaymentReturn, requireClaimedPayment } from '../../server/domain/payments/intent.ts'
import { reconcilePaymentIntent, processPaymentEvent } from '../../server/domain/payments/events.ts'
import { mcpFinancialApprovalErrorResult } from '../../server/utils/mcp-financial-handoff.ts'
import { handlePaymentsTools } from '../../server/utils/mcp-tools/payments.ts'
import { NOT_HANDLED } from '../../server/utils/mcp-tools/execution.ts'
import { resolveOrganizationMembership } from '../../server/utils/member-access.ts'
import { getRequestDataMetrics, instrumentD1 } from '../../server/utils/request-metrics.ts'
import { openPaymentReturnDocument, paymentReturnDocumentGuard, sealPaymentReturnDocument } from '../../server/utils/payment-return-document.ts'
import type { McpOrganizationContext } from '../../server/utils/mcp-auth.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { applySchema } from './support/schema.ts'
const ORG = 'payments-org', NOW = '2026-10-01T00:00:00.000Z'
async function boot(){
 const runtime=new Miniflare({workers:[{config:{name:'payments-proof',compatibilityDate:'2024-11-01',manifest:{mainModule:'index.mjs',modules:{'index.mjs':{type:'esm',contents:'export class Hub { fetch(){return new Response(null,{status:204})} } export default {fetch(){return new Response("ok")}}'}}},exports:{Hub:{type:'durable-object',storage:'sqlite'}},env:{DB:{type:'d1'},ORGANIZATION_CACHE:{type:'kv'},GUEST_INBOX_HUBS:{type:'durable-object',worker:'payments-proof',exportName:'Hub'}}}}]})
 const db=await runtime.getD1Database('DB')
 try {
 await applySchema(db)
 // A business taking payments is billed for them on its plan's Stripe customer, and the platform site records what it billed.
 await db.prepare(`INSERT INTO organization(id,name,slug,subdomain,settings_json,theme_id,default_currency,status,onboarding_status,url_structure,vertical,updated_at, timezone, "stripeCustomerId") VALUES(?,'Payments','payments','payments','{}','theme','USD','active','complete','flat','experience',?, 'America/New_York','cus_operating')`).bind(ORG,NOW).run()
 await db.prepare(`INSERT INTO organization(id,name,slug,subdomain,settings_json,theme_id,default_currency,status,onboarding_status,url_structure,vertical,updated_at,timezone) VALUES('platform','Blawby','platform','blawby','{}','blawby-theme-v1','USD','active','complete','flat','service',?,'America/Los_Angeles')`).bind(NOW).run()
 await db.prepare("INSERT INTO organization_locales(id,organization_id,locale,is_source,status) VALUES('payments-en',?,'en',1,'published')").bind(ORG).run()
 for(const id of ['guest','verified','other'])await db.prepare("INSERT INTO user(id,name,email,emailVerified,isAnonymous) VALUES(?,?,?,1,?)").bind(id,id,`${id}@example.com`,Number(id==='guest')).run()
 await db.prepare("INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by) VALUES('service','product',?,'Consultation','consultation','guest','guest')").bind(ORG).run()
 await db.prepare("INSERT INTO product_variants(id,organization_id,product_id,name,created_by,updated_by) VALUES('variant',?,'product','Hour','guest','guest')").bind(ORG).run()
 // Held online by its provider, in the provider's own hours.
 await db.prepare("INSERT INTO user(id,name,email,emailVerified) VALUES('host','Host','host@example.com',1)").run()
 await db.prepare("INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES('host-member',?,'host','member',1)").bind(ORG).run()
 await db.prepare(`INSERT INTO member_scheduling(member_id, organization_id, public_name, public_approved, timezone, weekly_json, time_off_json, updated_at, updated_by) VALUES('host-member',?,'Attorney Host',1,'America/New_York','[{"weekday":0,"start":"00:00","end":"23:59"},{"weekday":1,"start":"00:00","end":"23:59"},{"weekday":2,"start":"00:00","end":"23:59"},{"weekday":3,"start":"00:00","end":"23:59"},{"weekday":4,"start":"00:00","end":"23:59"},{"weekday":5,"start":"00:00","end":"23:59"},{"weekday":6,"start":"00:00","end":"23:59"}]','[]',?,'host')`).bind(ORG,NOW).run()
 await db.prepare("INSERT INTO product_booking_configs(product_id,organization_id,unit,duration_minutes,default_capacity,confirmation_mode,held_online,scheduling_mode,assigned_member_id,online_payment_required,created_by,updated_by) VALUES('product',?,'slot',60,1,'review',1,'provider','host-member',1,'guest','guest')").bind(ORG).run()
 await db.prepare("INSERT INTO product_sessions(id,organization_id,product_id,timezone,starts_at,ends_at,capacity,status,created_by,updated_by) VALUES('session',?,'product','America/New_York','2099-10-01T13:00:00.000Z','2099-10-01T14:00:00.000Z',1,'scheduled','guest','guest')").bind(ORG).run()
 const events = captureEvents()
 const env={...await runtime.getBindings<CloudflareEnv>(),DB:db,EVENTS:events.binding,EMAIL_REPLY_DOMAIN:'reply.proof.example',BETTER_AUTH_URL:'https://proof.example',BETTER_AUTH_SECRET:'local-proof-secret-long-enough-for-auth',NUXT_PUBLIC_PLATFORM_DOMAIN:'https://proof.example'} as CloudflareEnv
 bindDatabaseEvents(db, env)
 return {db,runtime,env,events}
 }catch(error){await runtime.dispose();throw error}
}
async function payable(db:D1Database,id:string,expires='2099-09-30T00:00:00.000Z'){
 await db.prepare("INSERT INTO payments(id,organization_id,buyer_user_id,stripe_account_id,livemode,subject_type,currency,amount,price_snapshot_json,created_at,updated_at) VALUES(?,?,'guest','acct_seller',0,'booking','USD',10000,?,?,?)").bind(id,ORG,JSON.stringify({title:'Consultation',tax_code:null,price:{unit_amount:10000,currency:'USD',tax_behavior:'exclusive'},quantity:1,automatic_tax:false,method_configuration_id:'pmc_seller',product_id:'product',variant_id:'variant',session_id:'session',policy:{...OPEN_TERMS,payment:{basis:'per_guest',unit_amount:10000,currency:'USD',tax_behavior:'exclusive',min_party_size:null}},answers:[]}),NOW,NOW).run()
 await db.prepare("UPDATE payments SET stripe_payment_intent_id=?,idempotency_key=?,return_token='test-return-proof',checkout_expires_at=? WHERE id=?").bind(`pi_${id}`,`checkout:${id}`,expires,id).run()
 await db.prepare("INSERT INTO payment_checkout_holds(id,organization_id,product_id,variant_id,price_id,session_id,buyer_user_id,payment_id,quantity,amount,currency,starts_at,ends_at,status,expires_at,created_at) VALUES(?,?,'product','variant','price','session','guest',?,1,10000,'USD','2099-10-01T13:00:00.000Z','2099-10-01T14:00:00.000Z','active',?,?)").bind(`h:${id}`,ORG,id,expires,NOW).run()
}

/**
 * The dining room's tables as their booking setup leaves them: one table product at the location,
 * a deposit of $100 charged once per booking, and one 2099 seating with room for one party.
 */
const TABLE_TERMS = { ...OPEN_TERMS, payment: { basis: 'per_booking', unit_amount: 10000, currency: 'USD', tax_behavior: 'exclusive', min_party_size: null } }
async function diningTables(db: D1Database) {
 await db.prepare("INSERT INTO business_locations(id,organization_id,slug,title,status,timezone,opening_hours) VALUES('dining',?,'dining','Dining','active','UTC',?)").bind(ORG, JSON.stringify({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] })).run()
 await db.batch([
  db.prepare("INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by) VALUES('table','tables',?,'Dining tables','tables','host','host')").bind(ORG),
  db.prepare("INSERT INTO product_variants(id,organization_id,product_id,name,created_by,updated_by) VALUES('table-variant',?,'tables','Table','host','host')").bind(ORG),
  db.prepare("INSERT INTO prices(id,organization_id,product_variant_id,currency,unit_amount,tax_behavior,created_by,updated_by) VALUES('table-price',?,'table-variant','USD',10000,'exclusive','host','host')").bind(ORG),
  db.prepare("INSERT INTO product_locations(organization_id,product_id,location_id,active,published,created_by,updated_by) VALUES(?,'tables','dining',1,1,'host','host')").bind(ORG),
  db.prepare("INSERT INTO product_booking_configs(product_id,organization_id,unit,duration_minutes,seating_interval_minutes,default_capacity,confirmation_mode,held_online,scheduling_mode,assigned_member_id,online_payment_required,payment_basis,created_by,updated_by) VALUES('tables',?,'slot',120,30,1,'instant',0,'business','host-member',1,'per_booking','host','host')").bind(ORG),
  db.prepare("INSERT INTO product_sessions(id,organization_id,product_id,location_id,timezone,starts_at,ends_at,capacity,status,created_by,updated_by) VALUES('seating',?,'tables','dining','UTC','2099-10-01T13:00:00.000Z','2099-10-01T15:00:00.000Z',1,'scheduled','host','host')").bind(ORG),
 ])
}
const seatingRemaining = async (db: D1Database) => db.prepare("SELECT s.capacity - COALESCE((SELECT SUM(b.party_size) FROM bookings b WHERE b.product_session_id = s.id AND b.status IN ('pending','confirmed')), 0) AS remaining FROM product_sessions s WHERE s.id = 'seating'").first<number>('remaining')

/** A table booked with its deposit captured: the guest's request, the deposit Stripe charged, and the booking it made. */
async function paidTable(db: D1Database, env: CloudflareEnv, key: string) {
 const opening = { id: `${key}-request`, kind: 'booking' as const, organization_id: ORG, location_id: 'dining', user_id: 'verified', booking_id: null, payload: { ...threadPayloadForGuest({ name: 'Verified', email: 'verified@example.com', phone: '+12025550123' }), cancellation: { token_hash: `${key}-token-hash`, expires_at: '2100-01-01T00:00:00.000Z', used_at: null } }, created_at: NOW }
 await db.batch(requestInsertQueries(opening).map(write => db.prepare(write.query).bind(...write.params)))
 const booking = await claimSessionCapacity(db, { websiteSource: null, policyJson: JSON.stringify(TABLE_TERMS), env, organizationId: ORG, productId: 'tables', sessionId: 'seating', productVariantId: 'table-variant', partySize: 1, userId: 'verified' })
 await nameConversationBooking(db, opening.id, booking.bookingId)
 await db.prepare("INSERT INTO payments(id,organization_id,buyer_user_id,stripe_account_id,livemode,subject_type,subject_id,location_id,currency,amount,tax_amount,captured_amount,stripe_payment_intent_id,stripe_charge_id,price_snapshot_json,created_at,updated_at) VALUES(?,?,'verified','acct_seller',0,'booking',?,'dining','USD',10000,500,10500,?,?,?,?,?)")
  .bind(key, ORG, booking.bookingId, `pi_${key}`, `ch_${key}`, JSON.stringify({ title: 'Dining tables', tax_code: null, price: { unit_amount: 10000, currency: 'USD', tax_behavior: 'exclusive' }, quantity: 1, automatic_tax: false, method_configuration_id: 'pmc_seller', policy: TABLE_TERMS }), NOW, NOW).run()
 await db.prepare("INSERT INTO payment_checkout_holds(id,organization_id,product_id,variant_id,price_id,session_id,location_id,timezone,buyer_user_id,conversation_id,payment_id,quantity,amount,currency,starts_at,ends_at,status,expires_at,created_at,converted_booking_id) VALUES(?,?,'tables','table-variant','table-price','seating','dining','UTC','verified',?,?,1,10000,'USD','2099-10-01T13:00:00.000Z','2099-10-01T15:00:00.000Z','converted','2100-01-01T00:00:00.000Z',?,?)").bind(`${key}-hold`, ORG, opening.id, key, NOW, booking.bookingId).run()
 return { id: opening.id, organizationId: ORG, kind: 'booking' as const, env, bookingId: booking.bookingId }
}

test('guest table cancellation refunds until 24 hours before the start, through Stripe full remaining refund for both buyer and token credentials', { timeout: 120_000 }, async t => {
 const { db, runtime, env: bootEnv } = await boot()
 try {
  const env = { ...bootEnv, BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-proof-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only', STRIPE_SECRET_KEY: 'sk_test_local_boundary' }
  await diningTables(db)
  // Each cancellation frees the one seating for the next.
  for (const credential of ['buyer', 'token'] as const) {
   for (const policy of [{ now: '2099-09-30T13:00:00.000Z', refundable: true }, { now: '2099-09-30T13:00:00.001Z', refundable: false }]) {
    const key = `${credential}-${policy.refundable ? 'early' : 'late'}`
    const paid = await paidTable(db, env, key)
    const input = { ...paid, ...(credential === 'buyer' ? { buyerUserId: 'verified' } : { tokenHash: `${key}-token-hash` }), now: policy.now }
    const originalFetch = globalThis.fetch
    const refundKey = `guest-cancelled-booking:${paid.bookingId}`
    const replay = credential === 'token' && policy.refundable
    let earlierRefundId: string | null = null
    const metadataRequests: string[] = []
    const fetchMock = t.mock.method(globalThis, 'fetch', async (request, init) => {
     const url = new URL(request instanceof Request ? request.url : String(request))
     if (url.origin !== 'https://api.stripe.com') return originalFetch(request, init)
     assert.equal(new Headers(init?.headers).get('stripe-account'), 'acct_seller')
     if (url.pathname === '/v1/refunds' && init?.method === 'POST') {
      const params = new URLSearchParams(String(init.body))
      assert.equal(params.get('payment_intent'), `pi_${key}`)
      assert.equal(params.has('amount'), false)
      assert.equal(new Headers(init.headers).get('idempotency-key'), `krabiclaw-refund:${key}:${refundKey}`)
      const field = params.has('metadata[blawby_refund_id]') ? 'blawby_refund_id' : 'krabiclaw_refund_id'
      const sentId = params.get(`metadata[${field}]`)
      assert.ok(sentId)
      metadataRequests.push(field)
      if (replay && earlierRefundId === null) {
       earlierRefundId = sentId
       return Response.json({ error: { type: 'invalid_request_error', message: 'Stripe refund response unavailable' } }, { status: 400 })
      }
      if (replay) {
       assert.equal(sentId, earlierRefundId)
       if (field === 'blawby_refund_id') return Response.json({ error: { type: 'idempotency_error', message: 'Parameters already used with this key differ' } }, { status: 400 })
      }
      return Response.json({ id: `re_${key}`, object: 'refund', amount: 10500, currency: 'usd', status: 'succeeded', payment_intent: `pi_${key}`, reason: 'requested_by_customer', metadata: { [field]: sentId } })
     }
     assert.equal(init?.method, 'GET')
     assert.equal(url.pathname, `/v1/charges/ch_${key}`)
     return Response.json({ id: `ch_${key}`, object: 'charge', livemode: false, amount: 10500, amount_refunded: 10500, currency: 'usd', payment_intent: `pi_${key}`, billing_details: { email: 'verified@example.com' } })
    })
    try {
     assert.equal(await seatingRemaining(db), 0)
     if (replay) await assert.rejects(() => cancelBookingRequest(db, input), /Stripe refund response unavailable/u)
     assert.equal((await cancelBookingRequest(db, input))?.changed, !replay)
     assert.deepEqual(await db.prepare('SELECT status,cancellation_reason FROM bookings WHERE id=?').bind(paid.bookingId).first(), { status: 'cancelled', cancellation_reason: 'guest_cancelled' })
     assert.equal(await db.prepare("SELECT json_extract(payload_json,'$.cancellation.used_at') used_at FROM conversations WHERE id=?").bind(paid.id).first('used_at'), policy.now)
     assert.deepEqual(await db.prepare('SELECT refunded_amount FROM payments WHERE id=?').bind(key).first(), { refunded_amount: policy.refundable ? 10500 : 0 })
     assert.deepEqual((await db.prepare('SELECT amount,status,created_by FROM payment_refunds WHERE payment_id=?').bind(key).all()).results, policy.refundable ? [{ amount: 10500, status: 'succeeded', created_by: credential === 'buyer' ? 'verified' : null }] : [])
     assert.deepEqual(metadataRequests, !policy.refundable ? [] : replay ? ['blawby_refund_id', 'blawby_refund_id', 'krabiclaw_refund_id'] : ['blawby_refund_id'])
     assert.equal(await seatingRemaining(db), 1)
    } finally { fetchMock.mock.restore() }
   }
  }
 } finally { await runtime.dispose() }
})

test('a table deposit is the table price once, only for parties at its threshold, and a booking keeps the terms it was made with', { timeout: 120_000 }, async t => {
 t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
 const { db, runtime, env: bootEnv } = await boot()
 try {
  const env = { ...bootEnv, BETTER_AUTH_URL: 'https://payments.proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-proof-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only',
    STRIPE_SECRET_KEY: 'sk_live_mock', STRIPE_TEST_SECRET_KEY: 'sk_test_local_boundary', STRIPE_TEST_PUBLISHABLE_KEY: 'pk_test_mock', STRIPE_TEST_PAYMENTS_METHOD_CONFIGURATION: 'pmc_parent' } as CloudflareEnv
  await diningTables(db)
  // Tables for twenty, a $100 deposit from parties of six, and a seating tomorrow.
  const soon = new Date(Date.now() + 26 * 3_600_000)
  soon.setUTCMinutes(0, 0, 0)
  await db.batch([
   db.prepare("UPDATE product_booking_configs SET default_capacity=20,payment_min_party_size=6 WHERE product_id='tables'"),
   db.prepare("INSERT INTO product_publications(organization_id,product_id,published,created_by,updated_by) VALUES(?,'tables',1,'host','host')").bind(ORG),
   db.prepare("INSERT INTO product_sessions(id,organization_id,product_id,location_id,timezone,starts_at,ends_at,capacity,status,created_by,updated_by) VALUES('soon',?,'tables','dining','UTC',?,?,20,'scheduled','host','host')").bind(ORG, soon.toISOString(), new Date(soon.getTime() + 7_200_000).toISOString()),
  ])
  const event = (path: string) => new H3Event(Object.assign(new Request(`https://payments.proof.example${path}`), { runtime: { cloudflare: { env } } }))
  const counts = async () => db.prepare('SELECT (SELECT COUNT(*) FROM bookings) bookings,(SELECT COUNT(*) FROM conversations) requests,(SELECT COUNT(*) FROM payments) payments,(SELECT COUNT(*) FROM payment_checkout_holds) holds').first()

  // A party of six pays the deposit: the business's assistant cannot take that money and books nothing.
  const before = await counts()
  await assert.rejects(createProductBooking(event('/api/mcp'), { organizationId: ORG, slug: 'tables', financialWritesAllowed: false,
   operator: { userId: 'host', idempotencyKey: 'six', source: 'operator', externalReference: null, guestAcknowledgement: false },
   body: { guest_name: 'Six', guest_email: 'six@example.com', guest_phone: '+12025550123', product_session_id: 'soon', party_size: 6 } }),
  (error: HTTPError) => error.statusCode === 409 && (error.data as { code?: string }).code === 'financial_action_required')
  assert.deepEqual(await counts(), before)

  // A party of five books on the site without paying, told the deposit it would owe as a party of six: the price once, not per guest.
  const five = await createProductBooking(event('/api/public/products/tables/bookings'), { organizationId: ORG, slug: 'tables',
   body: { guest_name: 'Five', guest_email: 'five@example.com', guest_phone: '+12025550123', product_session_id: 'soon', party_size: 5, idempotency_key: 'five' } })
  assert.equal(five.status, 201, JSON.stringify(five.body))
  const booked = five.body.policy_summary as { heading: string; items: Array<{ id: string; text: string }> }
  assert.deepEqual(booked.items.map(item => item.id), ['cancellation', 'deposit', 'deposit_amount'])
  assert.match(booked.items[1]!.text, /\b6\b/u)
  assert.match(booked.items[2]!.text, /\$100\.00/u)
  assert.deepEqual(await db.prepare('SELECT COUNT(*) n FROM payments').first('n'), 0)

  const publicApp = new H3()
  publicApp.use(event => { event.context.organizationId = ORG })
  publicApp.post('/api/public/products/:slug/book', publicBookingRoute)
  const bookFromSameIp = (attempt: number) => publicApp.request(Object.assign(new Request('https://payments.proof.example/api/public/products/tables/book', {
   method: 'POST',
   headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.40' },
   body: JSON.stringify({ guest_name: 'Repeat guest', guest_email: 'repeat@example.com', guest_phone: '+12025550123', product_session_id: 'soon', party_size: 1, idempotency_key: `repeat-${attempt}` }),
  }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
  const bookingsBeforeRepeat = await counts()
  for (let attempt = 1; attempt <= 5; attempt++) {
   const response = await bookFromSameIp(attempt)
   assert.equal(response.status, 201, await response.clone().text())
  }
  const blocked = await bookFromSameIp(6)
  assert.equal(blocked.status, 429)
  assert.deepEqual(await blocked.json(), { error: 'Too many requests. Please try again later.' })
  assert.deepEqual(await counts(), {
   ...bookingsBeforeRepeat,
   bookings: Number(bookingsBeforeRepeat?.bookings) + 5,
   requests: Number(bookingsBeforeRepeat?.requests) + 5,
  })

  // The configured demo business can start a real checkout for the projected next seating.
  await db.prepare("UPDATE organization SET subdomain='demo' WHERE id=?").bind(ORG).run()
  await db.prepare("INSERT INTO subscription(id,plan,referenceId,status,seats) VALUES('test-plan','business',?,'active',1)").bind(ORG).run()
  const reserved = await reserveStripeConnectedAccount(db, { organizationId: ORG, livemode: false })
  await projectStripeConnectedAccount(db, { reservationId: reserved.id, organizationId: ORG, stripeAccountId: 'acct_seller', country: 'TH', livemode: false, cardPaymentsStatus: 'active', cardPaymentsResolutions: [], requirements: [], stripeRefreshedAt: new Date().toISOString() })
  const realFetch = globalThis.fetch
  let intents = 0
  t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
   const url = new URL(request instanceof Request ? request.url : String(request))
   if (url.origin !== 'https://api.stripe.com') return realFetch(request, init)
   if (url.pathname === '/v2/core/accounts/acct_seller') return Response.json({ id: 'acct_seller', livemode: false, dashboard: 'express', identity: { country: 'TH' }, defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'stripe' } }, configuration: { merchant: { capabilities: { card_payments: { status: 'active', status_details: [] } } } }, requirements: { entries: [] } })
   if (url.pathname === '/v1/payment_method_configurations') return Response.json({ data: [{ id: 'pmc_child', parent: 'pmc_parent', active: true }], has_more: false })
   assert.equal(`${init?.method} ${url.pathname}`, 'POST /v1/payment_intents')
   assert.equal(new URLSearchParams(String(init?.body)).get('amount'), '10000')
   intents++
   return Response.json({ id: 'pi_table_deposit', client_secret: 'pi_table_deposit_secret', livemode: false })
  })
  const nextTime = new Date(soon.getTime() + 30 * 60_000).toISOString()
  const [session] = await listBookableSessions(db, { env, organizationId: ORG, productId: 'tables', fromInstant: nextTime, toInstant: new Date(Date.parse(nextTime) + 1).toISOString() })
  assert(session)
  const quote = await quoteTimedBooking(db, env, { organizationId: ORG, slug: 'tables', product_session_id: session.id, party_size: 6 })
  assert.equal(quote.total_minor, 10_000)
  assert.equal(await db.prepare('SELECT id FROM product_sessions WHERE id=?').bind(session.id).first('id'), null)
  const paidInput = { organizationId: ORG, slug: 'tables',
   operator: { userId: 'host', idempotencyKey: 'six-paid', source: 'operator', externalReference: null, guestAcknowledgement: false },
   body: { guest_name: 'Six', guest_email: 'six@example.com', guest_phone: '+12025550123', product_session_id: session.id, party_size: 6 } }
  const paid = await createProductBooking(event('/api/dashboard/bookings'), paidInput)
  assert.equal(paid.status, 201, JSON.stringify(paid.body))
  assert.deepEqual(await db.prepare('SELECT h.session_id, h.quantity, h.amount, s.starts_at FROM payment_checkout_holds h JOIN product_sessions s ON s.id=h.session_id WHERE h.payment_id=?').bind(paid.body.payment_id).first(),
   { session_id: session.id, quantity: 6, amount: 10_000, starts_at: nextTime })

  // The business later asks two days' notice and caps parties at four.
  await setProductBookingConfig(db, { organizationId: ORG, productId: 'tables', actorId: 'host', env, patch: { advance_notice_minutes: 2880, party_size_max: 4 } })
  const replay = await createProductBooking(event('/api/dashboard/bookings'), paidInput)
  assert.equal(replay.status, 200, JSON.stringify(replay.body))
  assert.deepEqual({ payment: replay.body.payment_id, claim: replay.body.purchase_claim, intents }, { payment: paid.body.payment_id, claim: paid.body.purchase_claim, intents: 1 })

  // The guest's receipt, read back through the business's receipt endpoint, still states the terms they booked.
  const app = new H3()
  app.use((event) => { event.context.organizationId = ORG })
  app.get('/api/public/booking-requests/:conversation_id', bookingReceiptRoute)
  const read = await app.request(Object.assign(new Request(`https://payments.proof.example/api/public/booking-requests/${String(five.body.conversation_id)}`, { headers: { authorization: `Bearer ${String(five.body.cancellation_token)}` } }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
  assert.equal(read.status, 200, await read.clone().text())
  const receipt = (await read.json() as { booking: { guests: string; policy_summary: unknown; advance_notice_minutes: number | null } }).booking
  assert.deepEqual([receipt.guests, receipt.policy_summary, receipt.advance_notice_minutes], ['5', booked, null])
  // And they can still cancel it online tomorrow's seating, as the terms they booked allow.
  const cancelled = await cancelBookingRequest(db, { id: String(five.body.conversation_id), organizationId: ORG, kind: 'booking', now: new Date().toISOString(), env, tokenHash: await hashReservationCancelToken(String(five.body.cancellation_token)) })
  assert.equal(cancelled?.changed, true)
  assert.equal(await db.prepare('SELECT status FROM bookings WHERE id=?').bind(String(five.body.booking_id)).first('status'), 'cancelled')

 } finally { await runtime.dispose() }
})

test('a checkout thread stays out of Messages until payment creates its booking', { timeout: 120_000 }, async () => {
 const { db, runtime, env } = await boot()
 try {
  const provenance = { source: 'website', external_reference: null, actor_user_id: null, idempotency_key: 'checkout-key', fingerprint: 'checkout-fingerprint', guest_acknowledgement: true, creation_kind: 'checkout' as const, creation_status: 'confirmed' as const, followups_completed: false }
  await db.batch([
    db.prepare("INSERT INTO user(id,name,email,emailVerified) VALUES('owner-reader','Owner','owner-reader@example.com',1)"),
    db.prepare("INSERT INTO member(id,organizationId,userId,role) VALUES('owner-reader-member',?,'owner-reader','owner')").bind(ORG),
  ])
  const opening = { id: 'checkout-request', kind: 'booking' as const, organization_id: ORG, location_id: null, user_id: 'verified', booking_id: null, payload: { ...threadPayloadForGuest({ name: 'Verified', email: 'verified@example.com' }), provenance }, created_at: NOW }
  await db.batch(requestInsertQueries(opening, undefined, { opening: 'Class for 1 guest', note: 'A note before paying' }).map(write => db.prepare(write.query).bind(...write.params)))
  const owner = async () => (await listConversations(db, ORG, { userId: 'owner-reader' })).map(row => row.id)
  const buyer = async () => (await listConversations(db, null, { userId: 'verified', buyerAudience: true })).map(row => row.id)
  assert.deepEqual([await owner(), await buyer()], [[], []])
  await nameConversationBooking(db, opening.id, (await claimSessionCapacity(db, { websiteSource: null, policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: 'product', sessionId: 'session', productVariantId: 'variant', partySize: 1, userId: 'verified' })).bookingId)
  assert.deepEqual([await owner(), await buyer()], [[opening.id], [opening.id]])
 } finally { await runtime.dispose() }
})

test('an advance notice closes a guest\'s own class cancellation at the notice, refunds until the longer of it and 24 hours, and no notice keeps cancellation open until the end', { timeout: 120_000 }, async t => {
 const HOUR = 3_600_000
 // [notice minutes, now relative to the start, cancelled, refunded]
 const cases: Array<[number | null, number, boolean, boolean]> = [[2880, -48 * HOUR - 1, true, true], [2880, -48 * HOUR + 1, false, false], [120, -24 * HOUR, true, true], [120, -12 * HOUR, true, false], [120, -2 * HOUR + 1, false, false], [null, 30 * 60_000, true, false]]
 const { db, runtime, env: bootEnv } = await boot()
 try {
  const env = { ...bootEnv, BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-proof-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only', STRIPE_SECRET_KEY: 'sk_test_local_boundary' }
  // Every case books its own seat in the one class; a refused cancellation keeps its seat.
  await db.prepare("UPDATE product_sessions SET capacity=? WHERE id='session'").bind(cases.length).run()
  const startsAt = await db.prepare("SELECT starts_at FROM product_sessions WHERE id='session'").first<string>('starts_at')
  assert(startsAt)
  for (const [index, [notice, offset, open, refunded]] of cases.entries()) {
   const key = `notice-${index}`
   const opening = { id: `${key}-request`, kind: 'booking' as const, organization_id: ORG, location_id: null, user_id: 'verified', booking_id: null, payload: threadPayloadForGuest({ name: 'Verified', email: 'verified@example.com' }), created_at: NOW }
   await db.batch(requestInsertQueries(opening).map(write => db.prepare(write.query).bind(...write.params)))
   // The notice is part of the terms the guest booked under, frozen on the booking.
   const booking = await claimSessionCapacity(db, { websiteSource: null, policyJson: JSON.stringify({ ...OPEN_TERMS, advance_notice_minutes: notice }), env, organizationId: ORG, productId: 'product', sessionId: 'session', productVariantId: 'variant', partySize: 1, userId: 'verified' })
   await nameConversationBooking(db, opening.id, booking.bookingId)
   await payable(db, key)
   await db.prepare("UPDATE payments SET buyer_user_id='verified',subject_id=?,captured_amount=10000,stripe_payment_intent_id=?,stripe_charge_id=? WHERE id=?").bind(booking.bookingId, `pi_${key}`, `ch_${key}`, key).run()
   await db.prepare("UPDATE payment_checkout_holds SET buyer_user_id='verified',conversation_id=?,status='converted',converted_booking_id=? WHERE payment_id=?").bind(opening.id, booking.bookingId, key).run()
   const now = new Date(Date.parse(startsAt) + offset).toISOString()
   const originalFetch = globalThis.fetch
   let creations = 0
   const fetchMock = t.mock.method(globalThis, 'fetch', async (request, init) => {
    const url = new URL(request instanceof Request ? request.url : String(request))
    if (url.origin !== 'https://api.stripe.com') return originalFetch(request, init)
    if (url.pathname === '/v1/refunds' && init?.method === 'POST') {
     creations++
     const params = new URLSearchParams(String(init.body))
     // A full remaining refund of the booking's own payment: Stripe decides what is left.
     assert.equal(params.get('payment_intent'), `pi_${key}`)
     assert.equal(params.has('amount'), false)
     return Response.json({ id: `re_${key}`, object: 'refund', amount: 10000, currency: 'usd', status: 'succeeded', payment_intent: `pi_${key}`, reason: 'requested_by_customer', metadata: { krabiclaw_refund_id: params.get('metadata[blawby_refund_id]') } })
    }
    return Response.json({ id: `ch_${key}`, object: 'charge', livemode: false, amount: 10000, amount_refunded: 10000, currency: 'usd', payment_intent: `pi_${key}`, billing_details: { email: 'verified@example.com' } })
   })
   try {
    const cancel = cancelBookingRequest(db, { id: opening.id, organizationId: ORG, kind: 'booking', now, env, buyerUserId: 'verified' })
    if (open) assert.equal((await cancel)?.changed, true)
    else await assert.rejects(cancel, (error: HTTPError) => error.statusCode === 409 && (error.data as { code?: string }).code === 'cancellation_closed' && error.message.includes(`closed ${notice === 2880 ? '2 days' : '2 hours'} before the start`))
    assert.deepEqual(await db.prepare('SELECT status,cancellation_reason FROM bookings WHERE id=?').bind(booking.bookingId).first(), open ? { status: 'cancelled', cancellation_reason: 'guest_cancelled' } : { status: 'pending', cancellation_reason: null })
    assert.equal(await db.prepare("SELECT json_extract(payload_json,'$.cancellation.used_at') used FROM conversations WHERE id=?").bind(opening.id).first('used'), open ? now : null)
    assert.deepEqual(await db.prepare('SELECT refunded_amount FROM payments WHERE id=?').bind(key).first(), { refunded_amount: refunded ? 10000 : 0 })
    assert.equal(creations, Number(refunded))
   } finally { fetchMock.mock.restore() }
  }
 } finally { await runtime.dispose() }
})

test('active and expired checkout records leave session capacity available until a booking claims it', { timeout: 120_000 }, async () => {
 const { db, runtime, env } = await boot()
 try {
  await payable(db, 'open')
  await payable(db, 'expired', '2000-01-01T00:00:00.000Z')
  const claim = () => claimSessionCapacity(db, { websiteSource: null, policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: 'product', sessionId: 'session', productVariantId: 'variant', partySize: 1 })
  const booking = await claim()
  assert.equal(await db.prepare('SELECT party_size FROM bookings WHERE id=?').bind(booking.bookingId).first('party_size'), 1)
  await assert.rejects(claim, /no longer has room/u)
  assert.deepEqual((await db.prepare('SELECT payment_id, status FROM payment_checkout_holds ORDER BY payment_id').all()).results, [
   { payment_id: 'expired', status: 'active' }, { payment_id: 'open', status: 'active' },
  ])
 } finally { await runtime.dispose() }
})

test('MCP paid booking cancellation and rejection hand off without preparing money, while dashboard approval completes once', { timeout: 120_000 }, async () => {
 for (const action of ['cancel', 'reject'] as const) {
  const { db, runtime, env: bootEnv } = await boot()
  try {
   const env = { ...bootEnv, BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-proof-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only', STRIPE_SECRET_KEY: 'sk_test_local_boundary' }
   await db.prepare("INSERT INTO member(id,organizationId,userId,role) VALUES('owner',?,'verified','owner')").bind(ORG).run()
   const opening = { id: 'paid-request', kind: 'booking' as const, organization_id: ORG, location_id: null, user_id: 'guest', booking_id: null, payload: threadPayloadForGuest({ name: 'Guest', email: 'guest@example.com' }), created_at: NOW }
   await db.batch(requestInsertQueries(opening).map(write => db.prepare(write.query).bind(...write.params)))
   const booking = await claimSessionCapacity(db, { websiteSource: null, policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: 'product', sessionId: 'session', productVariantId: 'variant', partySize: 1, userId: 'guest' })
   await nameConversationBooking(db, opening.id, booking.bookingId)
   await payable(db, 'paid')
   await db.prepare("UPDATE payments SET subject_id=?,captured_amount=10000,stripe_payment_intent_id='pi_paid',stripe_charge_id='ch_paid' WHERE id='paid'").bind(booking.bookingId).run()
   await db.prepare("UPDATE payment_checkout_holds SET conversation_id=?,status='converted',converted_booking_id=? WHERE payment_id='paid'").bind(opening.id,booking.bookingId).run()
   const input = { organizationId: ORG, threadId: opening.id, action, actorUserId: 'verified', idempotencyKey: 'same-request', env }
   const tables = ['bookings', 'conversations', 'messages', 'guest_thread_deliveries', 'payments', 'payment_checkout_holds', 'payment_authorizations', 'payment_refunds', 'usage_events']
   const before = await Promise.all(tables.map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results))
   for (let retry = 0; retry < 2; retry++) {
    await assert.rejects(() => executeGuestThreadOperation(db, { ...input, financialWritesAllowed: false }), error => {
     assert(error instanceof HTTPError)
     assert.equal(error.statusCode,409)
     assert.equal(error.data?.code,'financial_action_required')
     const handoff = mcpFinancialApprovalErrorResult(error,env.NUXT_PUBLIC_PLATFORM_DOMAIN,error.statusMessage!)
     assert(handoff)
     assert.equal('structuredContent' in handoff, false)
     assert.deepEqual(JSON.parse(handoff.content[0]!.text), { status: 409, message: error.statusMessage, success: false, operation_completed: false, action_required: true, code: 'financial_action_required', dashboard_url: `https://proof.example/dashboard/payments/bookings/${booking.bookingId}` })
     assert.equal(handoff.isError,true)
     return true
    })
    assert.deepEqual(await Promise.all(tables.map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results)), before)
   }
   let authorizationId = ''
   await assert.rejects(() => executeGuestThreadOperation(db,input), error => {
    assert(error instanceof HTTPError)
    const handoff = mcpFinancialApprovalErrorResult(error,env.NUXT_PUBLIC_PLATFORM_DOMAIN,error.statusMessage!)
    assert(handoff)
    const action = JSON.parse(handoff.content[0]!.text)
    assert.equal(action.operation_completed,false)
    assert.match(action.dashboard_url,/^https:\/\/proof\.example\/dashboard\/payments\/earnings\/refunds\/approve\?id=/u)
    authorizationId = new URL(action.dashboard_url).searchParams.get('id')!
    return true
   })
   assert.equal(await db.prepare('SELECT COUNT(*) n FROM payment_authorizations').first('n'),1)
   const principal = { organizationId: ORG, userId: 'verified', role: 'owner' }
   await approveRefundAuthorization(db,principal,authorizationId)
   const approvedInput = { ...input, financialAuthorizationId: authorizationId }
   const approvedState = await Promise.all(tables.map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results))
   await assert.rejects(() => executeGuestThreadOperation(db,{...approvedInput,financialWritesAllowed:false}), error => {
    assert(error instanceof HTTPError)
    assert.equal(error.data?.code,'financial_action_required')
    return true
   })
   assert.deepEqual(await Promise.all(tables.map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results)),approvedState)
   assert.equal((await executeGuestThreadOperation(db,approvedInput)).ok,true)
   assert.equal((await executeGuestThreadOperation(db,approvedInput)).ok,true)
   assert.equal(await db.prepare('SELECT status FROM bookings WHERE id=?').bind(booking.bookingId).first('status'),'cancelled')
   assert.equal(await db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND event_name=?").bind(opening.id,`booking.${action}`).first('n'),1)
   assert.equal(await db.prepare('SELECT COUNT(*) n FROM guest_thread_deliveries').first('n'),1)
   assert.equal(await db.prepare("SELECT status FROM payment_refunds WHERE payment_id='paid'").first('status'),'queued')
   assert.equal(await db.prepare('SELECT consumed_at FROM payment_authorizations WHERE id=?').bind(authorizationId).first('consumed_at')!==null,true)
  } finally { await runtime.dispose() }
 }
})
test('MCP financial reads return bounded reports and authenticated detail links without bank data, provider mappings, private notes or financial writes', { timeout: 120_000 }, async t => {
 const { db, runtime } = await boot()
 try {
  await db.prepare("INSERT INTO member(id,organizationId,userId,role) VALUES('report-owner',?,'verified','owner')").bind(ORG).run()
  await payable(db,'report')
  await db.prepare("UPDATE payments SET captured_amount=10000,refunded_amount=1000,price_snapshot_json=? WHERE id='report'").bind(JSON.stringify({title:'Original consultation',quantity:1,price:{unit_amount:10000,currency:'USD',type:'one_time',tax_behavior:'exclusive',provider_secret:'private-provider-value'},buyer_email:'private-buyer@example.test'})).run()
  await db.prepare("INSERT INTO payment_refunds(id,payment_id,idempotency_key,amount,reason,note,status,error,created_by,created_at,updated_at) VALUES('report-refund','report','private-retry-key',1000,'requested_by_customer','private-guest-note','succeeded','private-refund-diagnostic','other',?,?)").bind(NOW,NOW).run()
  await db.prepare("INSERT INTO usage_events(id,organization_id,payment_id,resource,unit,quantity,idempotency_key,provider_occurred_at,error,created_at,source) VALUES('report-usage',?,'report','stripe_cost','USD',100,'private-provider-source',?,'private-usage-diagnostic',?,'payments')").bind(ORG,NOW,NOW).run()
  await db.prepare("INSERT INTO stripe_connected_accounts(id,organization_id,stripe_account_id,livemode,country,status,created_at,updated_at) VALUES('report-connected',?,'acct_seller',0,'US','ready',?,?)").bind(ORG,NOW,NOW).run()
  const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_URL:'https://proof.example', BETTER_AUTH_SECRET:'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN:'https://proof.example', STRIPE_SECRET_KEY:'sk_test_local_boundary' }
  const membership = await resolveOrganizationMembership(env,{organizationId:ORG,userId:'verified'})
  assert(membership)
  const organization: McpOrganizationContext = { env,db,userId:'verified',isPlatformAdmin:false,scopes:['organization:read'],organizationId:ORG,organizationSlug:membership.organizationSlug!,role:'owner',membership }
  const call = (toolName:string,args:Record<string,unknown>={}) => handlePaymentsTools({organization,toolName,args}) as Promise<Record<string,unknown>>
  const tables = ['payments','payment_checkout_holds','payment_authorizations','payment_refunds','usage_events','stripe_connected_accounts']
  const before = await Promise.all(tables.map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results))
  const listed = await call('list_payments',{from:'2000-01-01T00:00:00.000Z',to:'2099-01-01T00:00:00.000Z'})
  assert.equal(listed.organization_id,ORG)
  assert.deepEqual((listed.payments as Array<Record<string,unknown>>).map(payment=>({id:payment.id,title:payment.title,currency:payment.currency,captured_amount:payment.captured_amount,refunded_amount:payment.refunded_amount,to:payment.to})),[{id:'report',title:'Original consultation',currency:'USD',captured_amount:10000,refunded_amount:1000,to:'https://proof.example/dashboard/payments/bookings/payment/report'}])
  const detail = await call('get_payment',{payment_id:'report'})
  assert.deepEqual(detail.purchase,{title:'Original consultation',quantity:1,product_id:null,variant_id:null,session_id:null,price:{unit_amount:10000,currency:'USD',type:'one_time',tax_behavior:'exclusive'}})
  assert.deepEqual(detail.refunds,[{id:'report-refund',amount:1000,status:'succeeded'}])
  assert.equal(detail.dashboard_url,'https://proof.example/dashboard/payments/bookings/payment/report')
  assert.equal(await handlePaymentsTools({organization,toolName:'get_payments_usage',args:{}}), NOT_HANDLED)
  // Plan and billing keeps its canonical fee read, while MCP no longer exposes it.
  const usage = await paymentsUsage(db,env,ORG)
  assert.deepEqual(usage.pending,[{currency:'USD',kind:'stripe_cost',event_count:1,amount:100,billing_amount:100,action_required:true}])
  assert.deepEqual({configured:usage.configured,pricing:usage.pricing,source:usage.source},{configured:false,pricing:null,source:'Stripe'})
  const originalFetch = globalThis.fetch
  const payoutReads:string[]=[]
  const fetchMock = t.mock.method(globalThis,'fetch',async (request,init) => {
   const url = new URL(request instanceof Request?request.url:String(request))
   if(url.origin!=='https://api.stripe.com')return originalFetch(request,init)
   assert.equal(init?.method,'GET')
   assert.equal(new Headers(init?.headers).get('stripe-account'),'acct_seller')
   if(url.pathname==='/v1/balance')return Response.json({object:'balance',livemode:false,available:[{currency:'usd',amount:9000,source_types:{card:9000}}],pending:[],connect_reserved:[{currency:'usd',amount:500}],metadata:{private_bank_account:'private-bank-value'}})
   assert.equal(url.pathname,'/v1/payouts')
   payoutReads.push(url.searchParams.get('starting_after')??'first')
   const next = url.searchParams.has('starting_after')
   return Response.json({object:'list',has_more:!next,data:next?[]:[{id:'po_report',object:'payout',livemode:false,amount:9000,currency:'usd',status:'paid',arrival_date:1900000000,created:1899990000,automatic:true,destination:'private-bank-value',metadata:{note:'private-payout-note'}}]})
  })
  let payouts:Record<string,unknown>
  try {
   payouts = await call('get_payment_payouts')
   assert.deepEqual(payouts.balance,{available:[{currency:'USD',amount:9000}],pending:[]})
   assert.equal(payouts.next_cursor,'po_report')
   assert.deepEqual((payouts.payouts as Array<Record<string,unknown>>).map(payout=>({id:payout.id,amount:payout.amount,currency:payout.currency,dashboard_url:payout.dashboard_url})),[{id:'po_report',amount:9000,currency:'USD',dashboard_url:'https://proof.example/dashboard/payments/earnings/payouts/po_report'}])
   assert.deepEqual((await call('get_payment_payouts',{after:'po_report'})).payouts,[])
   assert.deepEqual(payoutReads,['first','po_report'])
  } finally { fetchMock.mock.restore() }
  for(const value of [listed,detail,usage,payouts])assert.doesNotMatch(JSON.stringify(value),/private-|acct_seller|buyer_user_id|stripe_account_id|price_snapshot_json|idempotency_key|created_by|source_types|connect_reserved/u)
  assert.deepEqual(await Promise.all(tables.map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results)),before)
 } finally { await runtime.dispose() }
})
test('Stripe cost report replay and correction bill attributable deltas while conflicting tenant mappings remain unbilled', {timeout:120000},async()=>{
 const {db,runtime}=await boot();try{
  await payable(db,'cost');await db.prepare("UPDATE payments SET stripe_charge_id='ch:cost' WHERE id='cost'").run()
  await db.prepare("INSERT INTO stripe_connected_accounts(id,organization_id,stripe_account_id,livemode,country,status,created_at,updated_at) VALUES('connected',?,'acct_seller',0,'US','ready',?,?)").bind(ORG,NOW,NOW).run()
  await db.prepare("INSERT INTO payment_servicing_tenants(organization_id,stripe_account_id,livemode,retained_at) VALUES('deleted-other-tenant','acct_seller',0,?)").bind(NOW).run()
  const csv=(amount:string)=>`fee_transaction_id,incurred_by,currency,amount,tax,incurred_at\nfee1,ch:cost,usd,${amount},0.20,2026-10-01T00:00:00Z\n,ch:cost,usd,0.600000000000000000,0.000000000000000000,2026-10-01T00:00:00Z\n,ch:cost,usd,0.343000000000000000,0.041160000000000000,2026-10-01T00:00:00Z\nfee2,unknown,usd,5.00,0,2026-10-01T00:00:00Z\nfee3,acct_seller,usd,1.00,0,2026-10-01T00:00:00Z\n`
  await ingestStripeFeeReport(db,false,csv('3.00'));await ingestStripeFeeReport(db,false,csv('3.00'));await ingestStripeFeeReport(db,false,csv('2.00'))
  // Stripe leaves fee_transaction_id blank for a card processing fee netted inside the charge, and itemizes below a cent; those rows share one identity, are summed exactly and rounded once (0.60 + 0.38416 = 0.98416 → 98).
  const events=(await db.prepare("SELECT quantity AS amount,resource AS kind FROM usage_events WHERE provider_occurred_at IS NOT NULL ORDER BY kind,amount").all()).results
  assert.deepEqual(events,[{amount:98,kind:'stripe_cost'},{amount:320,kind:'stripe_cost'},{amount:-100,kind:'stripe_cost_adjustment'}])
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM payment_cost_snapshots WHERE organization_id IS NULL').first('n'),2)
  assert.equal(await db.prepare("SELECT organization_id FROM payment_cost_snapshots WHERE incurred_by='acct_seller'").first('organization_id'),null)
  assert.equal(stripeFeeMinor(stripeFeeScaled('-0.003000000000000000')+stripeFeeScaled('-0.001160000000000000'),'USD'),0)
  assert.equal(stripeFeeMinor(stripeFeeScaled('0.005'),'USD'),1)
  assert.equal(stripeFeeMinor(stripeFeeScaled('1.5'),'JPY'),2)
  assert.throws(()=>stripeFeeScaled('1,20'), /exact decimal/u)
 }finally{await runtime.dispose()}
})

test('Checkout proof attaches ownership without exposing merchant financial data or transferring an authenticated purchase', {timeout:120000},async t=>{
 const {db,runtime, env: bootEnv}=await boot();try{
  const env={...bootEnv,STRIPE_SECRET_KEY:'sk_test_local_d1_no_stripe_requests'}
  await payable(db,'claim')
  const originalFetch=globalThis.fetch
  t.mock.method(globalThis,'fetch',async(request:RequestInfo|URL,init?:RequestInit)=>{
   const url=new URL(request instanceof Request?request.url:String(request))
   if(url.origin!=='https://api.stripe.com')return originalFetch(request,init)
   assert.equal(new Headers(init?.headers).get('stripe-account'),'acct_seller')
   if(url.pathname==='/v1/charges/ch:claim'||url.pathname==='/v1/charges/ch%3Aclaim')return Response.json({id:'ch:claim',object:'charge',amount:10000,amount_captured:10000,amount_refunded:1000,currency:'usd'})
   if(url.pathname==='/v1/refunds')return Response.json({object:'list',data:[{id:'re:claim',object:'refund',amount:1000,currency:'usd',status:'pending',payment_intent:'pi:claim'}],has_more:false,url:'/v1/refunds'})
   throw new Error(`Unexpected Stripe request ${url.pathname}`)
  })
  await db.prepare("UPDATE payments SET captured_amount=10000,stripe_payment_intent_id='pi:claim',stripe_charge_id='ch:claim',receipt_url='https://example.com/receipt' WHERE id='claim'").run()
  await db.prepare("INSERT INTO payment_refunds(id,payment_id,idempotency_key,stripe_refund_id,amount,reason,status,error,created_by,created_at,updated_at) VALUES('refund:claim','claim','refund-retry:claim','re:claim',1000,'requested_by_customer','pending','operator-only diagnostic','other',?,?)").bind(NOW,NOW).run()
  const token=crypto.randomUUID()+crypto.randomUUID(),hash=await tokenHash(token)
  await db.prepare("UPDATE payments SET return_token_hash=?,return_expires_at='2099-01-01T00:00:00.000Z' WHERE id='claim'").bind(hash).run()
  // Another business's site cannot complete this business's payment.
  await assert.rejects(()=>completePaymentReturn(db,env,'another-org','claim',token,async()=>'verified'),error=>error instanceof HTTPError&&error.statusCode===404)
  // An anonymous checkout's purchase passes to the account that proves it.
  await db.prepare("INSERT INTO user(id,name,email,isAnonymous) VALUES('anon-buyer','Guest','anon-buyer@customers.blawby.test',1)").run()
  await db.prepare("UPDATE payments SET buyer_user_id='anon-buyer' WHERE id='claim'").run()
  assert.deepEqual(await claimCheckoutReturn(db,'verified',token),{payment_id:'claim',claimed:true})
  const originalClaim=await db.prepare('SELECT return_token_hash,return_expires_at AS expires_at,claimed_at,claimed_user_id FROM payments WHERE return_token_hash=?').bind(hash).first()
  const originalPayment=await db.prepare("SELECT * FROM payments WHERE id='claim'").first()
  const originalHold=await db.prepare("SELECT * FROM payment_checkout_holds WHERE payment_id='claim'").first()
  assert.equal(originalClaim?.claimed_user_id,'verified')
  assert.equal(typeof originalClaim?.claimed_at,'string')
  assert.equal(originalPayment?.buyer_user_id,'verified')
  assert.equal(originalHold?.buyer_user_id,'verified')
  assert.deepEqual(await claimCheckoutReturn(db,'verified',token),{payment_id:'claim',claimed:true})
  assert.deepEqual(await db.prepare('SELECT return_token_hash,return_expires_at AS expires_at,claimed_at,claimed_user_id FROM payments WHERE return_token_hash=?').bind(hash).first(),originalClaim)
  assert.deepEqual(await db.prepare("SELECT * FROM payments WHERE id='claim'").first(),originalPayment)
  assert.deepEqual(await db.prepare("SELECT * FROM payment_checkout_holds WHERE payment_id='claim'").first(),originalHold)
  assert.deepEqual((await buyerActivities(db,'verified')).activities.map(({kind,id})=>({kind,id})),[{kind:'payment',id:'claim'}])
  assert.equal(await buyerPaymentActivityPath(db,'verified','claim'),'/dashboard/account/activity/payment/claim')
  assert.deepEqual(await paymentTransactionDestination(db, ORG, 'payments', 'claim'), { to: '/dashboard/payments/bookings/payment/claim' })
  const owned=await loadBuyerBookingDetails(db, env,{userId:'verified',verifiedEmail:null},'payment','claim')
  assert.equal(owned.type,'payment')
  assert.equal(owned.name,'Consultation')
  assert.equal(owned.conversation_id,null)
  // refunded_amount is 0 in our row; the 1000 can only have come from Stripe's Charge.
  assert.deepEqual(owned.payments,[{payment:{id:'claim',currency:'USD',captured_amount:10000,refunded_amount:1000,surcharge_amount:0,receipt_url:'https://example.com/receipt'},refunds:[{id:'refund:claim',amount:1000,status:'pending',note:null}]}])
  for(const field of ['stripe_account_id','stripe_payment_intent_id','stripe_charge_id','livemode','buyer_user_id','price_snapshot_json'])assert.equal(Object.hasOwn(owned.payments![0]!.payment,field),false)
  for(const field of ['idempotency_key','stripe_refund_id','reason','error','attempted_at','created_by'])assert.equal(Object.hasOwn(owned.payments![0]!.refunds[0]!,field),false)
  assert.deepEqual(await db.prepare("SELECT stripe_account_id,stripe_payment_intent_id,stripe_charge_id,buyer_user_id FROM payments WHERE id='claim'").first(),{stripe_account_id:'acct_seller',stripe_payment_intent_id:'pi:claim',stripe_charge_id:'ch:claim',buyer_user_id:'verified'})
  assert.deepEqual(await db.prepare("SELECT idempotency_key,stripe_refund_id,error,created_by FROM payment_refunds WHERE id='refund:claim'").first(),{idempotency_key:'refund-retry:claim',stripe_refund_id:'re:claim',error:'operator-only diagnostic',created_by:'other'})
  assert.equal(await db.prepare("SELECT buyer_user_id FROM payment_checkout_holds WHERE payment_id='claim'").first('buyer_user_id'),'verified')
  await assert.rejects(()=>claimCheckoutReturn(db,'other',token),error=>error instanceof HTTPError&&error.statusCode===404&&error.statusMessage==='Purchase return proof expired or already used')

  assert.deepEqual((await buyerActivities(db,'verified')).activities.map(activity=>activity.id),['claim'])
  assert.deepEqual(await buyerActivities(db,'other'),{activities:[]})
  await assert.rejects(()=>loadBuyerBookingDetails(db, env,{userId:'other',verifiedEmail:null},'payment','claim'),error=>error instanceof HTTPError&&error.statusCode===404)

  await db.prepare("UPDATE payments SET return_expires_at='2000-01-01T00:00:00.000Z' WHERE return_token_hash=?").bind(hash).run()
  const expiredClaim=await db.prepare('SELECT return_token_hash,return_expires_at AS expires_at,claimed_at,claimed_user_id FROM payments WHERE return_token_hash=?').bind(hash).first()
  assert.equal(expiredClaim?.expires_at,'2000-01-01T00:00:00.000Z')
  await assert.rejects(()=>claimCheckoutReturn(db,'verified',token),error=>error instanceof HTTPError&&error.statusCode===404&&error.statusMessage==='Purchase return proof expired or already used')
  assert.deepEqual(await db.prepare('SELECT return_token_hash,return_expires_at AS expires_at,claimed_at,claimed_user_id FROM payments WHERE return_token_hash=?').bind(hash).first(),expiredClaim)
  assert.equal(await db.prepare("SELECT claimed_user_id FROM payments WHERE id='claim'").first('claimed_user_id'),'verified')

  await db.prepare("UPDATE payments SET return_expires_at='2099-01-01T00:00:00.000Z',buyer_user_id='other' WHERE id='claim'").run()
  const changedOwner=await db.prepare("SELECT * FROM payments WHERE id='claim'").first()
  const currentClaim=await db.prepare('SELECT return_token_hash,return_expires_at AS expires_at,claimed_at,claimed_user_id FROM payments WHERE return_token_hash=?').bind(hash).first()
  assert.equal(changedOwner?.buyer_user_id,'other')
  assert.equal(currentClaim?.claimed_user_id,'verified')
  await assert.rejects(()=>claimCheckoutReturn(db,'verified',token),error=>error instanceof HTTPError&&error.statusCode===404&&error.statusMessage==='Purchase return proof expired or already used')
  assert.deepEqual(await claimCheckoutReturn(db,'other',token),{payment_id:'claim',claimed:true})
  assert.deepEqual(await db.prepare('SELECT return_token_hash,return_expires_at AS expires_at,claimed_at,claimed_user_id FROM payments WHERE return_token_hash=?').bind(hash).first(),currentClaim)
  assert.deepEqual(await db.prepare("SELECT * FROM payments WHERE id='claim'").first(),changedOwner)
  assert.deepEqual(await db.prepare("SELECT * FROM payment_checkout_holds WHERE payment_id='claim'").first(),originalHold)

  await db.prepare('UPDATE payments SET claimed_user_id=NULL WHERE return_token_hash=?').bind(hash).run()
  const retainedClaim=await db.prepare('SELECT return_token_hash,return_expires_at AS expires_at,claimed_at,claimed_user_id FROM payments WHERE return_token_hash=?').bind(hash).first()
  assert.equal(retainedClaim?.claimed_user_id,null)
  assert.equal(retainedClaim?.claimed_at,currentClaim?.claimed_at)
  assert.deepEqual(await claimCheckoutReturn(db,'other',token),{payment_id:'claim',claimed:true})
  await assert.rejects(()=>claimCheckoutReturn(db,'verified',token),error=>error instanceof HTTPError&&error.statusCode===404&&error.statusMessage==='Purchase return proof expired or already used')
  assert.deepEqual(await db.prepare('SELECT return_token_hash,return_expires_at AS expires_at,claimed_at,claimed_user_id FROM payments WHERE return_token_hash=?').bind(hash).first(),retainedClaim)
  assert.deepEqual(await db.prepare("SELECT * FROM payments WHERE id='claim'").first(),{...changedOwner,claimed_user_id:null})
  assert.deepEqual(await db.prepare("SELECT * FROM payment_checkout_holds WHERE payment_id='claim'").first(),originalHold)

  await db.prepare("UPDATE payments SET buyer_user_id=NULL WHERE id='claim'").run()
  const unownedPayment=await db.prepare("SELECT * FROM payments WHERE id='claim'").first()
  assert.equal(unownedPayment?.buyer_user_id,null)
  for(const userId of ['verified','other'])await assert.rejects(()=>claimCheckoutReturn(db,userId,token),error=>error instanceof HTTPError&&error.statusCode===404&&error.statusMessage==='Purchase return proof expired or already used')
  assert.deepEqual(await db.prepare('SELECT return_token_hash,return_expires_at AS expires_at,claimed_at,claimed_user_id FROM payments WHERE return_token_hash=?').bind(hash).first(),retainedClaim)
  assert.deepEqual(await db.prepare("SELECT * FROM payments WHERE id='claim'").first(),unownedPayment)
  assert.deepEqual(await db.prepare("SELECT * FROM payment_checkout_holds WHERE payment_id='claim'").first(),originalHold)
 }finally{await runtime.dispose()}
})

test('buyer Activity groups exact owned visits and immutable orders without manufacturing conversations', {timeout:120000},async()=>{
 const {db,runtime,env}=await boot();try{
  const opening={id:'booking-request',kind:'booking' as const,organization_id:ORG,location_id:null,user_id:'verified',booking_id:null,payload:threadPayloadForGuest({name:'Verified',email:'verified@example.com',ipHash:'private-ip-hash'}),created_at:NOW }
  await db.batch(requestInsertQueries(opening).map(write=>db.prepare(write.query).bind(...write.params)))
  const booking = await claimSessionCapacity(db, { websiteSource: null, policyJson: OPEN_TERMS_JSON, env,organizationId:ORG,productId:'product',sessionId:'session',productVariantId:'variant',partySize:1,userId:'verified' })
  await nameConversationBooking(db, opening.id, booking.bookingId)
  assert.notEqual(booking.bookingId,opening.id)
  await payable(db,'visit-payment')
  await db.prepare("UPDATE payments SET buyer_user_id='verified',subject_id=?,captured_amount=10000 WHERE id='visit-payment'").bind(booking.bookingId).run()
  await db.prepare("UPDATE payment_checkout_holds SET buyer_user_id='verified',conversation_id=?,status='converted' WHERE payment_id='visit-payment'").bind(opening.id).run()
  await db.prepare("INSERT INTO payments(id,organization_id,buyer_user_id,stripe_account_id,livemode,subject_type,subject_id,currency,amount,captured_amount,price_snapshot_json,created_at,updated_at) VALUES('other-payment',?,'other','acct_seller',0,'booking',?,'USD',10000,10000,?,?,?)").bind(ORG,booking.bookingId,JSON.stringify({title:'Other private purchase'}),NOW,NOW).run()
  const visits=(await buyerActivities(db,'verified')).activities
  assert.deepEqual(visits.map(({kind,id,conversation_id,booking_id})=>({kind,id,conversation_id,booking_id})),[{kind:'booking',id:opening.id,conversation_id:opening.id,booking_id:booking.bookingId}])
  assert.equal(await buyerPaymentActivityPath(db,'verified','visit-payment'),`/dashboard/account/activity/booking/${opening.id}`)
  assert.deepEqual(await paymentTransactionDestination(db, ORG, 'payments', 'visit-payment'), { to: `/dashboard/payments/bookings/${booking.bookingId}` })
  await assert.rejects(() => paymentTransactionDestination(db, 'platform', 'platform', 'visit-payment'), { statusCode: 404 })
  // The team's private note on the booking is never the buyer's to read.
  await db.prepare("UPDATE bookings SET private_notes='Team-only note' WHERE id=?").bind(booking.bookingId).run()
  const detail=await loadBuyerBookingDetails(db, env,{userId:'verified',verifiedEmail:null},'booking',opening.id)
  assert.deepEqual(detail.payments!.map(item=>item.payment.id),['visit-payment'])
  assert.equal(detail.conversation_id,opening.id)
  assert.equal(detail.private_notes,null)
  assert.doesNotMatch(JSON.stringify(detail),/Team-only note/u)
  assert.equal(detail.assigned_member_name,null)
  await assert.rejects(()=>loadBuyerBookingDetails(db, env,{userId:'verified',verifiedEmail:null},'booking',booking.bookingId),error=>error instanceof HTTPError&&error.statusCode===404)
  await assert.rejects(()=>loadBuyerBookingDetails(db, env,{userId:'other',verifiedEmail:null},'booking',opening.id),error=>error instanceof HTTPError&&error.statusCode===404)
  await db.batch([
    db.prepare("UPDATE bookings SET user_id='other' WHERE id=?").bind(booking.bookingId),
    ...transferBookingGuestSeat({ query: 'c.id = ?', params: [opening.id] }, 'other', NOW).map(write => db.prepare(write.query).bind(...(write.params ?? []))),
    db.prepare("UPDATE conversations SET user_id='other' WHERE id=?").bind(opening.id),
  ])
  assert.equal(await readGuestConversation(db, 'verified', opening.id), null)
  assert.equal((await readGuestConversation(db, 'other', opening.id))?.id, opening.id)
  assert.equal((await buyerActivities(db,'verified')).activities.some(item=>item.kind==='booking'),false)
  await assert.rejects(()=>loadBuyerBookingDetails(db, env,{userId:'verified',verifiedEmail:null},'booking',opening.id),error=>error instanceof HTTPError&&error.statusCode===404)
  const retainedPayment=await loadBuyerBookingDetails(db, env,{userId:'verified',verifiedEmail:null},'payment','visit-payment')
  assert.equal(retainedPayment.conversation_id,null)
  assert.equal(retainedPayment.payments![0]!.payment.id,'visit-payment')
  assert.equal(await db.prepare("SELECT buyer_user_id FROM payments WHERE id='visit-payment'").first('buyer_user_id'),'verified')
  await assert.rejects(conversationPageFor(db,'verified',opening.id), {statusCode:404})
  assert.deepEqual(await listConversations(db,null,{userId:'verified',buyerAudience:true}),[])
 }finally{await runtime.dispose()}
})

test('buyer conversations hide merchant facts and preserve public unread receipts and immutable reply retries', {timeout:120000},async()=>{
 const {db,runtime, env: bootEnv}=await boot();try{
  const env={...bootEnv,BETTER_AUTH_SECRET:'local-proof-secret-long-enough-for-auth',BETTER_AUTH_URL:'https://proof.example',STRIPE_SECRET_KEY:'sk_test_local_d1_no_stripe_requests',NUXT_PUBLIC_PLATFORM_DOMAIN:'https://proof.example',EMAIL_REPLY_SECRET:'local-reply-proof',EMAIL_DELIVERY_MODE:'log_only',WHATSAPP_DELIVERY_MODE:'log_only'}
  // The member who answers is the business's owner, so the guest's messages alert them.
  await db.prepare("INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES('other-member',?,'other','owner',1)").bind(ORG).run()
  const opening=requestInsertQueries({id:'buyer-conversation',kind:'contact',organization_id:ORG,location_id:null,user_id:'verified',booking_id:null,payload:{guest:{name:'Verified',email:'verified@example.com',phone:null},subject:'Sandbox conversation',consent_at:null,ip_hash:'private-ip-hash',answers:[]},created_at:NOW },undefined,{words:'My question'})
  await db.batch(opening.map(write=>db.prepare(write.query).bind(...write.params)))
  const question=(await db.prepare("SELECT id FROM messages WHERE conversation_id='buyer-conversation' AND event_name='thread.submission'").first<string>('id'))!
  const publicReply=await appendMessage(db,{conversationId:'buyer-conversation',authorKind:'member',authorUserId:'other',channel:'web',eventName:'thread.member_reply',body:'Public host reply',payload:{provider_secret:'private-diagnostic'},dedupeKey:'public-host-reply'})
  const capture=await appendMessage(db,{conversationId:'buyer-conversation',authorKind:PLATFORM_MESSAGE_AUTHOR_KIND,authorUserId:null,eventName:'payment.payment_captured',body:'Payment received',payload:{stripe_charge_id:'private-charge'},dedupeKey:'public-capture'})
  // A member's words that are not a reply to the guest, and a dispute: the business's alone.
  await appendMessage(db,{conversationId:'buyer-conversation',authorKind:'member',authorUserId:'other',body:'Internal staff note',dedupeKey:'internal-note'})
  await appendMessage(db,{conversationId:'buyer-conversation',authorKind:PLATFORM_MESSAGE_AUTHOR_KIND,authorUserId:null,eventName:'payment.dispute_created',body:'Merchant dispute diagnostic',payload:{stripe_dispute_id:'private-dispute'},dedupeKey:'merchant-dispute'})
  // A member archived it for themselves; the guest's own view does not change.
  await archiveConversation(db,{organizationId:ORG,conversationId:'buyer-conversation',userId:'other',archived:true})
  const secrets=['private-ip-hash','private-diagnostic','private-charge','private-dispute','Internal staff note','Merchant dispute diagnostic']
  const thread=await conversationPageFor(db,'verified','buyer-conversation')
  assert.deepEqual(thread.entries.filter(entry=>entry.type!=='day').map(entry=>entry.id),[question,publicReply.id,capture.id])
  assert(thread.entries.every(entry=>entry.type!=='message'||((entry.author_user_id===null||(entry.side==='guest'&&entry.author_user_id==='verified'))&&entry.deliveries.length===0)))
  assert.equal(thread.capabilities.can_manage_participants,false)
  assert.deepEqual(thread.entries.filter(item=>item.type!=='day').map(item=>item.type==='message'?[item.side,item.author,item.body]:item.type==='event'?['event',item.text]:[item.type]),
   [['guest','You','My question'],['business','Payments','Public host reply'],['event','Payment received']])
  if(thread.conversation.kind==='team')throw new Error('Expected the buyer’s conversation')
  assert.deepEqual(thread.conversation.composer,{channel:'email'})
  for(const secret of secrets)assert.equal(JSON.stringify(thread).includes(secret),false,secret)
  const inbox=await listConversations(db,null,{userId:'verified',buyerAudience:true})
  // The newest messages are the internal note and the dispute; the buyer's row previews the newest message they can read
  // (Blawby's payment message, from the business), unread.
  assert.deepEqual(inbox.map(row=>[row.id,row.preview,row.preview_from,row.title,row.unread]),[['buyer-conversation','Payment received','Payments','Payments',true]])
  assert.deepEqual(await listConversations(db,null,{userId:'other',buyerAudience:true}),[])
  // Opening it reads it through the newest message they were shown; what they cannot see does not keep it unread.
  await markConversationRead(db,{organizationId:ORG,conversationId:'buyer-conversation',userId:'verified',throughMessageId:capture.id})
  const readInbox=await listConversations(db,null,{userId:'verified',buyerAudience:true})
  assert.deepEqual(readInbox.map(row=>[row.id,row.unread]),[['buyer-conversation',false]])
  assert.deepEqual(await listConversations(db,null,{userId:'verified',buyerAudience:true,unreadOnly:true}),[])
  assert.deepEqual((await conversationPageFor(db,'verified','buyer-conversation')).entries,thread.entries)
  const input={threadId:'buyer-conversation',userId:'verified',body:'My web reply',photos:[],idempotencyKey:'buyer-reply-key'}
  const send = async ({threadId,userId,...reply}: typeof input) => {
    const {conversation,role} = await resolveConversationAccess(db,userId,threadId)
    if (role !== 'guest') throw new HTTPError({statusCode:404,statusMessage:'Conversation not found'})
    return await sendConversationMessage(env,{...reply,conversation,role,userId,senderName:userId})
  }
  await send(input)
  const ledger=(await db.prepare("SELECT * FROM messages WHERE conversation_id='buyer-conversation' ORDER BY sequence").all()).results
  const message=ledger.find(entry=>entry.body===input.body)
  assert(message)
  assert.equal(message.author_user_id,'verified')
  assert.equal(message.channel,'web')
  const ownReplyView=await conversationPageFor(db,'verified','buyer-conversation')
  assert.equal(ownReplyView.entries.find(entry=>entry.type==='message'&&entry.id===message.id)?.author_user_id,'verified')
  assert(ownReplyView.entries.every(entry=>entry.type!=='message'||entry.author_user_id===null||(entry.side==='guest'&&entry.author_user_id==='verified')))
  // The conversation's projection: its inbox order and its reply tasks.
  const projectionOf=async()=>({last_message_at:await db.prepare("SELECT last_message_at FROM conversations WHERE id='buyer-conversation'").first<string>('last_message_at'),
   tasks:(await db.prepare("SELECT dedupe_key,status,version FROM tasks WHERE subject_type='conversation' AND subject_id='buyer-conversation' ORDER BY dedupe_key").all()).results})
  const projection=await projectionOf()
  assert.equal(projection.last_message_at,message.occurred_at)
  // The owner's alert about it is sent once and recorded on the message.
  const notices=(await db.prepare("SELECT * FROM guest_thread_deliveries WHERE message_id=? ORDER BY id").bind(message.id).all()).results
  assert.deepEqual(notices.map(notice=>[notice.channel,notice.purpose,notice.status]),[['email','owner_alert','sent']])
  await send(input)
  assert.deepEqual((await db.prepare("SELECT * FROM messages WHERE conversation_id='buyer-conversation' ORDER BY sequence").all()).results,ledger)
  assert.deepEqual(await projectionOf(),projection)
  assert.deepEqual((await db.prepare("SELECT * FROM guest_thread_deliveries WHERE message_id=? ORDER BY id").bind(message.id).all()).results,notices)
  await assert.rejects(()=>send({...input,body:'Changed message'}),error=>error instanceof HTTPError&&error.statusCode===409)
  await assert.rejects(()=>send({...input,userId:'other'}),error=>error instanceof HTTPError&&error.statusCode===404)
  // The conversation now belongs to another account: the key names the earlier owner's message, so their retry is refused and writes nothing.
  await db.batch([
    ...transferBookingGuestSeat({query:"c.id='buyer-conversation'"},'other',NOW).map(write=>db.prepare(write.query).bind(...(write.params??[]))),
    db.prepare("UPDATE conversations SET user_id='other' WHERE id='buyer-conversation'"),
  ])
  await assert.rejects(()=>send({...input,userId:'other'}),error=>error instanceof HTTPError&&error.statusCode===409)
  assert.deepEqual((await db.prepare("SELECT * FROM messages WHERE conversation_id='buyer-conversation' ORDER BY sequence").all()).results,ledger)
  const previousActorView=await conversationPageFor(db,'other','buyer-conversation')
  assert(previousActorView.entries.every(entry=>entry.type!=='message'||entry.author_user_id===null))
  await assert.rejects(()=>send(input),error=>error instanceof HTTPError&&error.statusCode===404)
  await db.prepare('UPDATE messages SET author_user_id=NULL WHERE id=?').bind(message.id).run()
  const retained=(await db.prepare("SELECT * FROM messages WHERE conversation_id='buyer-conversation' ORDER BY sequence").all()).results
  await assert.rejects(()=>send({...input,userId:'other'}),error=>error instanceof HTTPError&&error.statusCode===409)
  const historicalNullView=await conversationPageFor(db,'other','buyer-conversation')
  assert(historicalNullView.entries.every(entry=>entry.type!=='message'||entry.author_user_id===null))
  await assert.rejects(()=>send(input),error=>error instanceof HTTPError&&error.statusCode===404)
  assert.deepEqual((await db.prepare("SELECT * FROM messages WHERE conversation_id='buyer-conversation' ORDER BY sequence").all()).results,retained)
  assert.deepEqual(await projectionOf(),projection)
  assert.deepEqual((await db.prepare("SELECT * FROM guest_thread_deliveries WHERE message_id=? ORDER BY id").bind(message.id).all()).results,notices)
 }finally{await runtime.dispose()}
})

test('tenant deletion retains its connected account for servicing before any capture', {timeout:120000},async()=>{
 const {db,runtime}=await boot();try{
  await db.prepare("INSERT INTO stripe_connected_accounts(id,organization_id,stripe_account_id,country,livemode,status,card_payments_status,requirements_json,created_at,updated_at)VALUES('connected',?,'acct_no_payments','US',0,'ready','active','[]',?,?)").bind(ORG,NOW,NOW).run()
  await retainPaymentsForTenantDeletion(db,ORG)
  await retainPaymentsForTenantDeletion(db,ORG)
  await db.prepare('DELETE FROM organization WHERE id=?').bind(ORG).run()
  const retained=await db.prepare('SELECT organization_id,stripe_account_id,livemode FROM payment_servicing_tenants').all()
  assert.deepEqual(retained.results,[{organization_id:ORG,stripe_account_id:'acct_no_payments',livemode:0}])
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM payments').first('n'),0)
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM stripe_connected_accounts').first('n'),0)
  // The account retained for the deleted tenant is refused for another, whose acceptance state stays.
  await db.prepare("INSERT INTO stripe_connected_accounts(id,organization_id,stripe_account_id,country,livemode,status,card_payments_status,requirements_json,created_at,updated_at)VALUES('platform-connected','platform','acct_no_payments','US',0,'ready','active','[]',?,?)").bind(NOW,NOW).run()
  await assert.rejects(()=>retainPaymentsForTenantDeletion(db,'platform'),/conflicting Payments servicing ownership/u)
  assert.equal(await db.prepare("SELECT stripe_account_id FROM stripe_connected_accounts WHERE organization_id='platform'").first('stripe_account_id'),'acct_no_payments')
 }finally{await runtime.dispose()}
})

test('Payments usage reaches its Stripe meters once, a correction as a negative value, and a rejected event keeps Stripe’s reason without holding back the others', {timeout:120000},async(t)=>{
 const {db,runtime}=await boot();try{
  await payable(db,'billable')
  const events=[
   ['volume','billable','captured_volume','USD',10000,'capture:billable'],
   ['cost',null,'stripe_cost','USD',320,'fee:txn_1:revision:1'],
   ['correction',null,'stripe_cost_adjustment','USD',-30,'fee:txn_1:revision:2'],
   ['ads',null,'ad_spend','USD',50000,'google_ads:1234567890:2026-09-30'],
  ] as const
  await db.batch(events.map(([id,payment,kind,currency,amount,source],index)=>db.prepare("INSERT INTO usage_events(id,organization_id,payment_id,resource,unit,quantity,idempotency_key,provider_occurred_at,created_at,source) VALUES(?,?,?,?,?,?,?,?,?,'payments')").bind(id,ORG,payment,kind,currency,amount,source,NOW,new Date(Date.parse(NOW)+index*1000).toISOString())))
  const sent:Array<{event_name:string|null;customer:string|null;value:string|null;identifier:string|null;key:string|null}>=[]
  let answer:'ok'|'unavailable'|'invalid'='unavailable'
  const originalFetch=globalThis.fetch
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
   const url=new URL(input instanceof Request?input.url:String(input))
   if(url.origin!=='https://api.stripe.com')return originalFetch(input,init)
   assert.equal(url.pathname,'/v1/billing/meter_events')
   const body=new URLSearchParams(String(init?.body))
   sent.push({event_name:body.get('event_name'),customer:body.get('payload[stripe_customer_id]'),value:body.get('payload[value]'),identifier:body.get('identifier'),key:new Headers(init?.headers).get('idempotency-key')})
   if(answer==='unavailable')return Response.json({error:{type:'api_error',message:'Meter events are unavailable at the test boundary'}},{status:500,headers:{'stripe-should-retry':'false'}})
   if(answer==='invalid'&&body.get('event_name')==='krabiclaw_ad_spend')return Response.json({error:{type:'invalid_request_error',message:'No active meter was found for event_name krabiclaw_ad_spend'}},{status:400})
   return Response.json({object:'billing.meter_event',event_name:body.get('event_name'),identifier:body.get('identifier'),payload:{},timestamp:1,created:1,livemode:false})
  })
  const env={DB:db,STRIPE_SECRET_KEY:'sk_test_meter_boundary'} as CloudflareEnv
  // Stripe unavailable: every event is sent, each keeps the reason and stays deliverable.
  await assert.rejects(()=>deliverPaymentsUsage(db,env,ORG),/Stripe did not take 4 of 4 usage events.*unavailable at the test boundary/u)
  assert.equal(sent.length,4)
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM usage_events WHERE provider_occurred_at IS NOT NULL AND delivery_at IS NULL AND error='Meter events are unavailable at the test boundary'").first('n'),4)
  // Delivered: each to its meter, the correction negative, the repeat of each under the same identifier and key.
  answer='ok'
  assert.deepEqual(await deliverPaymentsUsage(db,env,ORG),{delivered:4})
  assert.deepEqual(sent.slice(4).map(({identifier,key,...row})=>row),[
   {event_name:'krabiclaw_captured_volume',customer:'cus_operating',value:'10000'},
   {event_name:'krabiclaw_stripe_cost',customer:'cus_operating',value:'320'},
   {event_name:'krabiclaw_stripe_cost',customer:'cus_operating',value:'-30'},
   {event_name:'krabiclaw_ad_spend',customer:'cus_operating',value:'50000'},
  ])
  assert.deepEqual(sent.slice(4).map(row=>row.identifier),sent.slice(0,4).map(row=>row.identifier))
  assert.equal(sent[4]!.key,sent[4]!.identifier)
  assert.equal(sent[4]!.identifier,`payments:${await tokenHash('capture:billable')}`)
  assert.equal(new Set(sent.slice(4).map(row=>row.identifier)).size,4)
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM usage_events WHERE provider_occurred_at IS NOT NULL AND delivery_at IS NOT NULL AND error IS NULL').first('n'),4)
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM analytics_events WHERE organization_id='platform' AND payload_json->>'$.event_name'='payments_volume_billed' AND payload_json->>'$.properties.volume_minor'=10000").first('n'),1)
  assert.deepEqual(await deliverPaymentsUsage(db,env,ORG),{delivered:0})
  assert.equal(sent.length,8)
  // Stripe refuses one meter outright: that event keeps Stripe’s reason and fails every delivery until Stripe takes it; a later event on another meter is still billed.
  answer='invalid'
  await db.prepare("INSERT INTO usage_events(id,organization_id,resource,unit,quantity,idempotency_key,provider_occurred_at,created_at,source) VALUES('late',?,'ad_spend','USD',100,'google_ads:1234567890:2026-10-01',?,?,'payments'),('later',?,'stripe_cost','USD',45,'fee:txn_2:revision:1',?,?,'payments')").bind(ORG,NOW,NOW,ORG,NOW,new Date(Date.parse(NOW)+60_000).toISOString()).run()
  await assert.rejects(()=>deliverPaymentsUsage(db,env,ORG),/Stripe did not take 1 of 2 usage events.*No active meter/u)
  assert.deepEqual(await db.prepare("SELECT id,delivery_at IS NOT NULL AS delivered,error FROM usage_events WHERE id IN ('late','later') ORDER BY id").all().then(result=>result.results),[
   {id:'late',delivered:0,error:'No active meter was found for event_name krabiclaw_ad_spend'},
   {id:'later',delivered:1,error:null},
  ])
  await assert.rejects(()=>deliverPaymentsUsage(db,env,ORG),/No active meter/u)
  assert.equal(sent.length,11)
  answer='ok'
  assert.deepEqual(await deliverPaymentsUsage(db,env,ORG),{delivered:1})
  assert.equal(sent.length,12)
  assert.deepEqual(await db.prepare("SELECT delivery_at IS NOT NULL AS delivered,error FROM usage_events WHERE id='late'").first(),{delivered:1,error:null})
  // A business with no Stripe customer has nothing to bill usage to: the delivery fails with that reason on the event.
  await db.prepare('UPDATE organization SET "stripeCustomerId"=NULL WHERE id=?').bind(ORG).run()
  await db.prepare("INSERT INTO usage_events(id,organization_id,resource,unit,quantity,idempotency_key,provider_occurred_at,created_at,source) VALUES('orphaned',?,'ad_spend','USD',100,'google_ads:1234567890:2026-10-02',?,?,'payments')").bind(ORG,NOW,NOW).run()
  await assert.rejects(()=>deliverPaymentsUsage(db,env,ORG),/no Stripe customer to bill this usage to/u)
  assert.deepEqual(await db.prepare("SELECT delivery_at,error FROM usage_events WHERE id='orphaned'").first(),{delivery_at:null,error:'The business has no Stripe customer to bill this usage to'})
  assert.equal(sent.length,12)
 }finally{await runtime.dispose()}
})

test('a stay purchase claim cancels Stripe before releasing only its checkout record, and a replay does not cancel twice', { timeout: 120_000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) })
  const { db, runtime, env: bootEnv } = await boot()
  try {
    const env = { ...bootEnv, BETTER_AUTH_URL: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_local_boundary', NUXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_local_boundary' }
    await db.prepare("INSERT INTO business_locations(id,organization_id,slug,title,timezone) VALUES('cabin-site',?,'cabin-site','Cabin','UTC')").bind(ORG).run()
    await db.prepare("INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by) VALUES('stay','cabin',?,'Cabin','cabin','host','host')").bind(ORG).run()
    await db.prepare("INSERT INTO product_locations(organization_id,product_id,location_id,created_by,updated_by) VALUES(?,'cabin','cabin-site','host','host')").bind(ORG).run()
    await db.prepare("INSERT INTO product_stay_configs(product_id,organization_id,internal_name,location_id,created_by,updated_by) VALUES('cabin',?,'Cabin','cabin-site','host','host')").bind(ORG).run()
    await db.prepare("INSERT INTO product_booking_configs(product_id,organization_id,unit,scheduling_mode,online_payment_required,check_in_time,check_out_time,default_capacity,min_nights,created_by,updated_by) VALUES('cabin',?,'nights','business',1,'15:00','11:00',4,1,'host','host')").bind(ORG).run()
    // A home's one variant is its nightly offer, which every booking of it names.
    await db.prepare("INSERT INTO product_variants(id,organization_id,product_id,name,created_by,updated_by) VALUES('cabin-night',?,'cabin','Night','host','host')").bind(ORG).run()
    const claims = new Map<string, string>()
    for (const [id, from, to] of [['changing', '2099-10-01', '2099-10-03'], ['other-stay', '2099-10-03', '2099-10-04']]) {
      await payable(db, id!)
      await db.prepare("UPDATE payments SET location_id='cabin-site' WHERE id=?").bind(id).run()
      await db.prepare("UPDATE payment_checkout_holds SET product_id='cabin',variant_id=NULL,price_id=NULL,session_id=NULL,location_id='cabin-site',timezone='UTC',starts_at=?,ends_at=? WHERE payment_id=?").bind(from, to, id).run()
      const claim = crypto.randomUUID() + crypto.randomUUID()
      claims.set(id!, claim)
      await db.prepare("UPDATE payments SET return_token_hash=?,return_expires_at='2099-01-01T00:00:00.000Z' WHERE id=?").bind(await tokenHash(claim), id).run()
    }
    for (const date of ['2099-10-01', '2099-10-02', '2099-10-03']) {
      await db.prepare("INSERT INTO product_nights(organization_id,product_id,date,min_stay_arrival,source,updated_by) VALUES(?,'cabin',?,1,'host','host')").bind(ORG, date).run()
      await db.prepare("INSERT INTO prices(id,organization_id,product_variant_id,stay_date,currency,unit_amount,created_by,updated_by) VALUES(?,?,'cabin-night',?,'USD',10000,'host','host')").bind(`price:${date}`, ORG, date).run()
    }
    const stayPurchase = {
      product_id: 'cabin', location_id: 'cabin-site', timezone: 'UTC', check_in_date: '2099-10-01', check_out_date: '2099-10-03',
      adults: 1, children: 0, infants: 0, total_minor: 20000, currency: 'USD', cancellation_policy: 'flexible',
      nightly: [{ date: '2099-10-01', price_minor: 10000 }, { date: '2099-10-02', price_minor: 10000 }],
      guest: { name: 'Guest', email: 'guest@example.com', phone: null, notes: null },
    }
    await db.prepare("UPDATE payments SET amount=20000,price_snapshot_json=? WHERE id='changing'").bind(JSON.stringify({
      title: 'Cabin', tax_code: null, quantity: 1, automatic_tax: false, method_configuration_id: 'pmc_cabin', price: { unit_amount: 20000, currency: 'USD', tax_behavior: 'exclusive' }, stay: stayPurchase,
    })).run()
    await db.prepare("UPDATE payment_checkout_holds SET amount=20000 WHERE payment_id='changing'").run()
    assert.equal(await db.prepare('SELECT count(*) FROM stay_nights').first('count(*)'), 0)
    let nativeStatus = 'processing'
    let cancellations = 0
    const originalFetch = globalThis.fetch
    t.mock.method(globalThis, 'fetch', async (request, init) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      if (url.origin !== 'https://api.stripe.com') return originalFetch(request, init)
      assert.equal(new Headers(init?.headers).get('stripe-account'), 'acct_seller')
      if (init?.method === 'POST') {
        assert.equal(url.pathname, '/v1/payment_intents/pi_changing/cancel')
        assert.equal(new URLSearchParams(String(init.body)).get('cancellation_reason'), 'requested_by_customer')
        assert.equal(new Headers(init.headers).get('idempotency-key'), 'krabiclaw-cancel:changing')
        assert.equal(await db.prepare("SELECT status FROM payment_checkout_holds WHERE payment_id='changing'").first('status'), 'active')
        assert.equal(await db.prepare('SELECT count(*) FROM stay_nights').first('count(*)'), 0)
        cancellations++
        nativeStatus = 'canceled'
      } else assert.equal(url.pathname, '/v1/payment_intents/pi_changing')
      return Response.json({ id: 'pi_changing', object: 'payment_intent', status: nativeStatus, amount: 20000, currency: 'usd', livemode: false, payment_method_types: ['card'], metadata: { krabiclaw_payment_id: 'changing' } })
    })
    const app = new H3()
    app.use(event => { event.context.organizationId = event.req.headers.get('x-test-organization') ?? ORG })
    app.get('/api/public/payments/:payment_id', paymentHandoffRoute)
    app.post('/api/public/payments/:payment_id/cancel', paymentCancelRoute)
    const cancel = (claim: string, organizationId = ORG) => app.request(Object.assign(new Request('https://payments.proof.example/api/public/payments/changing/cancel', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-organization': organizationId }, body: JSON.stringify({ claim }),
    }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
    assert.equal((await cancel(crypto.randomUUID() + crypto.randomUUID())).status, 404)
    assert.equal((await cancel(claims.get('changing')!, 'another-business')).status, 404)
    const processing = await cancel(claims.get('changing')!)
    assert.equal(processing.status, 409)
    assert.equal((await processing.json() as { data: { code: string } }).data.code, 'payment_in_progress')
    assert.equal(cancellations, 0)
    assert.equal(await db.prepare("SELECT status FROM payment_checkout_holds WHERE payment_id='changing'").first('status'), 'active')
    nativeStatus = 'requires_payment_method'
    const openHandoff = await app.request(Object.assign(new Request(`https://payments.proof.example/api/public/payments/changing?claim=${claims.get('changing')!}`), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
    assert.equal(openHandoff.status, 200, await openHandoff.clone().text())
    assert.equal(openHandoff.headers.get('cache-control'), 'private, no-store')
    const open = await openHandoff.json()
    assert.deepEqual(open, {
      payment_id: 'changing', state: 'open', title: 'Cabin', quantity: 1, unit_amount: 20000,
      stay: { product_id: 'cabin', check_in_date: '2099-10-01', check_out_date: '2099-10-03', nights: 2, nightly: [10000, 10000], adults: 1, children: 0, infants: 0, cancellation_policy: 'flexible' },
      approved_stay_path: null,
      billing_details: { name: 'Guest', email: 'guest@example.com' },
      kind: 'stay', image_url: null, starts_at: null, ends_at: null, timezone: null, party_size: null, product_slug: 'cabin', location_slug: 'cabin-site', free_cancellation_until: null,
      subtotal: 20000, currency: 'USD', expires_at: '2099-09-30T00:00:00.000Z', stripe_account_id: 'acct_seller', publishable_key: 'pk_test_local_boundary',
      payment_method_types: ['card'], customer_session_client_secret: null, bank_verification_url: null, surcharge_basis_points: null,
    })
    for (const column of ['checkout_expires_at', 'return_expires_at']) {
      const expiry = await db.prepare(`SELECT ${column} AS expires_at FROM payments WHERE id='changing'`).first<string>('expires_at')
      assert(expiry)
      await db.prepare(`UPDATE payments SET ${column}=? WHERE id='changing'`).bind(NOW).run()
      const lapsedPayment = await requirePayment(db, ORG, 'changing')
      const expired = await cancel(claims.get('changing')!)
      assert.equal(expired.status, 409)
      assert.equal((await expired.json() as { data: { code: string } }).data.code, 'payment_expired')
      const expiredHandoff = await app.request(Object.assign(new Request(`https://payments.proof.example/api/public/payments/changing?claim=${claims.get('changing')!}`), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
      assert.equal(expiredHandoff.status, 200, await expiredHandoff.clone().text())
      assert.deepEqual(await expiredHandoff.json(), { ...open, state: 'expired', billing_details: null, ...(column === 'checkout_expires_at' ? { expires_at: NOW } : {}) })
      assert.equal(cancellations, 0)
      assert.deepEqual(await requirePayment(db, ORG, 'changing'), lapsedPayment)
      assert.equal(await db.prepare('SELECT count(*) FROM stay_nights').first('count(*)'), 0)
      assert.deepEqual((await db.prepare('SELECT payment_id,status FROM payment_checkout_holds ORDER BY payment_id').all()).results, [{ payment_id: 'changing', status: 'active' }, { payment_id: 'other-stay', status: 'active' }])
      await db.prepare(`UPDATE payments SET ${column}=? WHERE id='changing'`).bind(expiry).run()
    }
    const canceled = await cancel(claims.get('changing')!)
    assert.equal(canceled.status, 200, await canceled.clone().text())
    assert.deepEqual(await canceled.json(), { status: 'canceled' })
    assert.equal((await requirePayment(db, ORG, 'changing')).captured_amount, 0)
    const failedHandoff = await app.request(Object.assign(new Request(`https://payments.proof.example/api/public/payments/changing?claim=${claims.get('changing')!}`), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
    assert.equal(failedHandoff.status, 200, await failedHandoff.clone().text())
    assert.deepEqual(await failedHandoff.json(), { ...open, state: 'failed', billing_details: null })
    const calendar = await readHomeCalendar(db, { organizationId: ORG, actorId: 'host', manage: true }, { productId: 'cabin', from: '2099-10-01', to: '2099-10-04' })
    assert.deepEqual(calendar.nights.map(night => [night.date, night.available]), [
      ['2099-10-01', true], ['2099-10-02', true], ['2099-10-03', true],
    ])
    assert.deepEqual((await db.prepare('SELECT payment_id,status FROM payment_checkout_holds ORDER BY payment_id').all()).results, [{ payment_id: 'changing', status: 'released' }, { payment_id: 'other-stay', status: 'active' }])
    assert.equal(await db.prepare('SELECT count(*) FROM stay_nights').first('count(*)'), 0)
    await db.prepare("UPDATE payments SET return_expires_at=?,checkout_expires_at=? WHERE id='changing'").bind(NOW,NOW).run()
    const replay = await cancel(claims.get('changing')!)
    assert.equal(replay.status, 200)
    assert.deepEqual(await replay.json(), { status: 'canceled' })
    assert.equal(cancellations, 1)
  } finally {
    await runtime.dispose()
  }
})

test('ACH review shows bank details and no surcharge, and payment failure frees the booking it made', { timeout: 120_000 }, async (t) => {
  const { db, runtime, env: bootEnv, events } = await boot()
  try {
    const env = { ...bootEnv, BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-proof-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only', STRIPE_SECRET_KEY: 'sk_test_local_boundary' }
    await payable(db, 'ach-payment')
    const opening = { id: 'ach-request', kind: 'booking' as const, organization_id: ORG, location_id: null, user_id: 'guest', booking_id: null, payload: threadPayloadForGuest({ name: 'Guest', email: 'guest@example.com', phone: '+12025550114' }), created_at: NOW }
    await db.batch(requestInsertQueries(opening).map(write => db.prepare(write.query).bind(...write.params)))
    await db.prepare("UPDATE payment_checkout_holds SET conversation_id=? WHERE payment_id='ach-payment'").bind(opening.id).run()
    const originalFetch = globalThis.fetch
    let achIntentStatus = 'requires_confirmation'

    t.mock.method(globalThis, 'fetch', async (request, init) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      if (url.origin !== 'https://api.stripe.com') return originalFetch(request, init)
      assert.equal(new Headers(init?.headers).get('stripe-account'), 'acct_seller')
      if (url.pathname === '/v1/payment_intents/pi_ach-payment' && init?.method === 'POST') {
        return Response.json({
          id: 'pi_ach-payment',
          object: 'payment_intent',
          status: 'requires_confirmation',
          amount: 10000,
          currency: 'usd',
          livemode: false,
          metadata: { blawby_payment_id: 'ach-payment' },
          amount_details: {
            surcharge: {
              status: 'unavailable',
            },
          },
          payment_method: 'pm_achproof123',
        })
      }
      if (url.pathname === '/v1/payment_methods/pm_achproof123' && init?.method === 'GET') {
        return Response.json({
          id: 'pm_achproof123',
          object: 'payment_method',
          type: 'us_bank_account',
          billing_details: { address: { country: 'US', postal_code: '94103', line1: null, line2: null, city: null, state: null } },
          us_bank_account: {
            bank_name: 'STRIPE TEST BANK',
            last4: '6789',
            routing_number: '110000000',
            account_holder_type: 'individual',
          },
        })
      }
      if (url.pathname === '/v1/payment_intents/pi_ach-payment' && init?.method === 'GET') {
        return Response.json({
          id: 'pi_ach-payment',
          object: 'payment_intent',
          status: achIntentStatus,
          amount: 10000,
          currency: 'usd',
          livemode: false,
          metadata: { blawby_payment_id: 'ach-payment' },
          payment_method: 'pm_achproof123',
        })
      }
      if (url.pathname === '/v1/payment_intents/pi_ach-payment/cancel' && init?.method === 'POST') {
        assert.equal(new Headers(init?.headers).get('idempotency-key'), 'krabiclaw-failed:ach-payment')
        achIntentStatus = 'canceled'
        return Response.json({ id: 'pi_ach-payment', object: 'payment_intent', status: achIntentStatus, amount: 10000, currency: 'usd', livemode: false,
          cancellation_reason: 'abandoned', metadata: { blawby_payment_id: 'ach-payment' } })
      }
      if (url.pathname === '/v1/payment_intents/pi_ach-payment/confirm' && init?.method === 'POST') {
        // A method that leaves the site comes back to the business's own pay page, never the platform.
        assert.equal(new URLSearchParams(String(init.body)).get('return_url'), `https://payments.proof.example/pay/ach-payment?claim=${claim}`)
        achIntentStatus = 'processing'
        return Response.json({
          id: 'pi_ach-payment',
          object: 'payment_intent',
          status: achIntentStatus,
          amount: 10000,
          currency: 'usd',
          client_secret: 'pi_ach-payment_secret',
          payment_method: { id: 'pm_achproof123', type: 'us_bank_account' },
          livemode: false,
          metadata: { blawby_payment_id: 'ach-payment' },
        })
      }
      throw new Error(`Unexpected Stripe request: ${init?.method} ${url.pathname}`)
    })

    const stripe = getStripe(env)
    const claim = crypto.randomUUID() + crypto.randomUUID()
    const hash = await tokenHash(claim)
    await db.prepare("UPDATE payments SET return_token_hash=?,return_expires_at='2099-01-01T00:00:00.000Z' WHERE id='ach-payment'").bind(hash).run()

    // A confirmation decline leaves the purchase open for another method.
    const declinedIntent = {
      id: 'pi_ach-payment', livemode: false, currency: 'usd',
      metadata: { blawby_payment_id: 'ach-payment' },
      status: 'requires_payment_method', amount: 10000,
      last_payment_error: { type: 'card_error', code: 'card_declined' },
    } as Stripe.PaymentIntent
    const originalHold = await db.prepare("SELECT status, expires_at FROM payment_checkout_holds WHERE payment_id='ach-payment'").first()
    await reconcilePaymentIntent(db, stripe, await requirePayment(db, ORG, 'ach-payment'), declinedIntent, env)
    assert.equal((await requirePayment(db, ORG, 'ach-payment')).captured_amount, 0)
    const handoff = await paymentHandoff(db, { ...env, NUXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_local_boundary' }, ORG, 'ach-payment', claim)
    assert.equal(handoff.state, 'open')
    assert.deepEqual(handoff.billing_details, { name: 'Guest', email: 'guest@example.com', phone: '+12025550114' })
    assert.deepEqual(await db.prepare("SELECT status, expires_at FROM payment_checkout_holds WHERE payment_id='ach-payment'").first(), originalHold)
    assert.equal(events.take('payment.financial'), undefined)

    const review = await reviewPayment(db, env, ORG, 'ach-payment', claim, 'pm_achproof123', null)
    assert.equal(review.surcharge, 0)
    assert.equal(review.tax, 0)
    assert.equal(review.total, 10000)
    assert.equal(review.method.type, 'us_bank_account')
    assert.equal(review.method.bank_name, 'STRIPE TEST BANK')
    assert.equal(review.method.last4, '6789')

    const confirm = await confirmPayment(db, env, ORG, 'ach-payment', claim, { payment_method_id: 'pm_achproof123', total: 10000 }, 'https://payments.proof.example')
    assert.deepEqual(confirm, { status: 'processing', taken: false, client_secret: null, requires_action: false, bank_verification_url: null })

    const payment = await requirePayment(db, ORG, 'ach-payment')
    assert.ok(payment.subject_id)
    assert.equal(payment.captured_amount, 0)
    assert.equal(await db.prepare('SELECT status FROM bookings WHERE id=?').bind(payment.subject_id).first('status'), 'confirmed')
    assert.deepEqual(await holdOf(db, 'ach-payment'), { status: 'converted', expires_at: '2099-09-30T00:00:00.000Z' })

    // The bank can fail long after the checkout expires. The financial event cancels the booking.
    const failedIntent = {
      id: 'pi_ach-payment', livemode: false, currency: 'usd', metadata: { blawby_payment_id: 'ach-payment' },
      status: 'requires_payment_method', amount: 10000,
      last_payment_error: { code: 'bank_account_unusable', message: 'The bank payment failed' },
    } as unknown as Stripe.PaymentIntent
    await db.prepare("UPDATE payments SET checkout_expires_at='2000-01-01T00:00:00.000Z' WHERE id='ach-payment'").run()
    await reconcilePaymentIntent(db, stripe, await requirePayment(db, ORG, 'ach-payment'), failedIntent, env)
    assert.equal((await requireClaimedPayment(db, env, ORG, 'ach-payment', claim)).state, 'failed')
    await events.runNext(env, 'payment.financial')
    assert.equal(await db.prepare('SELECT status FROM bookings WHERE id=?').bind(payment.subject_id).first('status'), 'cancelled')
    assert.equal(await db.prepare("SELECT count(*) FROM messages WHERE conversation_id=? AND event_name='payment.payment_failed'").bind(opening.id).first('count(*)'), 1)
  } finally {
    await runtime.dispose()
  }
})

test('a business registered for Stripe Tax has tax calculated by Stripe from the billing address, attached to the intent and confirmed as reviewed', { timeout: 120_000 }, async (t) => {
  const { db, runtime, env: bootEnv } = await boot()
  try {
    const env = { ...bootEnv, STRIPE_SECRET_KEY: 'sk_test_local_boundary' }
    await payable(db, 'taxed')
    await db.prepare("UPDATE payments SET price_snapshot_json=? WHERE id='taxed'").bind(JSON.stringify({ title: 'Consultation', tax_code: 'txcd_20030000', price: { unit_amount: 10000, currency: 'USD', tax_behavior: 'exclusive' }, quantity: 1, automatic_tax: true, method_configuration_id: 'pmc_seller' })).run()
    await db.prepare("INSERT INTO stripe_connected_accounts(id,organization_id,stripe_account_id,livemode,country,status,surcharge_basis_points,created_at,updated_at) VALUES('connected',?,'acct_seller',0,'US','ready',300,?,?)").bind(ORG, NOW, NOW).run()
    const claim = crypto.randomUUID() + crypto.randomUUID()
    await db.prepare("UPDATE payments SET return_token_hash=?,return_expires_at='2099-01-01T00:00:00.000Z' WHERE id='taxed'").bind(await tokenHash(claim)).run()
    const sent: Record<string, URLSearchParams> = {}
    let calculations = 0
    const originalFetch = globalThis.fetch
    t.mock.method(globalThis, 'fetch', async (request, init) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      if (url.origin !== 'https://api.stripe.com') return originalFetch(request, init)
      assert.equal(new Headers(init?.headers).get('stripe-account'), 'acct_seller')
      const body = new URLSearchParams(String(init?.body ?? ''))
      if (url.pathname === '/v1/payment_methods/pm_cardUS' && init?.method === 'GET') {
        return Response.json({ id: 'pm_cardUS', object: 'payment_method', type: 'card', billing_details: { address: { country: 'US', postal_code: '98104', line1: null, line2: null, city: null, state: null } }, card: { brand: 'visa', last4: '4242', funding: 'credit', wallet: null } })
      }
      if (url.pathname === '/v1/tax/calculations' && init?.method === 'POST') {
        calculations += 1
        sent.calculation = body
        return Response.json({ id: 'taxcalc_taxed', object: 'tax.calculation', amount_total: 11025, tax_amount_exclusive: 1025, tax_amount_inclusive: 0 })
      }
      if (url.pathname === '/v1/payment_intents/pi_taxed' && init?.method === 'POST') {
        sent.update = body
        return Response.json({ id: 'pi_taxed', object: 'payment_intent', status: 'requires_confirmation', amount: Number(body.get('amount')), currency: 'usd', livemode: false, metadata: { blawby_payment_id: 'taxed' }, payment_method: 'pm_cardUS', amount_details: { surcharge: { status: 'available', maximum_amount: 330 } } })
      }
      if (url.pathname === '/v1/payment_intents/pi_taxed' && init?.method === 'GET') {
        return Response.json({ id: 'pi_taxed', object: 'payment_intent', status: 'requires_confirmation', amount: 11025, currency: 'usd', livemode: false, metadata: { blawby_payment_id: 'taxed' }, payment_method: 'pm_cardUS' })
      }
      if (url.pathname === '/v1/payment_intents/pi_taxed/confirm' && init?.method === 'POST') {
        sent.confirm = body
        return Response.json({ id: 'pi_taxed', object: 'payment_intent', status: 'processing', amount: 11355, currency: 'usd', client_secret: 'pi_taxed_secret', payment_method: 'pm_cardUS', livemode: false, metadata: { blawby_payment_id: 'taxed' } })
      }
      throw new Error(`Unexpected Stripe request: ${init?.method} ${url.pathname}`)
    })
    const review = await reviewPayment(db, env, ORG, 'taxed', claim, 'pm_cardUS', '203.0.113.9')
    // Stripe Tax located the buyer by the card's billing address, for the purchase's own amount, tax code and behavior.
    assert.equal(calculations, 1)
    assert.equal(sent.calculation!.get('currency'), 'usd')
    assert.equal(sent.calculation!.get('line_items[0][amount]'), '10000')
    assert.equal(sent.calculation!.get('line_items[0][reference]'), 'taxed')
    assert.equal(sent.calculation!.get('line_items[0][tax_behavior]'), 'exclusive')
    assert.equal(sent.calculation!.get('line_items[0][tax_code]'), 'txcd_20030000')
    assert.equal(sent.calculation!.get('customer_details[address][country]'), 'US')
    assert.equal(sent.calculation!.get('customer_details[address][postal_code]'), '98104')
    assert.equal(sent.calculation!.get('customer_details[address_source]'), 'billing')
    assert.equal(sent.calculation!.get('customer_details[ip_address]'), null)
    // The intent charges Stripe's taxed total and carries the calculation, so Stripe records the tax transaction.
    assert.equal(sent.update!.get('amount'), '11025')
    assert.equal(sent.update!.get('hooks[inputs][tax][calculation]'), 'taxcalc_taxed')
    assert.equal(sent.update!.get('payment_method'), 'pm_cardUS')
    // The surcharge is the business's rate on the taxed amount, inside Stripe's maximum.
    assert.deepEqual({ subtotal: review.subtotal, tax: review.tax, tax_included: review.tax_included, surcharge: review.surcharge, total: review.total }, { subtotal: 10000, tax: 1025, tax_included: 0, surcharge: 330, total: 11355 })
    const stored = JSON.parse(await db.prepare("SELECT review_json FROM payments WHERE id='taxed'").first<string>('review_json') ?? '{}')
    assert.deepEqual({ tax: stored.tax, total: stored.total }, { tax: 1025, total: 11355 })

    // A total other than the one reviewed is not confirmed.
    await assert.rejects(confirmPayment(db, env, ORG, 'taxed', claim, { payment_method_id: 'pm_cardUS', total: 10330 }, 'https://payments.proof.example'), /Review the payment again/u)
    assert.equal(sent.confirm, undefined)
    const confirmed = await confirmPayment(db, env, ORG, 'taxed', claim, { payment_method_id: 'pm_cardUS', total: 11355 }, 'https://payments.proof.example')
    assert.equal(confirmed.status, 'processing')
    assert.equal(sent.confirm!.get('amount_to_confirm'), '11355')
    assert.equal(sent.confirm!.get('amount_details[surcharge][amount]'), '330')
  } finally {
    await runtime.dispose()
  }
})

const CHECKOUT_REPLY_SECRET = 'local-proof-reply'
async function confirmable(db: D1Database, id: string, holdExpires: string, checkoutExpires = '2099-09-30T00:00:00.000Z') {
 await payable(db, id, checkoutExpires)
 const claim = crypto.randomUUID() + crypto.randomUUID()
 // A site checkout's conversation, as createProductBooking writes it. Its booking is attached at settlement.
 const provenance = { source: 'website', external_reference: null, actor_user_id: null, idempotency_key: `checkout-${id}`, fingerprint: `fingerprint-${id}`, guest_acknowledgement: true, creation_kind: 'checkout' as const, creation_status: 'pending' as const, followups_completed: false }
 const threadId = `request-${id}`
 const cancellation = await createReplayableReservationCancelToken(CHECKOUT_REPLY_SECRET, threadId)
 const opening = { id: threadId, kind: 'booking' as const, organization_id: ORG, location_id: null, user_id: 'guest', booking_id: null, payload: { ...threadPayloadForGuest({ name: 'Guest', email: 'buyer@mail-fixture.blawby.com' }), provenance,
  cancellation: { token_hash: await hashReservationCancelToken(cancellation.token), expires_at: cancellation.expiresAt, used_at: null } }, created_at: NOW }
 await db.batch(requestInsertQueries(opening).map(write => db.prepare(write.query).bind(...write.params)))
 await db.prepare("UPDATE payments SET return_token_hash=?,return_expires_at='2099-01-01T00:00:00.000Z',review_json=? WHERE id=?").bind(await tokenHash(claim), JSON.stringify({ payment_method_id: 'pm_proof', subtotal: 10000, tax: 0, tax_included: 0, surcharge: 0, total: 10000, reviewed_at: NOW }), id).run()
 await db.prepare('UPDATE payment_checkout_holds SET expires_at=?,conversation_id=? WHERE payment_id=?').bind(holdExpires, opening.id, id).run()
 return claim
}
/** Stripe's answers for the intents, charges and refunds a confirmation and its settlement read, and the platform meter its captured volume is billed on. */
function fakeStripe(t: TestContext, handle: (url: URL, init: RequestInit | undefined) => Promise<Response | null> | Response | null, statuses: Record<string, string>) {
 const originalFetch = globalThis.fetch
 const calls = { confirm: [] as string[], capture: [] as string[], cancel: [] as string[], refund: [] as string[], read: [] as string[], billed: [] as string[] }
 const cancellations = new Map<string, string | null>()
 t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(request instanceof Request ? request.url : String(request))
  if (url.origin !== 'https://api.stripe.com') return originalFetch(request, init)
  if (url.pathname === '/v1/billing/meter_events') {
   const body = new URLSearchParams(String(init?.body))
   assert.equal(new Headers(init?.headers).get('stripe-account'), null)
   assert.equal(body.get('payload[stripe_customer_id]'), 'cus_operating')
   calls.billed.push(`${body.get('event_name')}:${body.get('payload[value]')}`)
   return Response.json({ object: 'billing.meter_event', event_name: body.get('event_name'), identifier: body.get('identifier'), payload: {}, timestamp: 1, created: 1, livemode: false })
  }
  assert.equal(new Headers(init?.headers).get('stripe-account'), 'acct_seller')
  const handled = await handle(url, init)
  if (handled) return handled
  const [, , resource, id, action] = url.pathname.split('/')
  const paymentId = id?.replace(/^(pi|ch)_/u, '')
  const charge = { id: `ch_${paymentId}`, object: 'charge', livemode: false, amount: 10000, currency: 'usd', created: 1_790_000_000,
   payment_intent: `pi_${paymentId}`, receipt_url: 'https://pay.stripe.com/receipts/proof', billing_details: { email: 'buyer@mail-fixture.blawby.com' } }
  const intent = () => ({ id: `pi_${paymentId}`, object: 'payment_intent', livemode: false, currency: 'usd', amount: 10000,
   amount_received: statuses[paymentId!] === 'succeeded' ? 10000 : 0, status: statuses[paymentId!], client_secret: `pi_${paymentId}_secret`,
   payment_method: 'pm_proof', latest_charge: ['succeeded', 'requires_capture'].includes(statuses[paymentId!]!) ? charge : null,
   cancellation_reason: cancellations.get(paymentId!) ?? null, last_payment_error: null, metadata: { [paymentId === 'authenticating' ? 'blawby_payment_id' : 'krabiclaw_payment_id']: paymentId } })
  if (resource === 'payment_intents' && action === 'confirm') { calls.confirm.push(paymentId!); return Response.json(intent()) }
  if (resource === 'payment_intents' && action === 'capture') { calls.capture.push(paymentId!); statuses[paymentId!] = 'succeeded'; return Response.json(intent()) }
  if (resource === 'payment_intents' && action === 'cancel') {
   calls.cancel.push(paymentId!)
   statuses[paymentId!] = 'canceled'
   cancellations.set(paymentId!, new URLSearchParams(String(init?.body)).get('cancellation_reason'))
   return Response.json(intent())
  }
  if (resource === 'payment_intents' && init?.method === 'GET') { calls.read.push(paymentId!); return Response.json(intent()) }
  if (resource === 'charges') return Response.json(charge)
  if (resource === 'refunds' && init?.method === 'POST') { const paid = new URLSearchParams(String(init.body)).get('payment_intent')!; calls.refund.push(paid); return Response.json({ id: `re_${paid}`, object: 'refund', amount: 10000, currency: 'usd', status: 'succeeded', payment_intent: paid, reason: 'requested_by_customer', metadata: { krabiclaw_refund_id: new URLSearchParams(String(init.body)).get('metadata[blawby_refund_id]') } }) }
  throw new Error(`Unexpected Stripe request ${init?.method} ${url.pathname}`)
 })
 return calls
}
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()
const holdOf = (db: D1Database, id: string) => db.prepare('SELECT status, expires_at FROM payment_checkout_holds WHERE payment_id=?').bind(id).first<{ status: string; expires_at: string }>()
const stripeEnv = (env: CloudflareEnv) => ({ ...env, STRIPE_SECRET_KEY: 'sk_test_local_boundary', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only', EMAIL_REPLY_SECRET: CHECKOUT_REPLY_SECRET } as CloudflareEnv)
/** Email goes to Resend, as in production. */
const resendEnv = (env: CloudflareEnv) => ({ ...env, EMAIL_DELIVERY_MODE: 'provider', RESEND_API_KEY: 're_test_local', EMAIL_FROM: 'Blawby <proof@example.com>' } as CloudflareEnv)
/** Resend's API: every email it is asked to send, as the request body sent it, and each one read back as sent. */
function resendOutbox(t: TestContext): string[] {
 const emails: string[] = []
 const realFetch = globalThis.fetch
 t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(request instanceof Request ? request.url : String(request))
  if (url.hostname !== 'api.resend.com') return realFetch(request, init)
  if (init?.method === 'POST') {
   emails.push(String(init.body))
   return Response.json({ id: `email-${emails.length}` })
  }
  const sent = JSON.parse(emails[Number(url.pathname.split('-').at(-1)) - 1]!) as { to: string[]; subject: string }
  return Response.json({ object: 'email', id: url.pathname.split('/').at(-1), message_id: '<email-proof@resend.example>', to: sent.to, subject: sent.subject, last_event: 'sent' })
 })
 return emails
}
/** The business's owner and administrator, who hear about its payouts and plan; its member does not. */
async function ownersAndAdmins(db: D1Database) {
 for (const role of ['owner', 'admin']) {
  await db.prepare('INSERT INTO user(id,name,email,emailVerified) VALUES(?,?,?,1)').bind(role, role, `${role}@mail-fixture.blawby.com`).run()
  await db.prepare('INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,1)').bind(`${role}-member`, ORG, role, role).run()
 }
}
const sentMail = (emails: string[]) => emails.map(body => JSON.parse(body) as { to: string[]; subject: string; html: string })

test('a card is authorized, booked, then captured, and an expired payment window stops confirmation before Stripe is asked', { timeout: 120_000 }, async t => {
 const { db, runtime, env: bootEnv, events } = await boot()
 try {
  const env = stripeEnv(bootEnv)
  await db.prepare("INSERT INTO stripe_connected_accounts(id,organization_id,stripe_account_id,livemode,country,status,created_at,updated_at) VALUES('connected',?,'acct_seller',0,'US','ready',?,?)").bind(ORG, NOW, NOW).run()
  const statuses: Record<string, string> = { lapsed: 'requires_confirmation', direct: 'requires_confirmation', authenticating: 'requires_confirmation' }
  const expiryWhenAsked: Record<string, string> = {}
  const bookedWhenCaptured: Record<string, number> = {}
  const calls = fakeStripe(t, async (url, init) => {
   const [, , resource, id, action] = url.pathname.split('/')
   if (resource !== 'payment_intents' || init?.method !== 'POST') return null
   const paymentId = id!.slice(3)
   if (action === 'confirm') {
    expiryWhenAsked[paymentId] = (await holdOf(db, paymentId))!.expires_at
    statuses[paymentId] = paymentId === 'direct' ? 'requires_capture' : 'requires_action'
   }
   if (action === 'capture') bookedWhenCaptured[paymentId] = await db.prepare('SELECT count(*) n FROM payment_checkout_holds h JOIN bookings b ON b.id=h.converted_booking_id WHERE h.payment_id=?').bind(paymentId).first<number>('n') ?? 0
   return null
  }, statuses)
  const stripe = getStripe(env)
  const confirm = (id: string, claim: string) => confirmPayment(db, env, ORG, id, claim, { payment_method_id: 'pm_proof', total: 10000 }, 'https://payments.proof.example')

  // An expired purchase never reaches Stripe confirmation.
  const lapsed = await confirmable(db, 'lapsed', inMinutes(-1), inMinutes(-1))
  await assert.rejects(() => confirm('lapsed', lapsed), error => error instanceof HTTPError && error.statusCode === 409 && (error.data as { code: string }).code === 'payment_expired')
  assert.deepEqual(calls.confirm, [])
  assert.equal(await db.prepare('SELECT count(*) n FROM bookings').first('n'), 0)

  // Authorization leaves the checkout expiry alone. The money moves only after the booking exists.
  const directExpiry = inMinutes(15)
  const direct = await confirmable(db, 'direct', directExpiry, directExpiry)
  assert.deepEqual(await confirm('direct', direct), { status: 'succeeded', taken: false, client_secret: null, requires_action: false, bank_verification_url: null })
  assert.equal(expiryWhenAsked.direct, directExpiry)
  assert.deepEqual(bookedWhenCaptured, { direct: 1 })
  assert.equal((await holdOf(db, 'direct'))?.status, 'converted')
  assert.equal(await db.prepare('SELECT count(*) n FROM bookings').first('n'), 1)
  assert.equal((await requirePayment(db, ORG, 'direct')).captured_amount, 10000)

  // For 3DS, the browser gets the secret and the booking waits for the authorization webhook.
  await db.prepare("UPDATE product_sessions SET capacity=2 WHERE id='session'").run()
  const authExpiry = inMinutes(15)
  const authenticating = await confirmable(db, 'authenticating', authExpiry, authExpiry)
  assert.deepEqual(await confirm('authenticating', authenticating), { status: 'requires_action', taken: false, client_secret: 'pi_authenticating_secret', requires_action: true, bank_verification_url: null })
  assert.deepEqual(await holdOf(db, 'authenticating'), { status: 'active', expires_at: authExpiry })
  assert.equal((await requirePayment(db, ORG, 'authenticating')).subject_id, null)
  assert.equal(await db.prepare('SELECT count(*) n FROM bookings').first('n'), 1)
  assert.deepEqual(calls.capture, ['direct'])
  statuses.authenticating = 'requires_capture'
  const event = { id: 'evt_authorized', type: 'payment_intent.amount_capturable_updated', account: 'acct_seller', livemode: false, data: { object: { id: 'pi_authenticating', metadata: { blawby_payment_id: 'authenticating' } } } } as unknown as Stripe.Event
  await processPaymentEvent(db, stripe, event, env)
  assert.deepEqual(bookedWhenCaptured, { direct: 1, authenticating: 1 })
  assert.equal((await requirePayment(db, ORG, 'authenticating')).captured_amount, 10000)
  assert.deepEqual(calls.billed, [], 'checkout and webhook finish before meter delivery')
  await events.drain(env, 'payment.captured')
  assert.deepEqual(calls.billed, ['krabiclaw_captured_volume:10000', 'krabiclaw_captured_volume:10000'], 'each capture is billed on the business’s meter')
  assert.equal(await db.prepare('SELECT count(*) n FROM bookings').first('n'), 2)
 } finally { await runtime.dispose() }
})

test('a redirect that Stripe captures returns to the guest site and settles one booking, or refunds if its seat is gone', { timeout: 120_000 }, async t => {
 const { db, runtime, env: bootEnv, events } = await boot()
 try {
  const env = stripeEnv(bootEnv)
  await db.prepare("INSERT INTO stripe_connected_accounts(id,organization_id,stripe_account_id,livemode,country,status,created_at,updated_at) VALUES('connected',?,'acct_seller',0,'US','ready',?,?)").bind(ORG, NOW, NOW).run()
  const claim = await confirmable(db, 'redirect', inMinutes(15))
  const statuses = { redirect: 'requires_confirmation', taken: 'succeeded' }
  const origin = 'http://payments.localhost:3273'
  let returnUrl: string | null = null
  const calls = fakeStripe(t, (url, init) => {
   if (url.pathname === '/v1/payment_intents/pi_redirect/confirm') {
    returnUrl = new URLSearchParams(String(init?.body)).get('return_url')
    statuses.redirect = 'requires_action'
   }
   return null
  }, statuses)
  const app = new H3()
  app.use(event => {
   event.context.organizationId = ORG
   event.context.tenantType = 'tenant'
   event.context.tenantHost = 'payments.localhost'
  })
  app.post('/api/public/payments/:payment_id/confirm', paymentConfirmRoute)
  app.get('/api/public/booking-requests/:conversation_id', bookingReceiptRoute)
  const request = (path: string, init?: RequestInit) => app.request(Object.assign(new Request(origin + path, init), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
  const confirmed = await request('/api/public/payments/redirect/confirm', {
   method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claim, payment_method_id: 'pm_proof', total: 10000 }),
  })
  assert.equal(confirmed.status, 200)
  assert.equal((await confirmed.json() as { requires_action: boolean }).requires_action, true)
  assert.equal(returnUrl, `${origin}/pay/redirect?claim=${claim}`)
  assert.equal((await requirePayment(db, ORG, 'redirect')).subject_id, null)

  // Stripe sends the guest back before the success webhook arrives.
  statuses.redirect = 'succeeded'
  const trace = new H3Event(new Request(origin + '/api/public/payments/redirect/return'))
  const requestDb = instrumentD1(trace, db.withSession('first-primary'), db)
  const returnPayment = (client: typeof requestDb) => completePaymentReturn(client, { ...env, DB: client }, ORG, 'redirect', claim,
   async () => 'guest', undefined, async () => ({ locale: 'en', source: true }), async () => 'guest')
  const receipt = await returnPayment(requestDb)
  assert.equal(receipt.state, 'paid')
  if (receipt.state !== 'paid' || receipt.kind !== 'booking') throw new Error('Expected a booking receipt')
  assert.equal(receipt.booking?.status, 'confirmed')
  assert.deepEqual(receipt.booking?.paid, { amount: 10000, currency: 'USD' })
  const { batchRoundTrips, singleStatementRoundTrips } = getRequestDataMetrics(trace)
  // This provider session reads the attorney's availability and its older purchase reads two attribution rows.
  assert.deepEqual({ batchRoundTrips, singleStatementRoundTrips }, { batchRoundTrips: 1, singleStatementRoundTrips: 4 })
  const response = await request('/api/public/booking-requests/' + receipt.conversation_id, { headers: { authorization: `Bearer ${receipt.cancellation_token}` } })
  assert.equal(response.status, 200)
  const { booking } = await response.json() as { booking: { status: string } }
  assert.equal(booking.status, 'confirmed')
  const stripe = getStripe(env)
  const deliver = (id: string, event = `evt_${id}`) => processPaymentEvent(db, stripe, { id: event, type: 'payment_intent.succeeded', account: 'acct_seller', livemode: false,
   data: { object: { id: `pi_${id}`, metadata: { krabiclaw_payment_id: id } } } } as unknown as Stripe.Event, env)
  await deliver('redirect')
  assert.deepEqual(await returnPayment(db), receipt)
  const booked = await requirePayment(db, ORG, 'redirect')
  assert.ok(booked.subject_id)
  assert.equal(booked.captured_amount, 10000)
  assert.equal(booked.claimed_user_id, 'guest')

  const capture = events.take('payment.captured')
  assert.ok(capture, 'a settled redirect queues the captured payment')
  for (const delivery of ['first', 'redelivery']) {
   const trace = new H3Event(new Request(origin + '/queue/payment-captured'))
   const deliveryEnv = { ...env, DB: instrumentD1(trace, db, db) }
   await events.deliver(deliveryEnv, capture)
   assert.equal(await db.prepare("SELECT count(*) FROM messages WHERE conversation_id=? AND event_name='payment.payment_captured'")
    .bind(receipt.conversation_id).first('count(*)'), 1)
   const { batchRoundTrips, singleStatementRoundTrips, statementCount, rowsRead, rowsWritten } = getRequestDataMetrics(trace)
   t.diagnostic(JSON.stringify({ delivery, batchRoundTrips, singleStatementRoundTrips, statementCount, rowsRead, rowsWritten }))
  }

  await confirmable(db, 'taken', inMinutes(15))
  await deliver('taken')
  await deliver('taken', 'evt_taken_repeat')
  const refunded = await requirePayment(db, ORG, 'taken')
  assert.deepEqual([refunded.subject_id, refunded.captured_amount, refunded.refunded_amount], [null, 10000, 10000])
  assert.equal((await holdOf(db, 'taken'))?.status, 'released')
  assert.equal(await db.prepare('SELECT count(*) n FROM bookings').first('n'), 1)
  assert.deepEqual([calls.capture, calls.cancel, calls.refund], [[], [], ['pi_taken']])
 } finally { await runtime.dispose() }
})

test('the checkout return reuses a booking the webhook saved while Stripe was responding', { timeout: 120_000 }, async t => {
 const { db, runtime, env: bootEnv, events } = await boot()
 try {
  const env = stripeEnv(bootEnv)
  await db.prepare("INSERT INTO stripe_connected_accounts(id,organization_id,stripe_account_id,livemode,country,status,created_at,updated_at) VALUES('connected',?,'acct_seller',0,'US','ready',?,?)").bind(ORG, NOW, NOW).run()
  const claim = await confirmable(db, 'webhook-wins', inMinutes(15))
  const host = 'payments.localhost'
  const language = { locale: 'en', source: true }
  const plan = await preparePaymentReturn({ query: '?', params: [ORG] }, 'webhook-wins', claim)
  const row = await db.prepare(plan.query).bind(...plan.params).first()
  const sealed = await sealPaymentReturnDocument(env.BETTER_AUTH_SECRET, host, claim, row, language)
  assert.ok(sealed)
  assert.equal(await openPaymentReturnDocument(env.BETTER_AUTH_SECRET, 'other.localhost', 'webhook-wins', claim, sealed), null)
  const document = await openPaymentReturnDocument(env.BETTER_AUTH_SECRET, host, 'webhook-wins', claim, sealed)
  assert.ok(document)
  const tenant = { query: "SELECT id FROM organization WHERE subdomain=? AND status='active'", params: ['payments'] }
  const unauthorized = paymentReturnDocumentGuard({ ...tenant, params: ['blawby'] }, document)
  await assert.rejects(db.batch([db.prepare(unauthorized.query).bind(...unauthorized.params ?? [])]), /PAYMENT_RETURN_DOCUMENT_STALE/)
  const trace = new H3Event(new Request('http://payments.localhost/api/public/payments/webhook-wins/return'))
  const requestDb = instrumentD1(trace, db.withSession('first-primary'), db)
  let webhook: Promise<void> | undefined
  const calls = fakeStripe(t, async (url, init) => {
   if (!webhook && init?.method === 'GET' && url.pathname === '/v1/payment_intents/pi_webhook-wins') {
    webhook = processPaymentEvent(db, stripe, { id: 'evt_webhook_wins', type: 'payment_intent.succeeded', account: 'acct_seller',
     livemode: false, data: { object: { id: 'pi_webhook-wins', metadata: { blawby_payment_id: 'webhook-wins' } } } } as unknown as Stripe.Event, env)
    await webhook
   }
   return null
  }, { 'webhook-wins': 'succeeded' })
  const stripe = getStripe(env)
  const receipt = await completePaymentReturn(requestDb, { ...env, DB: requestDb }, ORG, 'webhook-wins', claim,
   async () => 'guest', undefined, async () => language, async () => 'guest',
   { ...document, userId: 'guest', guard: paymentReturnDocumentGuard(tenant, document) })
  assert.ok(webhook)
  await webhook
  assert.equal(receipt.state, 'paid')
  if (receipt.state !== 'paid' || receipt.kind !== 'booking') throw new Error('Expected a booking receipt')
  assert.equal(receipt.booking?.status, 'confirmed')
  assert.deepEqual(receipt.booking?.paid, { amount: 10000, currency: 'USD' })
  const result = await db.prepare(`SELECT b.status,p.captured_amount,p.claimed_user_id FROM bookings b
    JOIN conversations c ON c.booking_id=b.id AND c.organization_id=b.organization_id
    JOIN payments p ON p.subject_id=b.id AND p.organization_id=b.organization_id WHERE c.id=?`).bind(receipt.conversation_id).first()
  assert.deepEqual(result, { status: 'confirmed', captured_amount: 10000, claimed_user_id: 'guest' })
  assert.equal((await holdOf(db, 'webhook-wins'))?.status, 'converted')
  assert.equal(await db.prepare('SELECT count(*) n FROM bookings').first('n'), 1)
  assert.deepEqual(calls.refund, [])
  assert.ok(events.take('payment.captured'))
  assert.equal(events.take('payment.captured'), undefined)
  const { batchRoundTrips, singleStatementRoundTrips } = getRequestDataMetrics(trace)
  // This fixture reads the provider and legacy attribution while preparing the guarded batch.
  assert.deepEqual({ batchRoundTrips, singleStatementRoundTrips }, { batchRoundTrips: 1, singleStatementRoundTrips: 3 })
 } finally { await runtime.dispose() }
})

test('an authorization that lost its capacity is cancelled and never charged; capture failures are settled against the booking that exists', { timeout: 120_000 }, async t => {
 const { db, runtime, env: bootEnv, events } = await boot()
 try {
  const env = stripeEnv(bootEnv)
  await db.prepare("INSERT INTO stripe_connected_accounts(id,organization_id,stripe_account_id,livemode,country,status,created_at,updated_at) VALUES('connected',?,'acct_seller',0,'US','ready',?,?)").bind(ORG, NOW, NOW).run()
  const statuses: Record<string, string> = { taken: 'requires_capture' }
  const calls = fakeStripe(t, (url) => {
   if (url.pathname === '/v1/payment_intents/pi_voided/capture') return Response.json({ error: { type: 'api_error', message: 'Stripe could not capture' } }, { status: 500, headers: { 'stripe-should-retry': 'false' } })
   return null
  }, statuses)
  const stripe = getStripe(env)
  const deliver = (id: string, event = `evt_${id}`) => processPaymentEvent(db, stripe, { id: event, type: 'payment_intent.amount_capturable_updated', account: 'acct_seller', livemode: false, data: { object: { id: `pi_${id}`, metadata: { blawby_payment_id: id } } } } as unknown as Stripe.Event, env)
  const bookingsOf = (id: string) => db.prepare('SELECT count(*) n FROM bookings b JOIN payment_checkout_holds h ON h.converted_booking_id=b.id WHERE h.payment_id=?').bind(id).first('n')

  // Someone booked the last seat while this purchase was authorizing.
  const claim = await confirmable(db, 'taken', inMinutes(30))
  const seat = await claimSessionCapacity(db, { websiteSource: null, policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: 'product', sessionId: 'session', productVariantId: 'variant', partySize: 1 })
  await deliver('taken')
  assert.deepEqual([calls.cancel, calls.capture, calls.refund], [['taken'], [], []])
  assert.equal(await db.prepare('SELECT count(*) n FROM bookings WHERE id<>?').bind(seat.bookingId).first('n'), 0)
  assert.equal(await db.prepare("SELECT count(*) n FROM payment_refunds WHERE payment_id='taken'").first('n'), 0)
  const uncharged = await requirePayment(db, ORG, 'taken')
  assert.deepEqual([uncharged.captured_amount, uncharged.subject_id], [0, null])
  assert.equal((await requireClaimedPayment(db, env, ORG, 'taken', claim)).state, 'taken')
  await deliver('taken', 'evt_taken_again')
  assert.deepEqual([calls.cancel, calls.capture, calls.refund], [['taken'], [], []])

  await db.prepare("UPDATE product_sessions SET capacity=9 WHERE id='session'").run()

  // Stripe cancelled an authorization a booking was committed on: nothing was paid, and the business is told.
  await confirmable(db, 'voided', inMinutes(30))
  statuses.voided = 'requires_capture'
  await assert.rejects(() => deliver('voided'))
  assert.equal(await bookingsOf('voided'), 1)
  statuses.voided = 'canceled'
  await processPaymentEvent(db, stripe, { id: 'evt_voided_canceled', type: 'payment_intent.canceled', account: 'acct_seller', livemode: false, data: { object: { id: 'pi_voided', metadata: { blawby_payment_id: 'voided' } } } } as unknown as Stripe.Event, env)
  await events.runNext(env, 'payment.financial')
  assert.equal(await db.prepare("SELECT count(*) n FROM messages WHERE conversation_id='request-voided' AND event_name='payment.payment_failed'").first('n'), 1)
  assert.equal(await bookingsOf('voided'), 1)
  assert.equal(await db.prepare("SELECT b.status FROM payments p JOIN bookings b ON b.id=p.subject_id WHERE p.id='voided'").first('status'), 'cancelled')
 } finally { await runtime.dispose() }
})

test('a bank debit that loses its seat is cancelled, and a clearing retry records payment against one booking', { timeout: 120_000 }, async t => {
 const { db, runtime, env: bootEnv } = await boot()
 try {
  const env = stripeEnv(bootEnv)
  await db.prepare("INSERT INTO stripe_connected_accounts(id,organization_id,stripe_account_id,livemode,country,status,created_at,updated_at) VALUES('connected',?,'acct_seller',0,'US','ready',?,?)").bind(ORG, NOW, NOW).run()
  const statuses: Record<string, string> = { taken: 'processing', retried: 'processing' }
  let failNextRead = false
  const calls = fakeStripe(t, (url, init) => {
   const id = url.pathname.match(/^\/v1\/payment_intents\/pi_(taken|retried)$/u)?.[1]
   if (!id || init?.method !== 'GET') return null
   if (id === 'retried' && failNextRead) {
    failNextRead = false
    return Response.json({ error: { type: 'api_error', message: 'Stripe could not answer' } }, { status: 500, headers: { 'stripe-should-retry': 'false' } })
   }
   if (statuses[id] !== 'processing') return null
   return Response.json({ id: `pi_${id}`, object: 'payment_intent', livemode: false, currency: 'usd', amount: 10000,
    status: 'processing', payment_method: { id: 'pm_proof', type: 'us_bank_account' }, metadata: { blawby_payment_id: id } })
  }, statuses)
  const stripe = getStripe(env)
  const deliver = (id: string, event: string, type: string) => processPaymentEvent(db, stripe, { id: event, type, account: 'acct_seller', livemode: false,
   data: { object: { id: `pi_${id}`, metadata: { blawby_payment_id: id } } } } as unknown as Stripe.Event, env)

  await confirmable(db, 'taken', inMinutes(30))
  const seat = await claimSessionCapacity(db, { websiteSource: null, policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: 'product', sessionId: 'session', productVariantId: 'variant', partySize: 1 })
  await deliver('taken', 'evt_taken', 'payment_intent.processing')
  assert.deepEqual([calls.cancel, calls.capture, calls.refund], [['taken'], [], []])
  assert.equal(await db.prepare('SELECT count(*) n FROM bookings WHERE id<>?').bind(seat.bookingId).first('n'), 0)
  assert.equal((await holdOf(db, 'taken'))?.status, 'released')
  assert.equal((await requirePayment(db, ORG, 'taken')).captured_amount, 0)
  await db.prepare('DELETE FROM bookings WHERE id=?').bind(seat.bookingId).run()
  await deliver('taken', 'evt_taken_again', 'payment_intent.processing')
  assert.deepEqual(calls.cancel, ['taken'])
  assert.equal(await db.prepare('SELECT count(*) n FROM bookings').first('n'), 0)

  await confirmable(db, 'retried', inMinutes(30))
  await deliver('retried', 'evt_retried_processing', 'payment_intent.processing')
  const started = await requirePayment(db, ORG, 'retried')
  assert.ok(started.subject_id)
  // A redelivered processing webhook books nothing more.
  await deliver('retried', 'evt_retried_processing_again', 'payment_intent.processing')
  assert.equal((await requirePayment(db, ORG, 'retried')).subject_id, started.subject_id)
  assert.equal(await db.prepare('SELECT count(*) n FROM bookings').first('n'), 1)
  assert.equal(started.captured_amount, 0)
  statuses.retried = 'succeeded'
  failNextRead = true
  const cleared = () => deliver('retried', 'evt_retried_cleared', 'payment_intent.succeeded')
  await assert.rejects(cleared, /Stripe could not answer/u)
  assert.equal((await requirePayment(db, ORG, 'retried')).captured_amount, 0)
  await cleared()
  await cleared()
  const settled = await requirePayment(db, ORG, 'retried')
  assert.equal(settled.subject_id, started.subject_id)
  assert.equal(settled.captured_amount, 10000)
  assert.equal(await db.prepare('SELECT count(*) n FROM bookings').first('n'), 1)
  assert.deepEqual(calls.refund, [])
 } finally { await runtime.dispose() }
})

test('native Google unlink and full-user deletion require canonical Ads disconnect before credentials are removed', { timeout: 120_000 }, async t => {
 t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-01T12:00:00.000Z') })
 const { db, runtime, env: bootEnv } = await boot()
 try {
  const env = { ...bootEnv, BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-native-unlink-proof-secret-long-enough', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_native_unlink_boundary' }
  await db.prepare("INSERT INTO member(id,organizationId,userId,role) VALUES('unlink-owner',?,'verified','owner'),('remaining-owner',?,'other','owner')").bind(ORG, ORG).run()
  await db.prepare("INSERT INTO organization(id,name,slug,subdomain,settings_json,theme_id,default_currency,status,onboarding_status,url_structure,vertical,updated_at,timezone) VALUES('second-ads-org','Second Ads','second-ads','second-ads','{}','theme','USD','active','complete','flat','experience',?,'America/New_York')").bind(NOW).run()
  await db.prepare("INSERT INTO member(id,organizationId,userId,role) VALUES('second-admin','second-ads-org','verified','admin'),('second-owner','second-ads-org','other','owner')").run()
  await db.prepare("INSERT INTO account(id,accountId,providerId,userId,password) VALUES('unlink-credential','verified','credential','verified',?)").bind(await hashPassword('ManagedUnlinkProof123!')).run()
  await db.prepare("INSERT INTO account(id,accountId,providerId,userId) VALUES('unlink-google','google-unlink','google','verified'),('remaining-google','google-delete-many','google','verified')").run()
  await storeIntegration(db, ORG, 'google_ads', { account_id: 'unlink-google', target_id: '1234567890', target_name: 'First Ads' }, { revision: null })
  await storeIntegration(db, 'second-ads-org', 'google_ads', { account_id: 'unlink-google', target_id: '2222222222', target_name: 'Second Ads' }, { revision: null })
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Native Ads unlink prerequisites must not call a provider') })
  const auth = createAuth(env)
  const login = await auth.api.signInEmail({ body: { email: 'verified@example.com', password: 'ManagedUnlinkProof123!' }, asResponse: true })
  assert.equal(login.status, 200)
  const headers = new Headers({ cookie: login.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), origin: 'https://proof.example' })
  const unlink = () => auth.api.unlinkAccount({ body: { accountId: 'unlink-google' }, headers, asResponse: true })
  const removeUser = () => auth.api.deleteUser({ body: { password: 'ManagedUnlinkProof123!' }, headers, asResponse: true })
  const unlinkRefused = await unlink()
  assert.equal(unlinkRefused.status, 409)
  assert.match((await unlinkRefused.json() as { message: string }).message, /Disconnect Google Ads in each business/u)
  const userRefused = await removeUser()
  assert.equal(userRefused.status, 409)
  assert.match((await userRefused.json() as { message: string }).message, /Disconnect Google Ads in each business/u)
  await assert.rejects(() => auth.$context.then(context => context.internalAdapter.deleteAccounts('verified')), /Disconnect Google Ads in each business/u)
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM user WHERE id='verified'").first('n'), 1)
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM account WHERE userId='verified'").first('n'), 3)
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM session WHERE userId='verified'").first('n'), 1)
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM organization_integrations WHERE account_id='unlink-google'").first('n'), 2)
  const session = await auth.api.getSession({ headers, query: { disableCookieCache: true }, asResponse: true })
  assert.equal(session.status, 200)
  assert.equal((await session.json() as { user: { id: string } }).user.id, 'verified')
  const accountsBefore = await auth.api.listUserAccounts({ headers, asResponse: true })
  assert.equal(accountsBefore.status, 200)
  assert.equal((await accountsBefore.json() as unknown[]).length, 3)

  assert.deepEqual(await releaseIntegration(env, ORG, 'google-ads'), { product: 'google-ads', released: true })
  assert.equal((await unlink()).status, 409, 'a selection in another business still needs its own canonical disconnect')
  assert.equal((await readIntegration(db, 'second-ads-org', 'google_ads'))?.account_id, 'unlink-google')
  assert.deepEqual(await releaseIntegration(env, 'second-ads-org', 'google-ads'), { product: 'google-ads', released: true })
  const removedAccount = await unlink()
  assert.equal(removedAccount.status, 200)
  assert.deepEqual(await removedAccount.json(), { status: true })
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM account WHERE id='unlink-google'").first('n'), 0)
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM organization_integrations WHERE provider='google_ads'").first('n'), 0)
  const accountsAfter = await auth.api.listUserAccounts({ headers, asResponse: true })
  assert.equal(accountsAfter.status, 200)
  assert.equal((await accountsAfter.json() as unknown[]).length, 2)

  const removedUser = await removeUser()
  assert.equal(removedUser.status, 200)
  assert.deepEqual(await removedUser.json(), { success: true, message: 'User deleted' })
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM user WHERE id='verified'").first('n'), 0)
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM account WHERE userId='verified'").first('n'), 0)
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM session WHERE userId='verified'").first('n'), 0)
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM organization_integrations WHERE provider='google_ads'").first('n'), 0)
  const endedSession = await auth.api.getSession({ headers, query: { disableCookieCache: true }, asResponse: true })
  assert.equal(endedSession.status, 200)
  assert.equal(await endedSession.json(), null)
 } finally { await runtime.dispose() }
})

test('a payout sent and a payout failed are emailed to the business owner and administrator once each', { timeout: 120_000 }, async t => {
 const { db, runtime, env: bootEnv } = await boot()
 try {
  const env = resendEnv(stripeEnv(bootEnv))
  await db.prepare("INSERT INTO stripe_connected_accounts(id,organization_id,stripe_account_id,livemode,country,status,created_at,updated_at) VALUES('connected',?,'acct_seller',0,'US','ready',?,?)").bind(ORG, NOW, NOW).run()
  await ownersAndAdmins(db)
  const emails = resendOutbox(t)
  fakeStripe(t, (url) => {
   const payout = /^\/v1\/payouts\/po_(paid|failed)$/u.exec(url.pathname)?.[1]
   return payout ? Response.json({ id: `po_${payout}`, object: 'payout', livemode: false, amount: 25000, currency: 'usd', status: payout, arrival_date: 1_791_209_600 }) : null
  }, {})
  const stripe = getStripe(env)
  const deliver = (status: 'paid' | 'failed') => processPaymentEvent(db, stripe, { id: `evt_payout_${status}`, type: `payout.${status}`, account: 'acct_seller', livemode: false, data: { object: { id: `po_${status}`, object: 'payout' } } } as unknown as Stripe.Event, env)

  await deliver('paid')
  await deliver('failed')
  // Stripe delivers an event again; nobody is emailed twice.
  await deliver('paid')
  const mail = sentMail(emails)
  assert.deepEqual(mail.map(sent => [sent.subject, String(sent.to)]).sort(), [
   ['Payout failed', 'admin@mail-fixture.blawby.com'], ['Payout failed', 'owner@mail-fixture.blawby.com'],
   ['Payout paid', 'admin@mail-fixture.blawby.com'], ['Payout paid', 'owner@mail-fixture.blawby.com'],
  ], 'owners and admins hear; the business\'s member does not')
  for (const sent of mail) {
   assert.match(sent.html, /\$250\.00 USD/u)
   assert.match(sent.html, /href="https:\/\/proof\.example\/dashboard\/payments\/earnings\/payouts"/u)
  }
  assert.match(mail.find(sent => sent.subject === 'Payout paid')!.html, /Oct 5, 2026/u)
  assert.match(mail.find(sent => sent.subject === 'Payout failed')!.html, /Review your payout details in Stripe\./u)
  // Each send is recorded as sent by Resend, to the person it went to.
  const receipts = (await db.prepare("SELECT provider, status, json_extract(email_json, '$.message.subject') subject, json_extract(email_json, '$.message.to') recipient FROM guest_thread_deliveries WHERE channel = 'email' ORDER BY subject, recipient").all()).results
  assert.deepEqual(receipts, [
   { provider: 'resend', status: 'sent', subject: 'Payout failed', recipient: 'admin@mail-fixture.blawby.com' },
   { provider: 'resend', status: 'sent', subject: 'Payout failed', recipient: 'owner@mail-fixture.blawby.com' },
   { provider: 'resend', status: 'sent', subject: 'Payout paid', recipient: 'admin@mail-fixture.blawby.com' },
   { provider: 'resend', status: 'sent', subject: 'Payout paid', recipient: 'owner@mail-fixture.blawby.com' },
  ])
 } finally { await runtime.dispose() }
})

test('Better Auth trusts billing and connection callbacks from either registered app scheme', async t => {
 const { runtime, env } = await boot()
 try {
  const fetchNetwork = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
   const url = new URL(request instanceof Request ? request.url : String(request))
   return (url.hostname === 'api.stripe.com' && publishedCatalogResponse(url)) || fetchNetwork(request, init)
  })
  const auth = await createAuth(stripeEnv(env)).$context
  for (const scheme of ['blawby', 'krabiclaw']) {
   assert.equal(auth.isTrustedOrigin(`${scheme}://billing/success`), true)
   assert.equal(auth.isTrustedOrigin(`${scheme}://connections/google-calendar`), true)
   assert.equal(auth.isTrustedOrigin(`${scheme}://invitation?id=example`), false)
   assert.equal(auth.isTrustedOrigin(`${scheme}://billing.example/success`), false)
  }
  assert.equal(auth.isTrustedOrigin('https://appleid.apple.com'), true)
 } finally { await runtime.dispose() }
})

test('the Stripe renewal closes the old meter before delivering usage held for its replacement', { timeout: 120_000 }, async t => {
 const { db, runtime, env: bootEnv } = await boot()
 try {
  const secret = 'whsec_meter_renewal'
  const env = { ...stripeEnv(bootEnv), STRIPE_WEBHOOK_SECRET: secret, STRIPE_BILLING_METER_MIGRATION: 'true' } as CloudflareEnv
  const renewal = Math.floor(Date.now() / 1000) - 120
  const period = { current_period_start: renewal, current_period_end: renewal + 31 * 86400 }
  const metadata: Record<string, string> = { blawby_meter_renewal: String(renewal) }
  const contract = {
   id: 'sub_meter_renewal', customer: 'cus_operating', status: 'active', schedule: null, pending_update: null, cancel_at_period_end: false, cancel_at: null,
   billing_mode: { type: 'flexible' }, metadata,
   items: { has_more: false, data: [
    { id: 'si_base', ...period, price: { id: 'price-base', product: { metadata: { plan_id: 'business' } } } },
    { id: 'si_ads', ...period, price: { id: 'price-ad_spend', tax_behavior: 'unspecified', product: { metadata: { product_family: 'ad_spend' } } } },
    { id: 'si_addon', ...period, price: { id: 'price-addon', product: { metadata: {} } } },
   ] },
  }
  await db.prepare("INSERT INTO subscription(id,plan,referenceId,stripeCustomerId,stripeSubscriptionId,status,seats) VALUES('sub-row','business',?,'cus_operating','sub_meter_renewal','active',1)").bind(ORG).run()
  await db.prepare("INSERT INTO usage_events(id,organization_id,resource,unit,quantity,idempotency_key,provider_occurred_at,created_at,source) VALUES('during-renewal',?,'ad_spend','USD',125,'ads:renewing',?,?,'payments')").bind(ORG,NOW,NOW).run()
  const realFetch = globalThis.fetch
  const reported: string[] = []
  let changes = 0
  t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
   const url = new URL(request instanceof Request ? request.url : String(request))
   if (url.hostname !== 'api.stripe.com') return realFetch(request, init)
   const catalog = publishedCatalogResponse(url, 'legacy')
   if (catalog) {
    const list = await catalog.json() as { data: Array<{ id: string; event_name?: string; recurring?: { meter: string } }> }
    const additional = url.pathname === '/v1/prices'
     ? list.data.map(price => ({ ...price, id: `replacement-${price.id}`, tax_behavior: 'unspecified', recurring: { ...price.recurring, meter: `replacement-${price.recurring!.meter}` } }))
     : url.pathname === '/v1/billing/meters'
      ? list.data.map(meter => ({ ...meter, id: `replacement-${meter.id}`, event_name: meter.event_name!.replace('krabiclaw_', 'blawby_') }))
      : []
    const entries = url.pathname === '/v1/products'
    ? list.data.map(product => ({ ...product, metadata: { product_family: product.id.slice(5), monthly_price_id: `replacement-price-${product.id.slice(5)}` } }))
    : list.data
   return Response.json({ ...list, data: [...entries, ...additional] })
   }
   if (url.pathname === '/v1/subscriptions/sub_meter_renewal') {
    if (init?.method === 'POST') {
     const form = new URLSearchParams(String(init.body))
     assert.deepEqual(Object.fromEntries(form), {
      'items[0][id]': 'si_ads', 'items[0][price]': 'replacement-price-ad_spend',
      billing_cycle_anchor: 'unchanged', proration_behavior: 'none', 'metadata[blawby_meter_renewed]': String(renewal),
     })
     contract.items.data[1]!.price.id = 'replacement-price-ad_spend'
     metadata.blawby_meter_renewed = String(renewal)
     changes++
    }
    return Response.json(contract)
   }
   if (url.pathname === '/v1/billing/meter_events') {
    const form = new URLSearchParams(String(init?.body))
    const name = form.get('event_name')!
    const identifier = form.get('identifier')!
    assert.equal(form.get('payload[value]'), '125')
    assert.equal(identifier, new Headers(init?.headers).get('idempotency-key'))
    if (name.startsWith('blawby_')) assert.equal(changes, 1)
    reported.push(name)
    return Response.json({ object: 'billing.meter_event', event_name: name, identifier, timestamp: renewal, payload: {} })
   }
   throw new Error(`Unexpected Stripe request ${init?.method} ${url.pathname}`)
  })

  await assert.rejects(() => deliverPaymentsUsage(db, env, ORG), /not yet activated the replacement meter/)
  assert.equal(await db.prepare("SELECT delivery_at FROM usage_events WHERE id='during-renewal'").first('delivery_at'), null)
  const payload = JSON.stringify({ id: 'evt_meter_invoice', object: 'event', type: 'invoice.finalized', data: { object: {
   id: 'in_renewed', customer: 'cus_operating', billing_reason: 'subscription_cycle', period_end: renewal,
   parent: { subscription_details: { subscription: contract.id, metadata: { ...metadata } } },
  } } })
  const signer = new Stripe('sk_test_signer')
  const signature = await signer.webhooks.generateTestHeaderStringAsync({ payload, secret })
  for (let attempt = 0; attempt < 2; attempt++) {
   const response = await createAuth(env).handler(new Request('https://proof.example/api/auth/stripe/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body: payload,
   }))
   assert.equal(response.status, 200, await response.text())
  }
  const delivered = await db.prepare("SELECT delivery_at, error FROM usage_events WHERE id='during-renewal'").first()
  assert.ok(delivered?.delivery_at)
  assert.equal(delivered.error, null)
  assert.deepEqual(reported, ['krabiclaw_ad_spend', 'krabiclaw_ad_spend', 'blawby_ad_spend'])
  assert.equal(changes, 1)

  // A subscription sold on the replacement price has no renewal marker.
  delete metadata.blawby_meter_renewal
  delete metadata.blawby_meter_renewed
  await db.prepare("INSERT INTO usage_events(id,organization_id,resource,unit,quantity,idempotency_key,provider_occurred_at,created_at,source) VALUES('new-contract',?,'ad_spend','USD',125,'ads:new-contract',?,?,'payments')").bind(ORG,NOW,NOW).run()
  assert.deepEqual(await deliverPaymentsUsage(db, env, ORG), { delivered: 1 })
  assert.ok(await db.prepare("SELECT delivery_at FROM usage_events WHERE id='new-contract'").first('delivery_at'))
  assert.deepEqual(reported.slice(3), ['blawby_ad_spend'])
 } finally { await runtime.dispose() }
})

test('Better Auth Stripe tells the business its new plan, its change of plan and a plan that will not renew, once each', { timeout: 120_000 }, async t => {
 const { db, runtime, env: bootEnv } = await boot()
 try {
  const secret = 'whsec_plan_proof'
  const env = { ...resendEnv(stripeEnv(bootEnv)), STRIPE_WEBHOOK_SECRET: secret } as CloudflareEnv
  await ownersAndAdmins(db)
  // Better Auth's upgrade wrote the subscription before Checkout opened.
  await db.prepare("INSERT INTO subscription(id,plan,referenceId,stripeCustomerId,status,seats) VALUES('sub-row','growth',?,'cus_operating','incomplete',1)").bind(ORG).run()
  const emails = resendOutbox(t)
  const period = { current_period_start: 1_790_000_000, current_period_end: 1_792_592_000 }
  const item = (plan: 'growth' | 'business') => ({ id: `si_${plan}`, object: 'subscription_item', quantity: 1, ...period,
   price: { id: `price_${plan}`, object: 'price', product: `prod_${plan}`, recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } } })
  const subscription = (plan: 'growth' | 'business', fields: Record<string, unknown> = {}) => ({
   id: 'sub_plan', object: 'subscription', customer: 'cus_operating', status: 'active', metadata: { subscriptionId: 'sub-row', referenceId: ORG },
   items: { object: 'list', data: [item(plan)] }, cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null, trial_start: null, trial_end: null, schedule: null, ...fields,
  })
  // Stripe's catalog: the two plans beside the published metered prices.
  const plans = (['growth', 'business'] as const).map(plan => ({
   product: { object: 'product', id: `prod_${plan}`, active: true, metadata: { plan_id: plan, monthly_price_id: `price_${plan}` } },
   price: { object: 'price', id: `price_${plan}`, product: `prod_${plan}`, active: true, currency: 'usd', type: 'recurring', billing_scheme: 'per_unit', unit_amount: plan === 'growth' ? 4900 : 14900, recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } },
  }))
  const trialing = subscription('growth', { status: 'trialing', trial_start: 1_790_000_000, trial_end: 1_791_209_600 })
  const realFetch = globalThis.fetch
  let refuseEndingOwnerEmail = true
  t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
   const url = new URL(request instanceof Request ? request.url : String(request))
   if (url.hostname === 'api.resend.com' && init?.method === 'POST') {
    const mail = JSON.parse(String(init.body)) as { subject: string; to: string[] }
    if (refuseEndingOwnerEmail && mail.subject === 'Your Business plan will not renew' && mail.to.includes('owner@mail-fixture.blawby.com')) {
     refuseEndingOwnerEmail = false
     return Response.json({ name: 'internal_server_error', message: 'Plan email temporarily unavailable' }, { status: 500 })
    }
   }
   if (url.hostname !== 'api.stripe.com') return realFetch(request, init)
   const catalog = publishedCatalogResponse(url)
   if (catalog) {
    const list = await catalog.json() as { data: unknown[] }
    const extra = url.pathname === '/v1/products' ? plans.map(plan => plan.product) : url.pathname === '/v1/prices' ? plans.map(plan => plan.price) : []
    return Response.json({ ...list, data: [...list.data, ...extra] })
   }
   if (url.pathname === '/v1/subscriptions/sub_plan') return Response.json(trialing)
   if (url.pathname === '/v1/billing/meter_events') return Response.json({ object: 'billing.meter_event', event_name: 'krabiclaw_homes', identifier: crypto.randomUUID(), payload: {}, timestamp: 1, created: 1, livemode: false })
   throw new Error(`Unexpected Stripe request ${init?.method} ${url.pathname}`)
  })
  const auth = createAuth(env)
  const signer = new Stripe('sk_test_signer')
  const deliver = async (event: Record<string, unknown>, status = 200) => {
   const payload = JSON.stringify({ object: 'event', api_version: '2025-10-29.clover', created: 1_790_000_000, livemode: false, ...event })
   const response = await auth.handler(new Request('https://proof.example/api/auth/stripe/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': await signer.webhooks.generateTestHeaderStringAsync({ payload, secret }) }, body: payload,
   }))
   assert.equal(response.status, status)
  }
  const subjects = () => sentMail(emails).map(sent => [sent.subject, String(sent.to)]).sort()

  // Checkout completes with a free trial.
  await deliver({ id: 'evt_checkout_created', type: 'customer.subscription.created', data: { object: trialing } })
  assert.equal(emails.length, 0, 'the Checkout subscription has one start notice on completion')
  await deliver({ id: 'evt_checkout', type: 'checkout.session.completed', data: { object: { id: 'cs_plan', object: 'checkout.session', mode: 'subscription', subscription: 'sub_plan', client_reference_id: ORG, metadata: { subscriptionId: 'sub-row', referenceId: ORG } } } })
  assert.deepEqual(subjects(), [['Your new plan: Growth', 'admin@mail-fixture.blawby.com'], ['Your new plan: Growth', 'owner@mail-fixture.blawby.com']])
  const started = sentMail(emails)[0]!.html
  assert.match(started, /Payments is on Growth\./u)
  assert.match(started, /Free trial ends/u)
  assert.match(started, /Oct 5, 2026/u)
  assert.match(started, /href="https:\/\/proof\.example\/dashboard\/payments\/billing"/u)

  // The business moves to Business; Stripe redelivers that event, and nobody hears twice.
  const changed = { id: 'evt_changed', type: 'customer.subscription.updated', data: { object: subscription('business'), previous_attributes: { items: { object: 'list', data: [item('growth')] } } } }
  await deliver(changed)
  await deliver(changed)
  // A renewal changes the subscription without changing its plan.
  await deliver({ id: 'evt_renewed', type: 'customer.subscription.updated', data: { object: subscription('business'), previous_attributes: { latest_invoice: 'in_previous' } } })
  assert.equal(emails.length, 4)
  assert.deepEqual(subjects().slice(2), [['Your plan changed to Business', 'admin@mail-fixture.blawby.com'], ['Your plan changed to Business', 'owner@mail-fixture.blawby.com']])
  assert.match(sentMail(emails)[2]!.html, /Payments moved from Growth to Business\./u)

  // A trial set to end sends a notice too. Stripe retries only the failed delivery.
  const ending = { id: 'evt_ending', type: 'customer.subscription.updated', data: { object: subscription('business', { status: 'trialing', cancel_at_period_end: true, trial_start: period.current_period_start, trial_end: period.current_period_end }), previous_attributes: { cancel_at_period_end: false } } }
  await deliver(ending, 400)
  assert.deepEqual(await db.prepare("SELECT plan,status,cancelAtPeriodEnd FROM subscription WHERE id='sub-row'").first(), { plan: 'business', status: 'trialing', cancelAtPeriodEnd: 1 })
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM guest_thread_deliveries WHERE channel='email' AND status='failed' AND error LIKE '%Plan email temporarily unavailable%'").first('n'), 1)
  await deliver(ending)
  await deliver(ending)
  assert.equal(emails.length, 6)
  const notRenewing = sentMail(emails).slice(4)
  assert.deepEqual(notRenewing.map(sent => [sent.subject, String(sent.to)]).sort(), [['Your Business plan will not renew', 'admin@mail-fixture.blawby.com'], ['Your Business plan will not renew', 'owner@mail-fixture.blawby.com']])
  assert.match(notRenewing[0]!.html, /Business stays on until Oct 21, 2026\. After that, Payments is on Basic\./u)

  // Read back apart from the sends: Better Auth's subscription, and each email Resend accepted.
  assert.deepEqual(await db.prepare("SELECT plan, status, cancelAtPeriodEnd FROM subscription WHERE id='sub-row'").first(), { plan: 'business', status: 'trialing', cancelAtPeriodEnd: 1 })
  assert.deepEqual((await db.prepare("SELECT json_extract(email_json, '$.message.subject') subject, count(*) n FROM guest_thread_deliveries WHERE channel='email' AND provider='resend' AND status='sent' GROUP BY subject ORDER BY subject").all()).results, [
   { subject: 'Your Business plan will not renew', n: 2 }, { subject: 'Your new plan: Growth', n: 2 }, { subject: 'Your plan changed to Business', n: 2 },
  ])
 } finally { await runtime.dispose() }
})
