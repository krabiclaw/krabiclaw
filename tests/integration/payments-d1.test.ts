import {createCanonicalNotification} from '../../server/utils/notification-center.ts'
import { OPEN_TERMS, OPEN_TERMS_JSON } from './support/booking-terms.ts'
import { publishedCatalogResponse } from './support/stripe-published-catalog.ts'
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import Stripe from 'stripe'
import { SERVICES } from '../../shared/billing-model.ts'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { HTTPError } from 'nitro'
import { Miniflare } from 'miniflare'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import * as schema from '../../server/db/schema.ts'
import { claimSessionCapacity, setProductBookingConfig } from '../../server/utils/availability.ts'
import { createProductBooking } from '../../server/domain/product-bookings.ts'
import { H3Event } from 'h3'
import { ingestStripeFeeReport, stripeFeeMinor, stripeFeeScaled } from '../../server/domain/payments/costs.ts'
import { buyerActivities, buyerPaymentActivityPath, claimCheckoutReturn, tokenHash } from '../../server/domain/payments/buyer.ts'
import { loadBuyerBookingDetails } from '../../server/utils/dashboard-booking-details.ts'
import { cancelBookingRequest, requestInsertQueries, threadPayloadForGuest } from '../../server/domain/requests.ts'
import { appendEntry } from '../../server/domain/guest-threads/entries.ts'
import { getGuestThreadDetail } from '../../server/domain/guest-threads/detail.ts'
import { getInboxThread } from '../../server/domain/guest-threads/inbox.ts'
import { listGuestThreads } from '../../server/domain/guest-threads/repository.ts'
import { receiveGuestWebReply } from '../../server/domain/guest-threads/inbound-email.ts'
import { acknowledgeBuyerThreadEntries } from '../../server/utils/notification-acknowledgement.ts'
import { retainPaymentsForTenantDeletion } from '../../server/domain/payments/retention.ts'
import { deliverPaymentsUsage, paymentsUsage } from '../../server/domain/payments/usage.ts'
import { agreeToService, endService, listServices, SERVICE_TERMS_VERSION } from '../../server/utils/organization-services.ts'
import { storeIntegration, readIntegration } from '../../server/utils/organization-integrations.ts'
import { releaseIntegration } from '../../server/utils/integration-release.ts'
import { hashPassword, symmetricEncrypt } from 'better-auth/crypto'
import { H3 } from 'nitro/h3'
import { createAuth } from '../../server/utils/auth.ts'
import servicesPostRoute from '../../server/api/dashboard/services.post.ts'
import servicesGetRoute from '../../server/api/dashboard/services.get.ts'
import mcpRoute from '../../server/api/mcp.ts'
import paymentReturnRoute from '../../server/api/public/payments/[paymentId]/return.post.ts'
import paymentCancelRoute from '../../server/api/public/payments/[paymentId]/cancel.post.ts'
import paymentHandoffRoute from '../../server/api/public/payments/[paymentId].get.ts'
import { readStayCalendar } from '../../server/domain/stays.ts'
import bookingReceiptRoute from '../../server/api/public/booking-requests/[requestId].get.ts'
import { createReplayableReservationCancelToken, hashReservationCancelToken } from '../../server/utils/reservation-cancel-token.ts'
import adSpendDailyTask from '../../server/tasks/marketing-ad-spend-daily.ts'
import { recordAdSpend, unrecordedAdSpendDays } from '../../server/domain/payments/ad-spend.ts'
import { selectGoogleAdsCustomer } from '../../server/utils/google-ads.ts'
import { getStripe } from '../../server/utils/billing.ts'
import { executeGuestThreadOperation } from '../../server/domain/guest-threads/operations.ts'
import { approveRefundAuthorization, executeRefund, readPaymentDetails, requirePayment } from '../../server/domain/payments/index.ts'
import { reviewPayment, confirmPayment, requireClaimedPayment } from '../../server/domain/payments/intent.ts'
import { reconcilePaymentIntent, processPaymentEvent } from '../../server/domain/payments/events.ts'
import { canRetryGuestVisitRefund } from '../../server/domain/payments/visit-refund.ts'
import { mcpFinancialApprovalErrorResult } from '../../server/utils/mcp-financial-handoff.ts'
import { handlePaymentsTools } from '../../server/utils/mcp-tools/payments.ts'
import { NOT_HANDLED } from '../../server/utils/mcp-tools/execution.ts'
import { resolveOrganizationMembership } from '../../server/utils/member-access.ts'
import type { McpOrganizationContext } from '../../server/utils/mcp-auth.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
const ORG = 'payments-org', NOW = '2026-10-01T00:00:00.000Z'
async function boot(){
 const runtime=new Miniflare({workers:[{config:{name:'payments-proof',compatibilityDate:'2024-11-01',manifest:{mainModule:'index.mjs',modules:{'index.mjs':{type:'esm',contents:'export class Hub { fetch(){return new Response(null,{status:204})} } export default {fetch(){return new Response("ok")}}'}}},exports:{Hub:{type:'durable-object',storage:'sqlite'}},env:{DB:{type:'d1'},ORGANIZATION_CACHE:{type:'kv'},GUEST_INBOX_HUBS:{type:'durable-object',worker:'payments-proof',exportName:'Hub'}}}}]})
 const db=await runtime.getD1Database('DB')
 try {
 const migration=await generateSQLiteMigration(await generateSQLiteDrizzleJson({}),await generateSQLiteDrizzleJson(schema))
 await db.batch(migration.map(query=>db.prepare(query)))
 // A business taking payments is billed for them on its plan's Stripe customer, and the platform site records what it billed.
 await db.prepare(`INSERT INTO organization(id,name,slug,subdomain,settings_json,theme_id,default_currency,status,onboarding_status,url_structure,vertical,updated_at, timezone, "stripeCustomerId") VALUES(?,'Payments','payments','payments','{}','theme','USD','active','complete','flat','experience',?, 'America/New_York','cus_operating')`).bind(ORG,NOW).run()
 await db.prepare(`INSERT INTO organization(id,name,slug,subdomain,settings_json,theme_id,default_currency,status,onboarding_status,url_structure,vertical,updated_at,timezone) VALUES('platform','KrabiClaw','krabiclaw','krabiclaw','{}','krabiclaw-theme-v1','USD','active','complete','flat','service',?,'America/Los_Angeles')`).bind(NOW).run()
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
 const env={...await runtime.getBindings<CloudflareEnv>(),BETTER_AUTH_URL:'https://proof.example',BETTER_AUTH_SECRET:'local-proof-secret-long-enough-for-auth',NUXT_PUBLIC_PLATFORM_DOMAIN:'https://proof.example'} as CloudflareEnv
 return {db,runtime,env}
 }catch(error){await runtime.dispose();throw error}
}
async function payable(db:D1Database,id:string,expires='2099-09-30T00:00:00.000Z'){
 await db.prepare("INSERT INTO payments(id,organization_id,buyer_user_id,stripe_account_id,livemode,subject_type,currency,amount,price_snapshot_json,created_at,updated_at) VALUES(?,?,'guest','acct_seller',0,'booking','USD',10000,?,?,?)").bind(id,ORG,JSON.stringify({title:'Consultation',tax_code:null,price:{unit_amount:10000,currency:'USD',tax_behavior:'exclusive'},quantity:1,automatic_tax:false,method_configuration_id:'pmc_seller',policy:{...OPEN_TERMS,payment:{basis:'per_guest',unit_amount:10000,currency:'USD',tax_behavior:'exclusive',min_party_size:null}},answers:[]}),NOW,NOW).run()
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
  db.prepare("INSERT INTO product_booking_configs(product_id,organization_id,unit,duration_minutes,default_capacity,confirmation_mode,held_online,scheduling_mode,assigned_member_id,online_payment_required,payment_basis,created_by,updated_by) VALUES('tables',?,'slot',120,1,'instant',0,'business','host-member',1,'per_booking','host','host')").bind(ORG),
  db.prepare("INSERT INTO product_sessions(id,organization_id,product_id,location_id,timezone,starts_at,ends_at,capacity,status,created_by,updated_by) VALUES('seating',?,'tables','dining','UTC','2099-10-01T13:00:00.000Z','2099-10-01T15:00:00.000Z',1,'scheduled','host','host')").bind(ORG),
 ])
}
const seatingRemaining = async (db: D1Database) => db.prepare("SELECT s.capacity - COALESCE((SELECT SUM(b.party_size) FROM bookings b WHERE b.product_session_id = s.id AND b.status IN ('pending','confirmed')), 0) AS remaining FROM product_sessions s WHERE s.id = 'seating'").first<number>('remaining')

/** A table booked with its deposit captured: the guest's request, the deposit Stripe charged, and the booking it made. */
async function paidTable(db: D1Database, env: CloudflareEnv) {
 await diningTables(db)
 const opening = { id: 'deposit-request', kind: 'booking' as const, organization_id: ORG, location_id: 'dining', user_id: 'verified', review_id: null, payload: { ...threadPayloadForGuest({ name: 'Verified', email: 'verified@example.com', phone: '+12025550123' }), cancellation: { token_hash: 'deposit-token-hash', expires_at: '2100-01-01T00:00:00.000Z', used_at: null } }, created_at: NOW, updated_at: NOW }
 await db.batch(requestInsertQueries(opening).map(write => db.prepare(write.query).bind(...write.params)))
 const booking = await claimSessionCapacity(db, { policyJson: JSON.stringify(TABLE_TERMS), env, organizationId: ORG, productId: 'tables', sessionId: 'seating', productVariantId: 'table-variant', partySize: 1, userId: 'verified', requestId: opening.id })
 await db.prepare("INSERT INTO payments(id,organization_id,buyer_user_id,stripe_account_id,livemode,subject_type,subject_id,location_id,currency,amount,tax_amount,captured_amount,stripe_payment_intent_id,stripe_charge_id,price_snapshot_json,created_at,updated_at) VALUES('deposit',?,'verified','acct_seller',0,'booking',?,'dining','USD',10000,500,10500,'pi_deposit','ch_deposit',?,?,?)")
  .bind(ORG, booking.bookingId, JSON.stringify({ title: 'Dining tables', tax_code: null, price: { unit_amount: 10000, currency: 'USD', tax_behavior: 'exclusive' }, quantity: 1, automatic_tax: false, method_configuration_id: 'pmc_seller', policy: TABLE_TERMS }), NOW, NOW).run()
 await db.prepare("INSERT INTO payment_checkout_holds(id,organization_id,product_id,variant_id,price_id,session_id,location_id,timezone,buyer_user_id,request_id,payment_id,quantity,amount,currency,starts_at,ends_at,status,expires_at,created_at,converted_booking_id) VALUES('deposit-hold',?,'tables','table-variant','table-price','seating','dining','UTC','verified','deposit-request','deposit',1,10000,'USD','2099-10-01T13:00:00.000Z','2099-10-01T15:00:00.000Z','converted','2100-01-01T00:00:00.000Z',?,?)").bind(ORG, NOW, booking.bookingId).run()
 return { id: opening.id, organizationId: ORG, kind: 'booking' as const, env, bookingId: booking.bookingId }
}

test('guest table cancellation refunds until 24 hours before the start, through Stripe full remaining refund for both buyer and token credentials', { timeout: 120_000 }, async t => {
 for (const credentials of [{ buyerUserId: 'verified' }, { tokenHash: 'deposit-token-hash' }]) {
  for (const policy of [{ now: '2099-09-30T13:00:00.000Z', refundable: true }, { now: '2099-09-30T13:00:00.001Z', refundable: false }]) {
   const { db, runtime } = await boot()
   try {
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-proof-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only', STRIPE_SECRET_KEY: 'sk_test_local_boundary' }
    const paid = await paidTable(db, env)
    const input = { ...paid, ...credentials, now: policy.now }
    const originalFetch = globalThis.fetch
    let creations = 0
    const fetchMock = t.mock.method(globalThis, 'fetch', async (request, init) => {
     const url = new URL(request instanceof Request ? request.url : String(request))
     if (url.origin !== 'https://api.stripe.com') return originalFetch(request, init)
     assert.equal(new Headers(init?.headers).get('stripe-account'), 'acct_seller')
     if (url.pathname === '/v1/refunds' && init?.method === 'POST') {
      creations++
      const params = new URLSearchParams(String(init.body))
      assert.equal(params.get('payment_intent'), 'pi_deposit')
      assert.equal(params.has('amount'), false)
      assert.equal(new Headers(init.headers).get('idempotency-key'), `krabiclaw-refund:deposit:guest-cancelled-booking:${paid.bookingId}`)
      return Response.json({ id: 're_deposit', object: 'refund', amount: 10500, currency: 'usd', status: 'succeeded', payment_intent: 'pi_deposit', reason: 'requested_by_customer', metadata: { krabiclaw_refund_id: params.get('metadata[krabiclaw_refund_id]') } })
     }
     assert.equal(init?.method, 'GET')
     assert.equal(url.pathname, '/v1/charges/ch_deposit')
     return Response.json({ id: 'ch_deposit', object: 'charge', livemode: false, amount: 10500, amount_refunded: 10500, currency: 'usd', payment_intent: 'pi_deposit', billing_details: { email: 'verified@example.com' } })
    })
    try {
     assert.equal(await seatingRemaining(db), 0)
     assert.equal((await cancelBookingRequest(db, input))?.changed, true)
     assert.deepEqual(await db.prepare('SELECT status,cancellation_reason FROM bookings WHERE id=?').bind(paid.bookingId).first(), { status: 'cancelled', cancellation_reason: 'guest_cancelled' })
     assert.equal(await db.prepare("SELECT json_extract(payload_json,'$.cancellation.used_at') used_at FROM requests WHERE id='deposit-request'").first('used_at'), policy.now)
     assert.deepEqual(await db.prepare("SELECT refunded_amount FROM payments WHERE id='deposit'").first(), { refunded_amount: policy.refundable ? 10500 : 0 })
     assert.deepEqual((await db.prepare("SELECT amount,status,created_by FROM payment_refunds WHERE payment_id='deposit'").all()).results, policy.refundable ? [{ amount: 10500, status: 'succeeded', created_by: 'buyerUserId' in credentials ? 'verified' : null }] : [])
     assert.equal(creations, Number(policy.refundable))
     assert.equal(await seatingRemaining(db), 1)
    } finally { fetchMock.mock.restore() }
   } finally { await runtime.dispose() }
  }
 }
})

test('a table deposit is the table price once, only for parties at its threshold, and a booking keeps the terms it was made with', { timeout: 120_000 }, async () => {
 const { db, runtime } = await boot()
 try {
  const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_URL: 'https://payments.proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-proof-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only', STRIPE_SECRET_KEY: 'sk_test_local_boundary' } as CloudflareEnv
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
  const counts = async () => db.prepare('SELECT (SELECT COUNT(*) FROM bookings) bookings,(SELECT COUNT(*) FROM requests) requests,(SELECT COUNT(*) FROM payments) payments,(SELECT COUNT(*) FROM payment_checkout_holds) holds').first()

  // A party of six pays the deposit: the business's assistant cannot take that money and books nothing.
  const before = await counts()
  await assert.rejects(createProductBooking(event('/api/mcp'), { organizationId: ORG, slug: 'tables', financialWritesAllowed: false,
   operator: { userId: 'host', idempotencyKey: 'six', source: 'operator', externalReference: null, guestAcknowledgement: false },
   body: { guest_name: 'Six', guest_email: 'six@example.com', guest_phone: '+12025550123', session_id: 'soon', party_size: 6 } }),
  (error: HTTPError) => error.statusCode === 409 && (error.data as { code?: string }).code === 'financial_action_required')
  assert.deepEqual(await counts(), before)

  // A party of five books on the site without paying, told the deposit it would owe as a party of six: the price once, not per guest.
  const five = await createProductBooking(event('/api/public/products/tables/bookings'), { organizationId: ORG, slug: 'tables',
   body: { guest_name: 'Five', guest_email: 'five@example.com', guest_phone: '+12025550123', session_id: 'soon', party_size: 5, idempotency_key: 'five' } })
  assert.equal(five.status, 201, JSON.stringify(five.body))
  const booked = five.body.policy_summary as { heading: string; items: Array<{ id: string; text: string }> }
  assert.deepEqual(booked.items.map(item => item.id), ['cancellation', 'deposit', 'deposit_amount'])
  assert.match(booked.items[1]!.text, /\b6\b/u)
  assert.match(booked.items[2]!.text, /\$100\.00/u)
  assert.deepEqual(await db.prepare('SELECT COUNT(*) n FROM payments').first('n'), 0)

  // The business later asks two days' notice and caps parties at four.
  await setProductBookingConfig(db, { organizationId: ORG, productId: 'tables', actorId: 'host', env, patch: { advance_notice_minutes: 2880, party_size_max: 4 } })

  // The guest's receipt, read back through the business's receipt endpoint, still states the terms they booked.
  const app = new H3()
  app.use((event) => { event.context.organizationId = ORG })
  app.get('/api/public/booking-requests/:requestId', bookingReceiptRoute)
  const read = await app.request(Object.assign(new Request(`https://payments.proof.example/api/public/booking-requests/${String(five.body.request_id)}`, { headers: { authorization: `Bearer ${String(five.body.cancellation_token)}` } }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
  assert.equal(read.status, 200, await read.clone().text())
  const receipt = (await read.json() as { booking: { guests: string; policy_summary: unknown; advance_notice_minutes: number | null } }).booking
  assert.deepEqual([receipt.guests, receipt.policy_summary, receipt.advance_notice_minutes], ['5', booked, null])
  // And they can still cancel it online tomorrow's seating, as the terms they booked allow.
  const cancelled = await cancelBookingRequest(db, { id: String(five.body.request_id), organizationId: ORG, kind: 'booking', now: new Date().toISOString(), env, tokenHash: await hashReservationCancelToken(String(five.body.cancellation_token)) })
  assert.equal(cancelled?.changed, true)
  assert.equal(await db.prepare('SELECT status FROM bookings WHERE id=?').bind(String(five.body.operational_booking_id)).first('status'), 'cancelled')
 } finally { await runtime.dispose() }
})

test('a checkout thread stays out of Messages until payment creates its booking', { timeout: 120_000 }, async () => {
 const { db, runtime, env } = await boot()
 try {
  const provenance = { source: 'website', external_reference: null, actor_user_id: null, idempotency_key: 'checkout-key', fingerprint: 'checkout-fingerprint', guest_acknowledgement: true, creation_kind: 'checkout' as const, creation_status: 'confirmed' as const, followups_completed: false }
  const opening = { id: 'checkout-request', kind: 'booking' as const, organization_id: ORG, location_id: null, user_id: 'verified', review_id: null, payload: { ...threadPayloadForGuest({ name: 'Verified', email: 'verified@example.com', notes: 'A note before paying' }), provenance }, created_at: NOW, updated_at: NOW }
  await db.batch(requestInsertQueries(opening, undefined, { body: 'Class for 1 guest' }).map(write => db.prepare(write.query).bind(...write.params)))
  const owner = async () => (await listGuestThreads(db, ORG, { userId: 'owner-reader' })).map(row => row.id)
  const buyer = async () => (await listGuestThreads(db, null, { userId: 'verified', buyerAudience: true })).map(row => row.id)
  assert.deepEqual([await owner(), await buyer()], [[], []])
  await claimSessionCapacity(db, { policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: 'product', sessionId: 'session', productVariantId: 'variant', partySize: 1, userId: 'verified', requestId: opening.id })
  assert.deepEqual([await owner(), await buyer()], [[opening.id], [opening.id]])
 } finally { await runtime.dispose() }
})

test('guest class cancellation refunds through Stripe until 24 hours before the start, and later only releases the seat', { timeout: 120_000 }, async t => {
 for (const refundable of [true, false]) {
  const { db, runtime } = await boot()
  try {
   const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-proof-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only', STRIPE_SECRET_KEY: 'sk_test_local_boundary' }
   const opening = { id: 'class-request', kind: 'booking' as const, organization_id: ORG, location_id: null, user_id: 'verified', review_id: null, payload: threadPayloadForGuest({ name: 'Verified', email: 'verified@example.com' }), created_at: NOW, updated_at: NOW }
   await db.batch(requestInsertQueries(opening).map(write => db.prepare(write.query).bind(...write.params)))
   const booking = await claimSessionCapacity(db, { policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: 'product', sessionId: 'session', productVariantId: 'variant', partySize: 1, userId: 'verified', requestId: opening.id })
   await payable(db, 'class-payment')
   await db.prepare("UPDATE payments SET buyer_user_id='verified',subject_id=?,captured_amount=10000,stripe_payment_intent_id='pi_class',stripe_charge_id='ch_class' WHERE id='class-payment'").bind(booking.bookingId).run()
   await db.prepare("UPDATE payment_checkout_holds SET buyer_user_id='verified',request_id=?,status='converted',converted_booking_id=? WHERE payment_id='class-payment'").bind(opening.id, booking.bookingId).run()
   const startsAt = await db.prepare("SELECT starts_at FROM product_sessions WHERE id='session'").first<string>('starts_at')
   assert(startsAt)
   const now = new Date(Date.parse(startsAt) - 86_400_000 + (refundable ? 0 : 1)).toISOString()
   const originalFetch = globalThis.fetch
   let creations = 0
   const fetchMock = t.mock.method(globalThis, 'fetch', async (request, init) => {
    const url = new URL(request instanceof Request ? request.url : String(request))
    if (url.origin !== 'https://api.stripe.com') return originalFetch(request, init)
    if (url.pathname === '/v1/refunds' && init?.method === 'POST') {
     creations++
     const params = new URLSearchParams(String(init.body))
     assert.equal(params.get('payment_intent'), 'pi_class')
     assert.equal(params.has('amount'), false)
     assert.equal(new Headers(init.headers).get('idempotency-key'), `krabiclaw-refund:class-payment:guest-cancelled-booking:${booking.bookingId}`)
     return Response.json({ id: 're_class', object: 'refund', amount: 10000, currency: 'usd', status: 'succeeded', payment_intent: 'pi_class', reason: 'requested_by_customer', metadata: { krabiclaw_refund_id: params.get('metadata[krabiclaw_refund_id]') } })
    }
    return Response.json({ id: 'ch_class', object: 'charge', livemode: false, amount: 10000, amount_refunded: 10000, currency: 'usd', payment_intent: 'pi_class', billing_details: { email: 'verified@example.com' } })
   })
   try {
    assert.equal((await cancelBookingRequest(db, { id: opening.id, organizationId: ORG, kind: 'booking', now, env, buyerUserId: 'verified' }))?.changed, true)
    assert.deepEqual(await db.prepare('SELECT status,cancellation_reason FROM bookings WHERE id=?').bind(booking.bookingId).first(), { status: 'cancelled', cancellation_reason: 'guest_cancelled' })
    assert.deepEqual(await db.prepare("SELECT refunded_amount FROM payments WHERE id='class-payment'").first(), { refunded_amount: refundable ? 10000 : 0 })
    assert.equal(await db.prepare("SELECT COUNT(*) n FROM payment_refunds WHERE payment_id='class-payment'").first('n'), Number(refundable))
    assert.equal(creations, Number(refundable))
   } finally { fetchMock.mock.restore() }
  } finally { await runtime.dispose() }
 }
})

test('an advance notice closes a guest\'s own class cancellation at the notice, refunds until the longer of it and 24 hours, and no notice keeps cancellation open until the end', { timeout: 120_000 }, async t => {
 const HOUR = 3_600_000
 // [notice minutes, now relative to the start, cancelled, refunded]
 const cases: Array<[number | null, number, boolean, boolean]> = [[2880, -48 * HOUR - 1, true, true], [2880, -48 * HOUR + 1, false, false], [120, -12 * HOUR, true, false], [120, -2 * HOUR + 1, false, false], [null, 30 * 60_000, true, false]]
 for (const [notice, offset, open, refunded] of cases) {
  const { db, runtime } = await boot()
  try {
   const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-proof-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only', STRIPE_SECRET_KEY: 'sk_test_local_boundary' }
   const opening = { id: 'notice-request', kind: 'booking' as const, organization_id: ORG, location_id: null, user_id: 'verified', review_id: null, payload: threadPayloadForGuest({ name: 'Verified', email: 'verified@example.com' }), created_at: NOW, updated_at: NOW }
   await db.batch(requestInsertQueries(opening).map(write => db.prepare(write.query).bind(...write.params)))
   // The notice is part of the terms the guest booked under, frozen on the booking.
   const booking = await claimSessionCapacity(db, { policyJson: JSON.stringify({ ...OPEN_TERMS, advance_notice_minutes: notice }), env, organizationId: ORG, productId: 'product', sessionId: 'session', productVariantId: 'variant', partySize: 1, userId: 'verified', requestId: opening.id })
   await payable(db, 'notice-payment')
   await db.prepare("UPDATE payments SET buyer_user_id='verified',subject_id=?,captured_amount=10000,stripe_payment_intent_id='pi_notice',stripe_charge_id='ch_notice' WHERE id='notice-payment'").bind(booking.bookingId).run()
   await db.prepare("UPDATE payment_checkout_holds SET buyer_user_id='verified',request_id=?,status='converted',converted_booking_id=? WHERE payment_id='notice-payment'").bind(opening.id, booking.bookingId).run()
   const startsAt = await db.prepare("SELECT starts_at FROM product_sessions WHERE id='session'").first<string>('starts_at')
   assert(startsAt)
   const now = new Date(Date.parse(startsAt) + offset).toISOString()
   const originalFetch = globalThis.fetch
   let creations = 0
   const fetchMock = t.mock.method(globalThis, 'fetch', async (request, init) => {
    const url = new URL(request instanceof Request ? request.url : String(request))
    if (url.origin !== 'https://api.stripe.com') return originalFetch(request, init)
    if (url.pathname === '/v1/refunds' && init?.method === 'POST') {
     creations++
     const params = new URLSearchParams(String(init.body))
     return Response.json({ id: 're_notice', object: 'refund', amount: 10000, currency: 'usd', status: 'succeeded', payment_intent: 'pi_notice', reason: 'requested_by_customer', metadata: { krabiclaw_refund_id: params.get('metadata[krabiclaw_refund_id]') } })
    }
    return Response.json({ id: 'ch_notice', object: 'charge', livemode: false, amount: 10000, amount_refunded: 10000, currency: 'usd', payment_intent: 'pi_notice', billing_details: { email: 'verified@example.com' } })
   })
   try {
    const cancel = cancelBookingRequest(db, { id: opening.id, organizationId: ORG, kind: 'booking', now, env, buyerUserId: 'verified' })
    if (open) assert.equal((await cancel)?.changed, true)
    else await assert.rejects(cancel, (error: HTTPError) => error.statusCode === 409 && (error.data as { code?: string }).code === 'cancellation_closed' && error.message.includes(`closed ${notice === 2880 ? '2 days' : '2 hours'} before the start`))
    assert.deepEqual(await db.prepare('SELECT status,cancellation_reason FROM bookings WHERE id=?').bind(booking.bookingId).first(), open ? { status: 'cancelled', cancellation_reason: 'guest_cancelled' } : { status: 'pending', cancellation_reason: null })
    assert.equal(await db.prepare("SELECT json_extract(payload_json,'$.cancellation.used_at') used FROM requests WHERE id=?").bind(opening.id).first('used'), open ? now : null)
    assert.deepEqual(await db.prepare("SELECT refunded_amount FROM payments WHERE id='notice-payment'").first(), { refunded_amount: refunded ? 10000 : 0 })
    assert.equal(creations, Number(refunded))
   } finally { fetchMock.mock.restore() }
  } finally { await runtime.dispose() }
 }
})

test('authorized guest cancellation replay recovers an interrupted Stripe refund without another cancellation or refund intent', { timeout: 120_000 }, async t => {
 for (const credentials of [{ buyerUserId: 'verified' }, { tokenHash: 'deposit-token-hash' }]) {
  const { db, runtime } = await boot()
  try {
   const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-proof-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only', STRIPE_SECRET_KEY: 'sk_test_local_boundary' }
   const { bookingId, ...paid } = await paidTable(db, env)
   const scope = { ...paid, now: '2099-09-30T13:00:00.000Z' }
   const input = { ...scope, ...credentials }
   const originalFetch = globalThis.fetch
   let creations = 0
   const keys = new Set<string>()
   let nativeRefund: Record<string, unknown> | null = null
   const fetchMock = t.mock.method(globalThis, 'fetch', async (request, init) => {
    const url = new URL(request instanceof Request ? request.url : String(request))
    if (url.origin !== 'https://api.stripe.com') return originalFetch(request, init)
    assert.equal(new Headers(init?.headers).get('stripe-account'), 'acct_seller')
    if (url.pathname === '/v1/refunds' && init?.method === 'POST') {
     creations++
     const params = new URLSearchParams(String(init.body))
     assert.equal(params.has('amount'), false)
     keys.add(new Headers(init.headers).get('idempotency-key')!)
     nativeRefund = { id: 're_recovered', object: 'refund', amount: 10500, currency: 'usd', status: 'succeeded', payment_intent: 'pi_deposit', reason: 'requested_by_customer', metadata: { krabiclaw_refund_id: params.get('metadata[krabiclaw_refund_id]') } }
     if (creations === 1) return Response.json({ error: { type: 'api_error', message: 'Native response interrupted' } }, { status: 503, headers: { 'stripe-should-retry': 'false' } })
     return Response.json(nativeRefund)
    }
    assert.equal(init?.method, 'GET')
    if (url.pathname === '/v1/refunds/re_recovered') return Response.json(nativeRefund)
    if (url.pathname === '/v1/refunds') return Response.json({ object: 'list', data: creations > 1 ? [nativeRefund] : [], has_more: false, url: '/v1/refunds' })
    if (url.pathname === '/v1/disputes') return Response.json({ object: 'list', data: [], has_more: false, url: '/v1/disputes' })
    assert.equal(url.pathname, '/v1/charges/ch_deposit')
    return Response.json({ id: 'ch_deposit', object: 'charge', livemode: false, amount: 10500, amount_captured: 10500, amount_refunded: creations > 1 ? 10500 : 0, currency: 'usd', payment_intent: 'pi_deposit', billing_details: { email: 'verified@example.com' } })
   })
   try {
    const protectedTables = ['bookings', 'requests', 'activity_entries', 'payments', 'payment_refunds']
    const before = await Promise.all(protectedTables.map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results))
    for (const wrong of [{ buyerUserId: 'other' }, { tokenHash: 'wrong-token' }, { tokenHash: 'deposit-token-hash', now: '2100-01-01T00:00:00.000Z' }]) assert.equal(await cancelBookingRequest(db, { ...scope, ...wrong }), null)
    assert.deepEqual(await Promise.all(protectedTables.map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results)), before)
    assert.equal(creations, 0)
    await assert.rejects(() => cancelBookingRequest(db, input), /Native response interrupted/u)
    assert.equal(await db.prepare('SELECT status FROM bookings WHERE id=?').bind(bookingId).first('status'), 'cancelled')
    const intent = await db.prepare("SELECT id,idempotency_key,amount,status,error,attempted_at FROM payment_refunds WHERE payment_id='deposit'").first<{ id: string; idempotency_key: string; amount: number | null; status: string; error: string; attempted_at: string }>()
    assert(intent)
    assert.equal(intent.amount, null)
    assert.equal(intent.status, 'creating')
    assert.match(intent.error, /Native response interrupted/u)
    assert.ok(intent.attempted_at)
    const cancellation = await db.prepare("SELECT * FROM activity_entries WHERE request_id='deposit-request' AND event_name='booking.cancel'").first()
    assert(cancellation)
    const interruptedDetails = await loadBuyerBookingDetails(db, env, 'verified', 'booking', scope.id)
    assert.equal(interruptedDetails.status, 'cancelled')
    assert.equal(interruptedDetails.guestCanCancel, false)
    assert.equal(interruptedDetails.guestCanRetryCancellation, true)
    await assert.rejects(() => loadBuyerBookingDetails(db, env, 'other', 'booking', scope.id), error => error instanceof HTTPError && error.statusCode === 404)
    const tokenScope = { organizationId: ORG, bookingId, requestId: scope.id }
    assert.equal(await canRetryGuestVisitRefund(db, tokenScope), true)
    for (const foreign of [{ organizationId: 'another-org' }, { bookingId: 'another-booking' }, { requestId: 'another-request' }, { buyerUserId: 'other' }]) assert.equal(await canRetryGuestVisitRefund(db, { ...tokenScope, ...foreign }), false)
    assert.equal(await cancelBookingRequest(db, { ...scope, buyerUserId: 'other' }), null)
    assert.equal(await cancelBookingRequest(db, { ...scope, tokenHash: 'wrong-token' }), null)
    assert.equal(await cancelBookingRequest(db, { ...scope, tokenHash: 'deposit-token-hash', now: '2100-01-01T00:00:00.000Z' }), null)
    assert.equal(creations, 1)
    // Eligibility was fixed when cancellation committed; recovery still returns the deposit after the deadline.
    const retry = { ...input, now: '2099-10-01T12:00:00.000Z' }
    assert.equal((await cancelBookingRequest(db, retry))?.changed, false)
    assert.equal((await cancelBookingRequest(db, retry))?.changed, false)
    assert.equal(creations, 2)
    assert.deepEqual([...keys], [`krabiclaw-refund:deposit:guest-cancelled-booking:${bookingId}`])
    assert.deepEqual((await db.prepare("SELECT id,idempotency_key,stripe_refund_id,amount,status,error FROM payment_refunds WHERE payment_id='deposit'").all()).results, [{ id: intent.id, idempotency_key: intent.idempotency_key, stripe_refund_id: 're_recovered', amount: 10500, status: 'succeeded', error: null }])
    assert.deepEqual(await db.prepare("SELECT refunded_amount FROM payments WHERE id='deposit'").first(), { refunded_amount: 10500 })
    const refundedDetails = await loadBuyerBookingDetails(db, env, 'verified', 'booking', scope.id)
    assert.equal(refundedDetails.guestCanRetryCancellation, false)
    assert.equal(await canRetryGuestVisitRefund(db, tokenScope), false)
    assert.deepEqual(refundedDetails.payments?.flatMap(payment => payment.refunds.map(refund => ({ amount: refund.amount, status: refund.status }))), [{ amount: 10500, status: 'succeeded' }])
    assert.deepEqual((await db.prepare("SELECT * FROM activity_entries WHERE request_id='deposit-request' AND event_name='booking.cancel'").all()).results, [cancellation])
    assert.equal(await db.prepare("SELECT COUNT(*) n FROM activity_entries WHERE request_id='deposit-request' AND event_name='payment.refund_succeeded'").first('n'), 1)
    assert.equal(await seatingRemaining(db), 1)
   } finally { fetchMock.mock.restore() }
  } finally { await runtime.dispose() }
 }
})
test('an active payment hold consumes the canonical session capacity until release', { timeout: 120_000 }, async () => {
 const { db, runtime, env } = await boot()
 try {
  await payable(db, 'held')
  await assert.rejects(() => claimSessionCapacity(db, { policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: 'product', sessionId: 'session', productVariantId: 'variant', partySize: 1 }), /no longer has room/u)
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM bookings').first('n'), 0)
  await db.prepare("UPDATE payment_checkout_holds SET status='released' WHERE payment_id='held'").run()
  const booking = await claimSessionCapacity(db, { policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: 'product', sessionId: 'session', productVariantId: 'variant', partySize: 1 })
  assert.equal(await db.prepare('SELECT party_size FROM bookings WHERE id=?').bind(booking.bookingId).first('party_size'), 1)
 } finally { await runtime.dispose() }
})
test('MCP paid booking cancellation and rejection hand off without preparing money, while dashboard approval and interrupted refund recovery complete once', { timeout: 120_000 }, async t => {
 for (const action of ['cancel', 'reject'] as const) {
  const { db, runtime } = await boot()
  try {
   const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-proof-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only', STRIPE_SECRET_KEY: 'sk_test_local_boundary' }
   await db.prepare("INSERT INTO member(id,organizationId,userId,role) VALUES('owner',?,'verified','owner')").bind(ORG).run()
   const opening = { id: 'paid-request', kind: 'booking' as const, organization_id: ORG, location_id: null, user_id: 'guest', review_id: null, payload: threadPayloadForGuest({ name: 'Guest', email: 'guest@example.com' }), created_at: NOW, updated_at: NOW }
   await db.batch(requestInsertQueries(opening).map(write => db.prepare(write.query).bind(...write.params)))
   const booking = await claimSessionCapacity(db, { policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: 'product', sessionId: 'session', productVariantId: 'variant', partySize: 1, userId: 'guest', requestId: opening.id })
   await payable(db, 'paid')
   await db.prepare("UPDATE payments SET subject_id=?,captured_amount=10000,stripe_payment_intent_id='pi_paid',stripe_charge_id='ch_paid' WHERE id='paid'").bind(booking.bookingId).run()
   await db.prepare("UPDATE payment_checkout_holds SET request_id=?,status='converted',converted_booking_id=? WHERE payment_id='paid'").bind(opening.id,booking.bookingId).run()
   const input = { organizationId: ORG, threadId: opening.id, action, actorUserId: 'verified', idempotencyKey: 'same-request', env }
   const tables = ['bookings', 'requests', 'activity_entries', 'guest_thread_deliveries', 'payments', 'payment_checkout_holds', 'payment_orders', 'payment_order_lines', 'payment_authorizations', 'payment_refunds', 'payment_usage_events']
   const before = await Promise.all(tables.map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results))
   for (let retry = 0; retry < 2; retry++) {
    await assert.rejects(() => executeGuestThreadOperation(db, { ...input, financialWritesAllowed: false }), error => {
     assert(error instanceof HTTPError)
     assert.equal(error.statusCode,409)
     assert.equal(error.data?.code,'financial_action_required')
     const handoff = mcpFinancialApprovalErrorResult(error,env.NUXT_PUBLIC_PLATFORM_DOMAIN,error.statusMessage!)
     assert(handoff)
     assert.equal('structuredContent' in handoff, false)
     assert.deepEqual(JSON.parse(handoff.content[0]!.text), { status: 409, message: error.statusMessage, success: false, operation_completed: false, action_required: true, code: 'financial_action_required', dashboard_url: 'https://proof.example/dashboard/payments/bookings/booking/paid-request' })
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
   assert.equal(await db.prepare("SELECT COUNT(*) n FROM activity_entries WHERE request_id=? AND event_name=?").bind(opening.id,`booking.${action}`).first('n'),1)
   assert.equal(await db.prepare('SELECT COUNT(*) n FROM guest_thread_deliveries').first('n'),1)
   assert.equal(await db.prepare("SELECT status FROM payment_refunds WHERE payment_id='paid'").first('status'),'queued')
   assert.equal(await db.prepare('SELECT consumed_at FROM payment_authorizations WHERE id=?').bind(authorizationId).first('consumed_at')!==null,true)
   const refundRow = await db.prepare("SELECT id FROM payment_refunds WHERE payment_id='paid'").first<{id:string}>()
   assert(refundRow)
   const nativeRefund = { id: 're_paid', object: 'refund', amount: 10000, currency: 'usd', status: 'succeeded', payment_intent: 'pi_paid', reason: 'requested_by_customer', metadata: { krabiclaw_refund_id: refundRow.id } }
   const originalFetch = globalThis.fetch
   let creations = 0
   const idempotencyKeys = new Set<string>()
   const fetchMock = t.mock.method(globalThis,'fetch',async (request, init) => {
    const url = new URL(request instanceof Request ? request.url : String(request))
    if(url.origin!=='https://api.stripe.com')return originalFetch(request,init)
    assert.equal(new Headers(init?.headers).get('stripe-account'),'acct_seller')
    if(url.pathname==='/v1/refunds' && init?.method==='POST') {
     creations++
     // A full-remaining refund names no amount: Stripe decides what is left.
     assert.doesNotMatch(String(init?.body),/(^|&)amount=/u)
     idempotencyKeys.add(new Headers(init?.headers).get('idempotency-key')!)
     if(creations===1)return Response.json({error:{type:'api_error',message:'Native response interrupted'}},{status:503,headers:{'stripe-should-retry':'false'}})
     return Response.json(nativeRefund)
    }
    assert.equal(init?.method,'GET')
    if(url.pathname==='/v1/refunds/re_paid')return Response.json(nativeRefund)
    assert.equal(url.pathname,'/v1/charges/ch_paid')
    return Response.json({id:'ch_paid',object:'charge',livemode:false,amount:10000,amount_refunded:0,currency:'usd',payment_intent:'pi_paid',billing_details:{email:'guest@example.com'}})
   })
   try {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY,{maxNetworkRetries:0,httpClient:Stripe.createFetchHttpClient()})
    const key = `${action==='reject'?'rejected':'cancelled'}:${booking.bookingId}`
    const payment = await requirePayment(db,ORG,'paid')
    const refund = () => executeRefund(db,stripe,payment,null,key,'requested_by_customer','verified',env)
    await assert.rejects(refund,/Native response interrupted/u)
    await db.prepare("UPDATE payment_authorizations SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(authorizationId).run()
    await approveRefundAuthorization(db,principal,authorizationId)
    assert.equal((await executeGuestThreadOperation(db,approvedInput)).ok,true)
    // The retry re-sends the same native request under the same key; Stripe answers for the first attempt. Once recorded, no further request is made.
    assert.equal((await refund()).status,'succeeded')
    assert.equal((await refund()).status,'succeeded')
    assert.equal(creations,2)
    assert.equal(idempotencyKeys.size,1)
    assert.equal(await db.prepare("SELECT COUNT(*) n FROM payment_refunds WHERE payment_id='paid'").first('n'),1)
    assert.equal(await db.prepare("SELECT refunded_amount FROM payments WHERE id='paid'").first('refunded_amount'),10000)
   } finally { fetchMock.mock.restore() }
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
  await db.prepare("INSERT INTO payment_usage_events(id,organization_id,payment_id,kind,currency,amount,source_id,provider_occurred_at,error,created_at) VALUES('report-usage',?,'report','stripe_cost','USD',100,'private-provider-source',?,'private-usage-diagnostic',?)").bind(ORG,NOW,NOW).run()
  await db.prepare("INSERT INTO stripe_connected_accounts(id,organization_id,stripe_account_id,livemode,country,status,created_at,updated_at) VALUES('report-connected',?,'acct_seller',0,'US','ready',?,?)").bind(ORG,NOW,NOW).run()
  const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_URL:'https://proof.example', BETTER_AUTH_SECRET:'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN:'https://proof.example', STRIPE_SECRET_KEY:'sk_test_local_boundary' }
  const membership = await resolveOrganizationMembership(env,{organizationId:ORG,userId:'verified'})
  assert(membership)
  const organization: McpOrganizationContext = { env,db,userId:'verified',isPlatformAdmin:false,scopes:['organization:read'],organizationId:ORG,organizationSlug:membership.organizationSlug!,role:'owner',membership }
  const call = (toolName:string,args:Record<string,unknown>={}) => handlePaymentsTools({organization,toolName,args}) as Promise<Record<string,unknown>>
  const tables = ['payments','payment_checkout_holds','payment_orders','payment_order_lines','payment_authorizations','payment_refunds','payment_usage_events','stripe_connected_accounts']
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
  const events=(await db.prepare("SELECT amount,kind FROM payment_usage_events ORDER BY kind,amount").all()).results
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
 const {db,runtime}=await boot();try{
  const env={...await runtime.getBindings<CloudflareEnv>(),STRIPE_SECRET_KEY:'sk_test_local_d1_no_stripe_requests'}
  await payable(db,'claim')
  const originalFetch=globalThis.fetch
  t.mock.method(globalThis,'fetch',async(request:RequestInfo|URL,init?:RequestInit)=>{
   const url=new URL(request instanceof Request?request.url:String(request))
   if(url.origin!=='https://api.stripe.com')return originalFetch(request,init)
   assert.equal(new Headers(init?.headers).get('stripe-account'),'acct_seller')
   if(url.pathname==='/v1/charges/ch:claim'||url.pathname==='/v1/charges/ch%3Aclaim')return Response.json({id:'ch:claim',object:'charge',amount:10000,amount_captured:10000,amount_refunded:1000,currency:'usd'})
   if(url.pathname==='/v1/refunds')return Response.json({object:'list',data:[{id:'re:claim',object:'refund',amount:1000,currency:'usd',status:'pending',payment_intent:'pi:claim'}],has_more:false,url:'/v1/refunds'})
   if(url.pathname==='/v1/disputes')return Response.json({object:'list',data:[],has_more:false,url:'/v1/disputes'})
   throw new Error(`Unexpected Stripe request ${url.pathname}`)
  })
  await db.prepare("UPDATE payments SET captured_amount=10000,stripe_payment_intent_id='pi:claim',stripe_charge_id='ch:claim',receipt_url='https://example.com/receipt' WHERE id='claim'").run()
  await db.prepare("INSERT INTO payment_refunds(id,payment_id,idempotency_key,stripe_refund_id,amount,reason,status,error,created_by,created_at,updated_at) VALUES('refund:claim','claim','refund-retry:claim','re:claim',1000,'requested_by_customer','pending','operator-only diagnostic','other',?,?)").bind(NOW,NOW).run()
  const token=crypto.randomUUID()+crypto.randomUUID(),hash=await tokenHash(token)
  await db.prepare("UPDATE payments SET return_token_hash=?,return_expires_at='2099-01-01T00:00:00.000Z' WHERE id='claim'").bind(hash).run()
  // The capture webhook alerted the buyer the payment named at that moment; the return re-sends the same event for the account that proved it. One event, one alert.
  await db.prepare("INSERT INTO user(id,name,email,isAnonymous) VALUES('anon-buyer','Guest','anon-buyer@customers.krabiclaw.local',1)").run()
  await db.prepare("UPDATE payments SET buyer_user_id='anon-buyer' WHERE id='claim'").run()
  const alert={scope:'global' as const,template:'payments:acct_seller:0:pi:claim:succeeded:payment_captured',idempotencyKey:'payments:acct_seller:0:pi:claim:succeeded:payment_captured:buyer',title:'Payment received',deepLink:'/dashboard/account/activity/payment/claim'}
  const first=await createCanonicalNotification(db,{...alert,targetUserId:'anon-buyer'})
  assert.deepEqual(await claimCheckoutReturn(db,'verified',token),{payment_id:'claim',claimed:true})
  assert.equal(await createCanonicalNotification(db,{...alert,targetUserId:'verified'}),first)
  assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE kind='notification' AND event_name=?").bind(alert.template).first('n'),1)
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
  const owned=await loadBuyerBookingDetails(db, env,'verified','payment','claim')
  assert.equal(owned.type,'payment')
  assert.equal(owned.resourceTitle,'Consultation')
  assert.equal(owned.threadId,null)
  // refunded_amount is 0 in our row; the 1000 can only have come from Stripe's Charge.
  assert.deepEqual(owned.payments,[{payment:{id:'claim',currency:'USD',captured_amount:10000,refunded_amount:1000,surcharge_amount:0,receipt_url:'https://example.com/receipt'},refunds:[{id:'refund:claim',amount:1000,status:'pending',note:null}],order:null}])
  for(const field of ['stripe_account_id','stripe_payment_intent_id','stripe_charge_id','livemode','buyer_user_id','price_snapshot_json'])assert.equal(Object.hasOwn(owned.payments![0]!.payment,field),false)
  for(const field of ['idempotency_key','stripe_refund_id','reason','error','attempted_at','created_by'])assert.equal(Object.hasOwn(owned.payments![0]!.refunds[0]!,field),false)
  assert.deepEqual(await db.prepare("SELECT stripe_account_id,stripe_payment_intent_id,stripe_charge_id,buyer_user_id FROM payments WHERE id='claim'").first(),{stripe_account_id:'acct_seller',stripe_payment_intent_id:'pi:claim',stripe_charge_id:'ch:claim',buyer_user_id:'verified'})
  assert.deepEqual(await db.prepare("SELECT idempotency_key,stripe_refund_id,error,created_by FROM payment_refunds WHERE id='refund:claim'").first(),{idempotency_key:'refund-retry:claim',stripe_refund_id:'re:claim',error:'operator-only diagnostic',created_by:'other'})
  assert.equal(await db.prepare("SELECT buyer_user_id FROM payment_checkout_holds WHERE payment_id='claim'").first('buyer_user_id'),'verified')
  await assert.rejects(()=>claimCheckoutReturn(db,'other',token),error=>error instanceof HTTPError&&error.statusCode===404&&error.statusMessage==='Purchase return proof expired or already used')

  assert.deepEqual((await buyerActivities(db,'verified')).activities.map(activity=>activity.id),['claim'])
  assert.deepEqual(await buyerActivities(db,'other'),{activities:[]})
  await assert.rejects(()=>loadBuyerBookingDetails(db, env,'other','payment','claim'),error=>error instanceof HTTPError&&error.statusCode===404)

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

test('a payment back on the business’s site claims for that site’s buyer and names the business’s own receipt; a clearing or unauthenticated one claims nothing', { timeout: 120_000 }, async t => {
 const { db, runtime } = await boot()
 try {
  // A demo business on the live platform takes test-mode payments; its capture is not billable volume.
  const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_URL: 'https://payments.proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-proof-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only', STRIPE_SECRET_KEY: 'sk_live_local_boundary', STRIPE_TEST_SECRET_KEY: 'sk_test_local_boundary' }
  await payable(db, 'clearing')
  await payable(db, 'declined')
  // The browser that booked on the site holds the Better Auth anonymous user its checkout was made for.
  const signedIn = await createAuth(env).api.signInAnonymous({ headers: new Headers(), returnHeaders: true })
  const buyer = signedIn.response!.user.id
  const cookie = signedIn.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  // A table deposit checkout as the site's booking made it, owned by the anonymous guest that booking created: the request waiting
  // on payment, its hold, and no booking yet. The return claims all of it for the signed-in buyer.
  await diningTables(db)
  const receipt = await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET, 'deposit-request')
  const provenance = { source: 'website', external_reference: null, actor_user_id: null, idempotency_key: 'deposit-key', fingerprint: 'deposit-fingerprint', guest_acknowledgement: true, creation_kind: 'checkout' as const, creation_status: 'confirmed' as const, followups_completed: false }
  const opening = { id: 'deposit-request', kind: 'booking' as const, organization_id: ORG, location_id: 'dining', user_id: 'guest', review_id: null, payload: { ...threadPayloadForGuest({ name: 'Verified', email: 'verified@example.com', phone: '+12025550123' }), provenance, cancellation: { token_hash: await hashReservationCancelToken(receipt.token), expires_at: receipt.expiresAt, used_at: null } }, created_at: NOW, updated_at: NOW }
  await db.batch(requestInsertQueries(opening).map(write => db.prepare(write.query).bind(...write.params)))
  // The deposit is the table's price once, for the whole party, with the terms the guest was shown.
  await db.prepare("INSERT INTO payments(id,organization_id,buyer_user_id,stripe_account_id,livemode,subject_type,location_id,currency,amount,price_snapshot_json,created_at,updated_at) VALUES('deposit',?,?,'acct_seller',0,'booking','dining','USD',10000,?,?,?)")
   .bind(ORG, 'guest', JSON.stringify({ title: 'Dining tables', tax_code: null, price: { unit_amount: 10000, currency: 'USD', tax_behavior: 'exclusive' }, quantity: 1, automatic_tax: false, method_configuration_id: 'pmc_seller', product_id: 'tables', variant_id: 'table-variant', session_id: 'seating', policy: TABLE_TERMS, answers: [] }), NOW, NOW).run()
  await db.prepare("INSERT INTO payment_checkout_holds(id,organization_id,product_id,variant_id,price_id,session_id,location_id,timezone,buyer_user_id,request_id,payment_id,quantity,amount,currency,starts_at,ends_at,status,expires_at,created_at) VALUES('deposit-hold',?,'tables','table-variant','table-price','seating','dining','UTC',?,'deposit-request','deposit',1,10000,'USD','2099-10-01T13:00:00.000Z','2099-10-01T15:00:00.000Z','active','2099-09-30T00:00:00.000Z',?)").bind(ORG, 'guest', NOW).run()
  const claims: Record<string, string> = {}
  for (const id of ['deposit', 'clearing', 'declined']) {
   claims[id] = crypto.randomUUID() + crypto.randomUUID()
   await db.prepare("UPDATE payments SET return_token_hash=?,return_expires_at='2099-01-01T00:00:00.000Z' WHERE id=?").bind(await tokenHash(claims[id]!), id).run()
  }
  await db.prepare("UPDATE payments SET stripe_payment_intent_id='pi_deposit',idempotency_key='checkout:deposit',return_token=?,checkout_expires_at='2099-09-30T00:00:00.000Z' WHERE id='deposit'").bind(claims.deposit).run()

  const statuses: Record<string, string> = { pi_deposit: 'succeeded', pi_clearing: 'processing', pi_declined: 'requires_payment_method' }
  const originalFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
   const url = new URL(request instanceof Request ? request.url : String(request))
   if (url.origin !== 'https://api.stripe.com') return originalFetch(request, init)
   assert.equal(init?.method, 'GET')
   assert.equal(new Headers(init?.headers).get('stripe-account'), 'acct_seller')
   assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer sk_test_local_boundary')
   const charge = { id: 'ch_deposit', object: 'charge', livemode: false, amount: 10800, currency: 'usd', created: 1_790_000_000, payment_intent: 'pi_deposit', payment_method: 'pm_card', receipt_url: 'https://pay.stripe.com/receipts/deposit', billing_details: { email: 'card@example.com' } }
   if (url.pathname === '/v1/charges/ch_deposit') return Response.json(charge)
   // The deposit's tax is the Stripe Tax calculation its intent carried.
   if (url.pathname === '/v1/tax/calculations/taxcalc_deposit') return Response.json({ id: 'taxcalc_deposit', object: 'tax.calculation', amount_total: 10800, tax_amount_exclusive: 800, tax_amount_inclusive: 0 })
   const id = url.pathname.split('/').at(-1)!
   assert.ok(id in statuses, `Unexpected Stripe request: ${url.pathname}`)
   if (id === 'pi_deposit') assert.equal(url.searchParams.get('expand[0]'), 'latest_charge')
   const paid = statuses[id] === 'succeeded'
   return Response.json({ id, object: 'payment_intent', livemode: false, currency: 'usd', amount: paid ? 10800 : 10000, amount_received: paid ? 10800 : 0, status: statuses[id], customer: null, application_fee_amount: null, latest_charge: paid ? charge : null, last_payment_error: null, metadata: { krabiclaw_payment_id: id.slice(3) }, ...(paid ? { hooks: { inputs: { tax: { calculation: 'taxcalc_deposit' } } } } : {}) })
  })

  const app = new H3()
  app.use((event) => { event.context.organizationId = ORG })
  app.post('/api/public/payments/:paymentId/return', paymentReturnRoute)
  app.get('/api/public/booking-requests/:requestId', bookingReceiptRoute)
  const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => app.request(Object.assign(new Request(`https://payments.proof.example${path}`, {
   method: init.method ?? 'GET', headers: { origin: 'https://payments.proof.example', 'content-type': 'application/json', ...init.headers }, ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
  const back = (id: string, headers: Record<string, string> = {}) => call(`/api/public/payments/${id}/return`, { method: 'POST', headers, body: { claim: claims[id] } })

  // Still clearing: nothing is booked, so nothing is claimed and no identity is minted for it.
  const clearing = await back('clearing')
  assert.equal(clearing.status, 200)
  assert.deepEqual(await clearing.json(), { state: 'processing' })
  assert.deepEqual(clearing.headers.getSetCookie(), [])
  assert.deepEqual(await db.prepare("SELECT claimed_at,claimed_user_id FROM payments WHERE id='clearing'").first(), { claimed_at: null, claimed_user_id: null })
  assert.equal((await requirePayment(db, ORG, 'clearing')).buyer_user_id, 'guest')

  // A method Stripe has not accepted is not a purchase.
  const declined = await back('declined')
  assert.equal(declined.status, 409)
  assert.equal((await declined.json() as { message?: string }).message, 'Stripe has not authenticated this purchase')
  assert.deepEqual(await db.prepare("SELECT claimed_at FROM payments WHERE id='declined'").first(), { claimed_at: null })

  // Another business's site cannot complete this business's payment.
  const elsewhere = new H3()
  elsewhere.use((event) => { event.context.organizationId = 'another-org' })
  elsewhere.post('/api/public/payments/:paymentId/return', paymentReturnRoute)
  const foreign = await elsewhere.request(Object.assign(new Request('https://another.proof.example/api/public/payments/deposit/return', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ claim: claims.deposit }) }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
  assert.equal(foreign.status, 404)
  assert.equal(await db.prepare("SELECT claimed_at FROM payments WHERE id='deposit'").first('claimed_at'), null)

  // Paid: Stripe's capture makes the booking, the purchase is claimed for the browser's own buyer,
  // and the receipt is the business's confirmation, not the platform's.
  const paid = await back('deposit', { cookie })
  assert.equal(paid.status, 200, await paid.clone().text())
  assert.deepEqual(await paid.json(), { state: 'paid', kind: 'booking', request_id: 'deposit-request', cancellation_token: receipt.token })
  assert.deepEqual(paid.headers.getSetCookie(), [])
  assert.deepEqual(await db.prepare("SELECT claimed_user_id FROM payments WHERE id='deposit'").first(), { claimed_user_id: buyer })
  const bookingId = await db.prepare("SELECT converted_booking_id FROM payment_checkout_holds WHERE id='deposit-hold' AND status='converted'").first<string>('converted_booking_id')
  assert.equal(typeof bookingId, 'string')
  assert.deepEqual(await db.prepare("SELECT buyer_user_id,amount,tax_amount,captured_amount,receipt_url,subject_id FROM payments WHERE id='deposit'").first(), { buyer_user_id: buyer, amount: 10000, tax_amount: 800, captured_amount: 10800, receipt_url: 'https://pay.stripe.com/receipts/deposit', subject_id: bookingId })
  assert.deepEqual(await db.prepare('SELECT request_id,user_id,status,product_id,product_session_id,party_size FROM bookings WHERE id=?').bind(bookingId).first(), { request_id: 'deposit-request', user_id: buyer, status: 'confirmed', product_id: 'tables', product_session_id: 'seating', party_size: 1 })
  // The capture alert went to the buyer who proved the purchase, once.
  assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE request_id='deposit-request' AND event_name='payment.payment_captured'").first('n'), 1)

  // The confirmation page reads that receipt through the business's receipt endpoint, with the guest's booking email for the account prompt.
  const read = await call('/api/public/booking-requests/deposit-request', { headers: { authorization: `Bearer ${receipt.token}` } })
  assert.equal(read.status, 200)
  const booking = (await read.json() as { booking: Record<string, unknown> }).booking
  assert.deepEqual({ kind: booking.kind, status: booking.status, name: booking.name, email: booking.email, starts_at: booking.starts_at, timezone: booking.timezone, guests: booking.guests, location_id: booking.location_id },
   { kind: 'booking', status: 'confirmed', name: 'Verified', email: 'verified@example.com', starts_at: '2099-10-01T13:00:00.000Z', timezone: 'UTC', guests: '1', location_id: 'dining' })

  // Returning again, as a reload of the pay page does, names the same receipt and changes nothing.
  const before = await db.prepare("SELECT return_token_hash,claimed_at,claimed_user_id FROM payments WHERE id='deposit'").first()
  const again = await back('deposit', { cookie })
  assert.deepEqual(await again.json(), { state: 'paid', kind: 'booking', request_id: 'deposit-request', cancellation_token: receipt.token })
  assert.deepEqual(await db.prepare("SELECT return_token_hash,claimed_at,claimed_user_id FROM payments WHERE id='deposit'").first(), before)
  assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE request_id='deposit-request' AND event_name='payment.payment_captured'").first('n'), 1)
 } finally {
  await runtime.dispose()
 }
})

test('buyer Activity groups exact owned visits and immutable orders without manufacturing conversations', {timeout:120000},async()=>{
 const {db,runtime,env}=await boot();try{
  const opening={id:'booking-request',kind:'booking' as const,organization_id:ORG,location_id:null,user_id:'verified',review_id:null,payload:threadPayloadForGuest({name:'Verified',email:'verified@example.com',notes:'My booking note',ipHash:'private-ip-hash'}),created_at:NOW,updated_at:NOW}
  await db.batch(requestInsertQueries(opening).map(write=>db.prepare(write.query).bind(...write.params)))
  const booking=await claimSessionCapacity(db,{policyJson: OPEN_TERMS_JSON, env,organizationId:ORG,productId:'product',sessionId:'session',productVariantId:'variant',partySize:1,userId:'verified',requestId:opening.id})
  assert.notEqual(booking.bookingId,opening.id)
  assert.equal(await db.prepare('SELECT request_id FROM bookings WHERE id=?').bind(booking.bookingId).first('request_id'),opening.id)
  await payable(db,'visit-payment')
  await db.prepare("UPDATE payments SET buyer_user_id='verified',subject_id=?,captured_amount=10000 WHERE id='visit-payment'").bind(booking.bookingId).run()
  await db.prepare("UPDATE payment_checkout_holds SET buyer_user_id='verified',request_id=?,status='converted' WHERE payment_id='visit-payment'").bind(opening.id).run()
  await db.prepare("INSERT INTO payments(id,organization_id,buyer_user_id,stripe_account_id,livemode,subject_type,subject_id,currency,amount,captured_amount,price_snapshot_json,created_at,updated_at) VALUES('other-payment',?,'other','acct_seller',0,'booking',?,'USD',10000,10000,?,?,?)").bind(ORG,booking.bookingId,JSON.stringify({title:'Other private purchase'}),NOW,NOW).run()
  const visits=(await buyerActivities(db,'verified')).activities
  assert.deepEqual(visits.map(({kind,id,requestId,operationalId})=>({kind,id,requestId,operationalId})),[{kind:'booking',id:opening.id,requestId:opening.id,operationalId:booking.bookingId}])
  assert.equal(await buyerPaymentActivityPath(db,'verified','visit-payment'),`/dashboard/account/activity/booking/${opening.id}`)
  // The team's private note on the booking is never the buyer's to read.
  await db.prepare("UPDATE bookings SET private_notes='Team-only note' WHERE id=?").bind(booking.bookingId).run()
  const detail=await loadBuyerBookingDetails(db, env,'verified','booking',opening.id)
  assert.deepEqual(detail.payments!.map(item=>item.payment.id),['visit-payment'])
  assert.equal(detail.threadId,opening.id)
  assert.equal(detail.privateNotes,null)
  assert.doesNotMatch(JSON.stringify(detail),/Team-only note/u)
  assert.equal(detail.assignedMemberName,null)
  await assert.rejects(()=>loadBuyerBookingDetails(db, env,'verified','booking',booking.bookingId),error=>error instanceof HTTPError&&error.statusCode===404)
  await assert.rejects(()=>loadBuyerBookingDetails(db, env,'other','booking',opening.id),error=>error instanceof HTTPError&&error.statusCode===404)
  await db.prepare("INSERT INTO payments(id,organization_id,buyer_user_id,stripe_account_id,livemode,subject_type,currency,amount,captured_amount,price_snapshot_json,created_at,updated_at) VALUES('order-payment',?,'verified','acct_seller',0,'order','USD',2500,2500,?,?,?)").bind(ORG,JSON.stringify({title:'Immutable item'}),NOW,NOW).run()
  await db.prepare("INSERT INTO payment_orders(id,organization_id,buyer_user_id,payment_id,currency,amount,created_at) VALUES('immutable-order',?,'verified','order-payment','USD',2500,?)").bind(ORG,NOW).run()
  await db.prepare("INSERT INTO payment_order_lines(id,order_id,product_id,variant_id,price_id,title,unit_amount,quantity,currency,tax_behavior) VALUES('immutable-line','immutable-order','product','variant','historic-price','Original item title',1250,2,'USD','exclusive')").run()
  const requestsBefore=(await db.prepare('SELECT * FROM requests ORDER BY id').all()).results
  const order=await loadBuyerBookingDetails(db, env,'verified','order','order-payment')
  assert.equal(order.type,'order')
  assert.equal(order.threadId,null)
  assert.equal(order.partySize,null)
  assert.deepEqual(order.payments![0]!.order,{lines:[{id:'immutable-line',title:'Original item title',unit_amount:1250,quantity:2,currency:'USD'}]})
  assert.deepEqual((await db.prepare('SELECT * FROM requests ORDER BY id').all()).results,requestsBefore)
  await assert.rejects(()=>loadBuyerBookingDetails(db, env,'other','order','order-payment'),error=>error instanceof HTTPError&&error.statusCode===404)
  await db.prepare("UPDATE bookings SET user_id='other' WHERE id=?").bind(booking.bookingId).run()
  assert.equal((await buyerActivities(db,'verified')).activities.some(item=>item.kind==='booking'),false)
  await assert.rejects(()=>loadBuyerBookingDetails(db, env,'verified','booking',opening.id),error=>error instanceof HTTPError&&error.statusCode===404)
  const retainedPayment=await loadBuyerBookingDetails(db, env,'verified','payment','visit-payment')
  assert.equal(retainedPayment.threadId,null)
  assert.equal(retainedPayment.payments![0]!.payment.id,'visit-payment')
  assert.equal(await db.prepare("SELECT buyer_user_id FROM payments WHERE id='visit-payment'").first('buyer_user_id'),'verified')
  assert.equal(await getGuestThreadDetail(db,opening.id,ORG,{buyerUserId:'verified'}),null)
  assert.deepEqual(await listGuestThreads(db,null,{userId:'verified',buyerAudience:true}),[])
 }finally{await runtime.dispose()}
})

test('buyer conversations hide merchant facts and preserve public unread receipts and immutable reply retries', {timeout:120000},async()=>{
 const {db,runtime}=await boot();try{
  const env={...await runtime.getBindings<CloudflareEnv>(),BETTER_AUTH_SECRET:'local-proof-secret-long-enough-for-auth',BETTER_AUTH_URL:'https://proof.example',STRIPE_SECRET_KEY:'sk_test_local_d1_no_stripe_requests',NUXT_PUBLIC_PLATFORM_DOMAIN:'https://proof.example',EMAIL_REPLY_SECRET:'local-reply-proof',EMAIL_DELIVERY_MODE:'log_only',WHATSAPP_DELIVERY_MODE:'log_only'}
  const opening=requestInsertQueries({id:'buyer-conversation',kind:'contact',organization_id:ORG,location_id:null,user_id:'verified',review_id:null,payload:{guest:{name:'Verified',email:'verified@example.com',phone:null},subject:'Sandbox conversation',message:'My question',consent_at:null,ip_hash:'private-ip-hash'},created_at:NOW,updated_at:NOW})
  await db.batch(opening.map(write=>db.prepare(write.query).bind(...write.params)))
  const publicReply=await appendEntry(db,{threadId:'buyer-conversation',kind:'message',actorKind:'member',actorUserId:'other',channel:'web',eventName:'thread.member_reply',body:'Public host reply',payloadJson:{provider_secret:'private-diagnostic'},dedupeKey:'public-host-reply'})
  const capture=await appendEntry(db,{threadId:'buyer-conversation',kind:'operation',actorKind:'system',eventName:'payment.payment_captured',body:'Payment received',payloadJson:{stripe_charge_id:'private-charge'},dedupeKey:'public-capture'})
  const internal=await appendEntry(db,{threadId:'buyer-conversation',kind:'message',actorKind:'member',actorUserId:'other',channel:'system',body:'Internal staff note',dedupeKey:'internal-note'})
  const dispute=await appendEntry(db,{threadId:'buyer-conversation',kind:'operation',actorKind:'system',eventName:'payment.dispute_created',body:'Merchant dispute diagnostic',payloadJson:{stripe_dispute_id:'private-dispute'},dedupeKey:'merchant-dispute'})
  await db.prepare("UPDATE requests SET archived_at=?,archived_by_user_id='other' WHERE id='buyer-conversation'").bind(NOW).run()
  const view=await getGuestThreadDetail(db,'buyer-conversation',ORG,{buyerUserId:'verified'})
  assert(view)
  assert.deepEqual(view.entries.filter(entry=>entry.kind!=='submission').map(entry=>entry.id),[publicReply.id,capture.id])
  assert(view.entries.every(entry=>(entry.actorUserId===null||(entry.actorKind==='guest'&&entry.actorUserId==='verified'))&&entry.deliveries.length===0))
  assert.deepEqual(view.deliveryFailures,[])
  assert.deepEqual(view.availableActions,[])
  assert.equal(view.needsReply,false,'whether the business owes a reply is merchant state')
  assert.equal(view.manuallyArchived,false)
  assert.equal(view.archivedByUserId,null)
  const secrets=['private-ip-hash','private-diagnostic','private-charge','private-dispute','Internal staff note','Merchant dispute diagnostic']
  for(const secret of secrets)assert.equal(JSON.stringify(view).includes(secret),false)
  // The buyer's own conversation, as their inbox draws it, says only what the buyer may read.
  const thread=await getInboxThread(db,'buyer-conversation',ORG,{audience:'buyer',userId:'verified'})
  assert(thread)
  assert.deepEqual(thread.stream.filter(item=>item.type!=='day').map(item=>item.type==='message'?[item.side,item.author,item.body]:item.type==='event'?['event',item.text]:[item.type]),
   [['guest','You','My question'],['business','Payments','Public host reply'],['event','Payment received']])
  assert.deepEqual([thread.pending,thread.composer],[[],{channel:'email',available:true,reason:null}])
  for(const secret of secrets)assert.equal(JSON.stringify(thread).includes(secret),false,secret)
  const inbox=await listGuestThreads(db,null,{userId:'verified',buyerAudience:true})
  // The newest message is the internal note; the buyer's row previews the newest message they can read, unread.
  assert.deepEqual(inbox.map(row=>[row.id,row.preview,row.previewFrom,row.guestName,row.unread]),[['buyer-conversation','Public host reply','Payments','Payments',true]])
  assert.deepEqual(await listGuestThreads(db,null,{userId:'other',buyerAudience:true}),[])
  assert.equal(await acknowledgeBuyerThreadEntries(db,'other','buyer-conversation',[publicReply.id,capture.id]),0)
  assert.equal(await acknowledgeBuyerThreadEntries(db,'verified','buyer-conversation',[publicReply.id,capture.id,internal.id,dispute.id]),2)
  assert.deepEqual((await db.prepare("SELECT parent_id,actor_user_id FROM activity_entries WHERE kind='acknowledgement' AND request_id='buyer-conversation' ORDER BY parent_id").all()).results,[{parent_id:publicReply.id,actor_user_id:'verified'},{parent_id:capture.id,actor_user_id:'verified'}].sort((a,b)=>a.parent_id.localeCompare(b.parent_id)))
  assert.equal(await acknowledgeBuyerThreadEntries(db,'verified','buyer-conversation',[publicReply.id,capture.id]),0)
  const readInbox=await listGuestThreads(db,null,{userId:'verified',buyerAudience:true})
  assert.deepEqual(readInbox.map(row=>[row.id,row.unread]),[['buyer-conversation',false]])
  assert.deepEqual(await listGuestThreads(db,null,{userId:'verified',buyerAudience:true,unreadOnly:true}),[])
  assert.deepEqual((await getGuestThreadDetail(db,'buyer-conversation',ORG,{buyerUserId:'verified'}))?.entries,view.entries)
  assert.equal((await getGuestThreadDetail(db,'buyer-conversation',ORG))?.entries.some(entry=>entry.kind==='acknowledgement'),false)
  const input={threadId:'buyer-conversation',userId:'verified',body:'My web reply',photos:[],idempotencyKey:'buyer-reply-key'}
  await receiveGuestWebReply(env,input)
  const ledger=(await db.prepare("SELECT * FROM activity_entries WHERE request_id='buyer-conversation' ORDER BY sequence").all()).results
  const message=ledger.find(entry=>entry.body===input.body)
  assert(message)
  assert.equal(message.actor_user_id,'verified')
  assert.equal(message.channel,'web')
  const ownReplyView=await getGuestThreadDetail(db,'buyer-conversation',ORG,{buyerUserId:'verified'})
  assert.equal(ownReplyView?.entries.find(entry=>entry.id===message.id)?.actorUserId,'verified')
  assert(ownReplyView?.entries.every(entry=>entry.actorUserId===null||(entry.actorKind==='guest'&&entry.actorUserId==='verified')))
  // The conversation's projection: its inbox order and its reply tasks.
  const projectionOf=async()=>({updated_at:await db.prepare("SELECT updated_at FROM requests WHERE id='buyer-conversation'").first<string>('updated_at'),
   tasks:(await db.prepare("SELECT dedupe_key,status,version FROM tasks WHERE subject_type='request' AND subject_id='buyer-conversation' ORDER BY dedupe_key").all()).results})
  const projection=await projectionOf()
  assert.equal(projection.updated_at,message.occurred_at)
  const notices=(await db.prepare("SELECT * FROM activity_entries WHERE kind='notification' AND parent_id=?").bind(message.id).all()).results
  assert.equal(notices.length,1)
  await receiveGuestWebReply(env,input)
  assert.deepEqual((await db.prepare("SELECT * FROM activity_entries WHERE request_id='buyer-conversation' ORDER BY sequence").all()).results,ledger)
  assert.deepEqual(await projectionOf(),projection)
  assert.deepEqual((await db.prepare("SELECT * FROM activity_entries WHERE kind='notification' AND parent_id=?").bind(message.id).all()).results,notices)
  await assert.rejects(()=>receiveGuestWebReply(env,{...input,body:'Changed message'}),error=>error instanceof HTTPError&&error.statusCode===409)
  await assert.rejects(()=>receiveGuestWebReply(env,{...input,userId:'other'}),error=>error instanceof HTTPError&&error.statusCode===404)
  await db.prepare("UPDATE requests SET user_id='other' WHERE id='buyer-conversation'").run()
  await receiveGuestWebReply(env,{...input,userId:'other'})
  assert.deepEqual((await db.prepare("SELECT * FROM activity_entries WHERE request_id='buyer-conversation' ORDER BY sequence").all()).results,ledger)
  const previousActorView=await getGuestThreadDetail(db,'buyer-conversation',ORG,{buyerUserId:'other'})
  assert(previousActorView?.entries.every(entry=>entry.actorUserId===null))
  await assert.rejects(()=>receiveGuestWebReply(env,input),error=>error instanceof HTTPError&&error.statusCode===404)
  await db.prepare('UPDATE activity_entries SET actor_user_id=NULL WHERE id=?').bind(message.id).run()
  const retained=(await db.prepare("SELECT * FROM activity_entries WHERE request_id='buyer-conversation' ORDER BY sequence").all()).results
  await receiveGuestWebReply(env,{...input,userId:'other'})
  const historicalNullView=await getGuestThreadDetail(db,'buyer-conversation',ORG,{buyerUserId:'other'})
  assert(historicalNullView?.entries.every(entry=>entry.actorUserId===null))
  await assert.rejects(()=>receiveGuestWebReply(env,input),error=>error instanceof HTTPError&&error.statusCode===404)
  assert.deepEqual((await db.prepare("SELECT * FROM activity_entries WHERE request_id='buyer-conversation' ORDER BY sequence").all()).results,retained)
  assert.deepEqual(await projectionOf(),projection)
  assert.deepEqual((await db.prepare("SELECT * FROM activity_entries WHERE kind='notification' AND parent_id=?").bind(message.id).all()).results,notices)
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
 }finally{await runtime.dispose()}
})

test('tenant deletion refuses a connected account retained for another tenant without changing acceptance state', {timeout:120000},async()=>{
 const {db,runtime}=await boot();try{
  await payable(db,'retention-conflict')
  await db.prepare("INSERT INTO stripe_connected_accounts(id,organization_id,stripe_account_id,country,livemode,status,card_payments_status,requirements_json,created_at,updated_at)VALUES('connected',?,'acct_seller','US',0,'ready','active','[]',?,?)").bind(ORG,NOW,NOW).run()
  await db.prepare("INSERT INTO payment_servicing_tenants(organization_id,stripe_account_id,livemode,retained_at)VALUES('deleted-other-tenant','acct_seller',0,?)").bind(NOW).run()
  await assert.rejects(()=>retainPaymentsForTenantDeletion(db,ORG),/conflicting Payments servicing ownership/u)
  assert.equal(await db.prepare('SELECT organization_id FROM payment_servicing_tenants WHERE stripe_account_id=? AND livemode=0').bind('acct_seller').first('organization_id'),'deleted-other-tenant')
  assert.equal(await db.prepare('SELECT stripe_account_id FROM stripe_connected_accounts WHERE organization_id=?').bind(ORG).first('stripe_account_id'),'acct_seller')
  assert.equal(await db.prepare('SELECT id FROM organization WHERE id=?').bind(ORG).first('id'),ORG)
  assert.equal(await db.prepare("SELECT status FROM payment_checkout_holds WHERE payment_id='retention-conflict'").first('status'),'active')
 }finally{await runtime.dispose()}
})

test('an expired payment hold no longer consumes session capacity', {timeout:120000},async()=>{
 const {db,runtime,env}=await boot();try{
  await payable(db,'expired','2000-01-01T00:00:00.000Z')
  const booking=await claimSessionCapacity(db,{policyJson: OPEN_TERMS_JSON, env,organizationId:ORG,productId:'product',sessionId:'session',productVariantId:'variant',partySize:1})
  assert.equal(await db.prepare('SELECT party_size FROM bookings WHERE id=?').bind(booking.bookingId).first('party_size'),1)
  assert.equal(await db.prepare("SELECT status FROM payment_checkout_holds WHERE payment_id='expired'").first('status'),'active')
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
  await db.batch(events.map(([id,payment,kind,currency,amount,source],index)=>db.prepare('INSERT INTO payment_usage_events(id,organization_id,payment_id,kind,currency,amount,source_id,provider_occurred_at,created_at)VALUES(?,?,?,?,?,?,?,?,?)').bind(id,ORG,payment,kind,currency,amount,source,NOW,new Date(Date.parse(NOW)+index*1000).toISOString())))
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
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM payment_usage_events WHERE delivery_at IS NULL AND error='Meter events are unavailable at the test boundary'").first('n'),4)
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
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM payment_usage_events WHERE delivery_at IS NOT NULL AND error IS NULL').first('n'),4)
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM analytics_events WHERE organization_id='platform' AND payload_json->>'$.event_name'='payments_volume_billed' AND payload_json->>'$.properties.volume_minor'=10000").first('n'),1)
  assert.deepEqual(await deliverPaymentsUsage(db,env,ORG),{delivered:0})
  assert.equal(sent.length,8)
  // Stripe refuses one meter outright: that event keeps Stripe’s reason and fails every delivery until Stripe takes it; a later event on another meter is still billed.
  answer='invalid'
  await db.prepare("INSERT INTO payment_usage_events(id,organization_id,kind,currency,amount,source_id,provider_occurred_at,created_at)VALUES('late',?,'ad_spend','USD',100,'google_ads:1234567890:2026-10-01',?,?),('later',?,'stripe_cost','USD',45,'fee:txn_2:revision:1',?,?)").bind(ORG,NOW,NOW,ORG,NOW,new Date(Date.parse(NOW)+60_000).toISOString()).run()
  await assert.rejects(()=>deliverPaymentsUsage(db,env,ORG),/Stripe did not take 1 of 2 usage events.*No active meter/u)
  assert.deepEqual(await db.prepare("SELECT id,delivery_at IS NOT NULL AS delivered,error FROM payment_usage_events WHERE id IN ('late','later') ORDER BY id").all().then(result=>result.results),[
   {id:'late',delivered:0,error:'No active meter was found for event_name krabiclaw_ad_spend'},
   {id:'later',delivered:1,error:null},
  ])
  await assert.rejects(()=>deliverPaymentsUsage(db,env,ORG),/No active meter/u)
  assert.equal(sent.length,11)
  answer='ok'
  assert.deepEqual(await deliverPaymentsUsage(db,env,ORG),{delivered:1})
  assert.equal(sent.length,12)
  assert.deepEqual(await db.prepare("SELECT delivery_at IS NOT NULL AS delivered,error FROM payment_usage_events WHERE id='late'").first(),{delivered:1,error:null})
  // A business with no Stripe customer has nothing to bill usage to: the delivery fails with that reason on the event.
  await db.prepare('UPDATE organization SET "stripeCustomerId"=NULL WHERE id=?').bind(ORG).run()
  await db.prepare("INSERT INTO payment_usage_events(id,organization_id,kind,currency,amount,source_id,provider_occurred_at,created_at)VALUES('orphaned',?,'ad_spend','USD',100,'google_ads:1234567890:2026-10-02',?,?)").bind(ORG,NOW,NOW).run()
  await assert.rejects(()=>deliverPaymentsUsage(db,env,ORG),/no Stripe customer to bill this usage to/u)
  assert.deepEqual(await db.prepare("SELECT delivery_at,error FROM payment_usage_events WHERE id='orphaned'").first(),{delivery_at:null,error:'The business has no Stripe customer to bill this usage to'})
  assert.equal(sent.length,12)
 }finally{await runtime.dispose()}
})

test('a stay purchase claim cancels Stripe before releasing only its held nights, and a replay completes without a second cancellation', { timeout: 120_000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) })
  const { db, runtime } = await boot()
  try {
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_URL: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_local_boundary', NUXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_local_boundary' }
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
    for (const [date, hold] of [['2099-10-01', 'h:changing'], ['2099-10-02', 'h:changing'], ['2099-10-03', 'h:other-stay']]) {
      await db.prepare("INSERT INTO product_nights(organization_id,product_id,date,price_minor,min_stay_arrival,source,updated_by) VALUES(?,'cabin',?,10000,1,'host','host')").bind(ORG, date).run()
      await db.prepare("INSERT INTO stay_nights(organization_id,product_id,date,hold_id) VALUES(?,'cabin',?,?)").bind(ORG, date, hold).run()
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
        cancellations++
        nativeStatus = 'canceled'
      } else assert.equal(url.pathname, '/v1/payment_intents/pi_changing')
      return Response.json({ id: 'pi_changing', object: 'payment_intent', status: nativeStatus, amount: 20000, currency: 'usd', livemode: false, payment_method_types: ['card'], metadata: { krabiclaw_payment_id: 'changing' } })
    })
    const app = new H3()
    app.use(event => { event.context.organizationId = event.req.headers.get('x-test-organization') ?? ORG })
    app.get('/api/public/payments/:paymentId', paymentHandoffRoute)
    app.post('/api/public/payments/:paymentId/cancel', paymentCancelRoute)
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
    const open = await openHandoff.json()
    assert.deepEqual(open, {
      payment_id: 'changing', state: 'open', title: 'Cabin', quantity: 1, unit_amount: 20000,
      stay: { product_id: 'cabin', check_in_date: '2099-10-01', check_out_date: '2099-10-03', nights: 2, nightly: [10000, 10000], adults: 1, children: 0, infants: 0, cancellation_policy: 'flexible' },
      kind: 'stay', image_url: null, starts_at: null, ends_at: null, timezone: null, party_size: null, product_slug: 'cabin', location_slug: 'cabin-site', free_cancellation_until: null,
      subtotal: 20000, currency: 'USD', expires_at: '2099-09-30T00:00:00.000Z', stripe_account_id: 'acct_seller', publishable_key: 'pk_test_local_boundary',
      payment_method_types: ['card'], customer_session_client_secret: null, bank_verification_url: null, surcharge_basis_points: null,
    })
    const originalNights = (await db.prepare('SELECT * FROM stay_nights ORDER BY date').all()).results
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
      assert.deepEqual(await expiredHandoff.json(), { ...open, state: 'expired', ...(column === 'checkout_expires_at' ? { expires_at: NOW } : {}) })
      assert.equal(cancellations, 0)
      assert.deepEqual(await requirePayment(db, ORG, 'changing'), lapsedPayment)
      assert.deepEqual((await db.prepare('SELECT * FROM stay_nights ORDER BY date').all()).results, originalNights)
      assert.deepEqual((await db.prepare('SELECT payment_id,status FROM payment_checkout_holds ORDER BY payment_id').all()).results, [{ payment_id: 'changing', status: 'active' }, { payment_id: 'other-stay', status: 'active' }])
      await db.prepare(`UPDATE payments SET ${column}=? WHERE id='changing'`).bind(expiry).run()
    }
    const canceled = await cancel(claims.get('changing')!)
    assert.equal(canceled.status, 200, await canceled.clone().text())
    assert.deepEqual(await canceled.json(), { status: 'canceled' })
    assert.equal((await requirePayment(db, ORG, 'changing')).captured_amount, 0)
    const failedHandoff = await app.request(Object.assign(new Request(`https://payments.proof.example/api/public/payments/changing?claim=${claims.get('changing')!}`), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
    assert.equal(failedHandoff.status, 200, await failedHandoff.clone().text())
    assert.deepEqual(await failedHandoff.json(), { ...open, state: 'failed' })
    const calendar = await readStayCalendar(db, { organizationId: ORG, actorId: 'host', manage: true }, { productId: 'cabin', from: '2099-10-01', to: '2099-10-04' })
    assert.deepEqual(calendar.nights.map(night => [night.date, night.available, night.held_until === null]), [
      ['2099-10-01', true, true], ['2099-10-02', true, true], ['2099-10-03', false, false],
    ])
    assert.deepEqual((await db.prepare('SELECT payment_id,status FROM payment_checkout_holds ORDER BY payment_id').all()).results, [{ payment_id: 'changing', status: 'released' }, { payment_id: 'other-stay', status: 'active' }])
    assert.equal(await db.prepare("SELECT COUNT(*) FROM stay_nights WHERE hold_id='h:changing'").first('COUNT(*)'), 0)
    await db.prepare("UPDATE payments SET return_expires_at=?,checkout_expires_at=? WHERE id='changing'").bind(NOW,NOW).run()
    const replay = await cancel(claims.get('changing')!)
    assert.equal(replay.status, 200)
    assert.deepEqual(await replay.json(), { status: 'canceled' })
    assert.equal(cancellations, 1)
  } finally {
    await runtime.dispose()
  }
})

test('ACH Direct Debit payment review and confirmation handles bank account details, zero surcharge, and processing hold extension', { timeout: 120_000 }, async (t) => {
  const { db, runtime } = await boot()
  try {
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-proof-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only', STRIPE_SECRET_KEY: 'sk_test_local_boundary' }
    await payable(db, 'ach-payment')
    const opening = { id: 'ach-request', kind: 'booking' as const, organization_id: ORG, location_id: null, user_id: 'guest', review_id: null, payload: threadPayloadForGuest({ name: 'Guest', email: 'guest@example.com' }), created_at: NOW, updated_at: NOW }
    await db.batch(requestInsertQueries(opening).map(write => db.prepare(write.query).bind(...write.params)))
    await db.prepare("UPDATE payment_checkout_holds SET request_id=? WHERE payment_id='ach-payment'").bind(opening.id).run()
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
          metadata: { krabiclaw_payment_id: 'ach-payment' },
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
          metadata: { krabiclaw_payment_id: 'ach-payment' },
          payment_method: 'pm_achproof123',
        })
      }
      if (url.pathname === '/v1/payment_intents/pi_ach-payment/confirm' && init?.method === 'POST') {
        // A method that leaves the site comes back to the business's own pay page, never the platform.
        assert.equal(new URLSearchParams(String(init.body)).get('return_url'), `https://payments.proof.example/pay/ach-payment?claim=${claim}`)
        return Response.json({
          id: 'pi_ach-payment',
          object: 'payment_intent',
          status: 'processing',
          amount: 10000,
          currency: 'usd',
          client_secret: 'pi_ach-payment_secret',
          payment_method: 'pm_achproof123',
          livemode: false,
          metadata: { krabiclaw_payment_id: 'ach-payment' },
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
      metadata: { krabiclaw_payment_id: 'ach-payment' },
      status: 'requires_payment_method', amount: 10000,
      last_payment_error: { type: 'card_error', code: 'card_declined' },
    } as Stripe.PaymentIntent
    const originalHold = await db.prepare("SELECT status, expires_at FROM payment_checkout_holds WHERE payment_id='ach-payment'").first()
    await reconcilePaymentIntent(db, stripe, await requirePayment(db, ORG, 'ach-payment'), declinedIntent, env)
    assert.equal((await requirePayment(db, ORG, 'ach-payment')).captured_amount, 0)
    assert.equal((await requireClaimedPayment(db, stripe, ORG, 'ach-payment', claim)).state, 'open')
    assert.deepEqual(await db.prepare("SELECT status, expires_at FROM payment_checkout_holds WHERE payment_id='ach-payment'").first(), originalHold)

    const review = await reviewPayment(db, stripe, ORG, 'ach-payment', claim, 'pm_achproof123', null)
    assert.equal(review.surcharge, 0)
    assert.equal(review.tax, 0)
    assert.equal(review.total, 10000)
    assert.equal(review.method.type, 'us_bank_account')
    assert.equal(review.method.bank_name, 'STRIPE TEST BANK')
    assert.equal(review.method.last4, '6789')

    const confirm = await confirmPayment(db, stripe, env, ORG, 'ach-payment', claim, { payment_method_id: 'pm_achproof123', total: 10000 }, 'https://payments.proof.example')
    assert.deepEqual(confirm, { status: 'processing', client_secret: null, requires_action: false, bank_verification_url: null })

    // Capacity hold should be extended by 14 days rather than expiring immediately
    const hold = await db.prepare("SELECT status, expires_at FROM payment_checkout_holds WHERE payment_id='ach-payment'").first<{ status: string; expires_at: string }>()
    assert.equal(hold?.status, 'active')
    const holdExpires = Date.parse(hold!.expires_at)
    const expectedMinExpires = Date.now() + 13 * 86400 * 1000
    assert.ok(holdExpires > expectedMinExpires, `Hold expires_at ${hold!.expires_at} should be at least 13 days in the future`)

    // A clearing failure is reported, but Stripe still permits a new method.
    const failedIntent = {
      id: 'pi_ach-payment',
      livemode: false,
      currency: 'USD',
      metadata: { krabiclaw_payment_id: 'ach-payment' },
      status: 'requires_payment_method',
      amount: 10000,
      last_payment_error: { code: 'bank_account_unusable', message: 'The bank payment failed' },
    } as unknown as Stripe.PaymentIntent
    // A bank debit fails days later, long after the time to pay: the 14 days it was holding go back.
    await db.prepare("UPDATE payments SET checkout_expires_at='2026-01-01T00:00:00.000Z' WHERE id='ach-payment'").run()
    await reconcilePaymentIntent(db, stripe, await requirePayment(db, ORG, 'ach-payment'), failedIntent, env)

    assert.equal((await requirePayment(db, ORG, 'ach-payment')).captured_amount, 0)
    const failedHold = await db.prepare("SELECT status, expires_at FROM payment_checkout_holds WHERE payment_id='ach-payment'").first<{ status: string; expires_at: string }>()
    assert.equal(failedHold?.status, 'active')
    assert.ok(Date.parse(failedHold!.expires_at) <= Date.now() + 61 * 60_000, `Hold expires_at ${failedHold!.expires_at} should have given the 14 days back`)
    assert.equal(await db.prepare("SELECT count(*) FROM activity_entries WHERE request_id=? AND event_name='payment.payment_failed'").bind(opening.id).first('count(*)'), 1)

    // Cancellation is terminal and releases the active capacity hold.
    achIntentStatus = 'canceled'
    await reconcilePaymentIntent(db, stripe, await requirePayment(db, ORG, 'ach-payment'), { ...failedIntent, status: 'canceled', last_payment_error: null }, env)
    assert.equal((await requirePayment(db, ORG, 'ach-payment')).captured_amount, 0)
    assert.equal((await requireClaimedPayment(db, stripe, ORG, 'ach-payment', claim)).state, 'failed')
    const releasedHold = await db.prepare("SELECT status FROM payment_checkout_holds WHERE payment_id='ach-payment'").first<{ status: string }>()
    assert.equal(releasedHold?.status, 'released')
  } finally {
    await runtime.dispose()
  }
})

test('a business registered for Stripe Tax has tax calculated by Stripe from the billing address, attached to the intent and confirmed as reviewed', { timeout: 120_000 }, async (t) => {
  const { db, runtime } = await boot()
  try {
    const env = { ...await runtime.getBindings<CloudflareEnv>(), STRIPE_SECRET_KEY: 'sk_test_local_boundary' }
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
        return Response.json({ id: 'pi_taxed', object: 'payment_intent', status: 'requires_confirmation', amount: Number(body.get('amount')), currency: 'usd', livemode: false, metadata: { krabiclaw_payment_id: 'taxed' }, payment_method: 'pm_cardUS', amount_details: { surcharge: { status: 'available', maximum_amount: 330 } } })
      }
      if (url.pathname === '/v1/payment_intents/pi_taxed' && init?.method === 'GET') {
        return Response.json({ id: 'pi_taxed', object: 'payment_intent', status: 'requires_confirmation', amount: 11025, currency: 'usd', livemode: false, metadata: { krabiclaw_payment_id: 'taxed' }, payment_method: 'pm_cardUS' })
      }
      if (url.pathname === '/v1/payment_intents/pi_taxed/confirm' && init?.method === 'POST') {
        sent.confirm = body
        return Response.json({ id: 'pi_taxed', object: 'payment_intent', status: 'processing', amount: 11355, currency: 'usd', client_secret: 'pi_taxed_secret', payment_method: 'pm_cardUS', livemode: false, metadata: { krabiclaw_payment_id: 'taxed' } })
      }
      throw new Error(`Unexpected Stripe request: ${init?.method} ${url.pathname}`)
    })
    const stripe = getStripe(env)

    const review = await reviewPayment(db, stripe, ORG, 'taxed', claim, 'pm_cardUS', '203.0.113.9')
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
    await assert.rejects(confirmPayment(db, stripe, env, ORG, 'taxed', claim, { payment_method_id: 'pm_cardUS', total: 10330 }, 'https://payments.proof.example'), /Review the payment again/u)
    assert.equal(sent.confirm, undefined)
    const confirmed = await confirmPayment(db, stripe, env, ORG, 'taxed', claim, { payment_method_id: 'pm_cardUS', total: 11355 }, 'https://payments.proof.example')
    assert.equal(confirmed.status, 'processing')
    assert.equal(sent.confirm!.get('amount_to_confirm'), '11355')
    assert.equal(sent.confirm!.get('amount_details[surcharge][amount]'), '330')
  } finally {
    await runtime.dispose()
  }
})

test('processing webhooks extend only active checkout holds and preserve capacity without a confirmation response', { timeout: 120_000 }, async (t) => {
  const { db, runtime } = await boot()
  try {
    const env = { ...await runtime.getBindings<CloudflareEnv>(), STRIPE_SECRET_KEY: 'sk_test_local_boundary' }
    await db.prepare("INSERT INTO stripe_connected_accounts(id,organization_id,stripe_account_id,livemode,country,status,created_at,updated_at) VALUES('connected',?,'acct_seller',0,'US','ready',?,?)").bind(ORG, NOW, NOW).run()
    const expires = new Date(Date.now() + 5 * 60_000).toISOString()
    const originalFetch = globalThis.fetch
    t.mock.method(globalThis, 'fetch', async (request, init) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      if (url.origin !== 'https://api.stripe.com') return originalFetch(request, init)
      assert.equal(init?.method, 'GET')
      assert.equal(new Headers(init?.headers).get('stripe-account'), 'acct_seller')
      const id = url.pathname.split('/').at(-1)!
      return Response.json({ id, object: 'payment_intent', livemode: false, currency: 'usd', amount: 10000, status: 'processing', metadata: { krabiclaw_payment_id: id.slice(3) } })
    })
    for (const status of ['active', 'released', 'converted']) {
      const id = `processing-${status}`
      await payable(db, id, expires)
      if (status !== 'active') await db.prepare('UPDATE payment_checkout_holds SET status=? WHERE payment_id=?').bind(status, id).run()
      const event = { id: `evt_${id}`, type: 'payment_intent.processing', account: 'acct_seller', livemode: false, data: { object: { id: `pi_${id}`, metadata: { krabiclaw_payment_id: id } } } } as Stripe.Event
      await processPaymentEvent(db, getStripe(env), event, env)
      const hold = await db.prepare('SELECT status, expires_at FROM payment_checkout_holds WHERE payment_id=?').bind(id).first<{ status: string; expires_at: string }>()
      assert.equal(hold?.status, status)
      assert.equal((await requirePayment(db, ORG, id)).captured_amount, 0)
      if (status === 'active') {
        assert.ok(Date.parse(hold!.expires_at) >= Date.now() + 13 * 86400_000)
        await assert.rejects(claimSessionCapacity(db, { policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: 'product', sessionId: 'session', productVariantId: 'variant', partySize: 1 }), /no longer has room/u)
      } else {
        assert.equal(hold?.expires_at, expires)
      }
    }
  } finally {
    await runtime.dispose()
  }
})

async function confirmable(db: D1Database, id: string, holdExpires: string, checkoutExpires = '2099-09-30T00:00:00.000Z') {
 await payable(db, id, checkoutExpires)
 const claim = crypto.randomUUID() + crypto.randomUUID()
 const opening = { id: `request-${id}`, kind: 'booking' as const, organization_id: ORG, location_id: null, user_id: 'guest', review_id: null, payload: threadPayloadForGuest({ name: 'Guest', email: 'buyer@krabiclaw-proof.com' }), created_at: NOW, updated_at: NOW }
 await db.batch(requestInsertQueries(opening).map(write => db.prepare(write.query).bind(...write.params)))
 await db.prepare("UPDATE payments SET return_token_hash=?,return_expires_at='2099-01-01T00:00:00.000Z',review_json=? WHERE id=?").bind(await tokenHash(claim), JSON.stringify({ payment_method_id: 'pm_proof', subtotal: 10000, tax: 0, tax_included: 0, surcharge: 0, total: 10000, reviewed_at: NOW }), id).run()
 await db.prepare('UPDATE payment_checkout_holds SET expires_at=?,request_id=? WHERE payment_id=?').bind(holdExpires, opening.id, id).run()
 return claim
}
/** Stripe's answers for the intents, charges and refunds a confirmation and its settlement read, and the platform meter its captured volume is billed on. */
function fakeStripe(t: TestContext, handle: (url: URL, init: RequestInit | undefined) => Promise<Response | null> | Response | null, statuses: Record<string, string>) {
 const originalFetch = globalThis.fetch
 const calls = { confirm: [] as string[], capture: [] as string[], cancel: [] as string[], refund: [] as string[], read: [] as string[], billed: [] as string[] }
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
  const intent = () => ({ id: `pi_${paymentId}`, object: 'payment_intent', livemode: false, currency: 'usd', amount: 10000, amount_received: statuses[paymentId!] === 'succeeded' ? 10000 : 0, status: statuses[paymentId!], client_secret: `pi_${paymentId}_secret`, payment_method: 'pm_proof', latest_charge: statuses[paymentId!] === 'succeeded' || statuses[paymentId!] === 'requires_capture' ? `ch_${paymentId}` : null, last_payment_error: null, metadata: { krabiclaw_payment_id: paymentId } })
  if (resource === 'payment_intents' && action === 'confirm') { calls.confirm.push(paymentId!); return Response.json(intent()) }
  if (resource === 'payment_intents' && action === 'capture') { calls.capture.push(paymentId!); statuses[paymentId!] = 'succeeded'; return Response.json(intent()) }
  if (resource === 'payment_intents' && action === 'cancel') { calls.cancel.push(paymentId!); statuses[paymentId!] = 'canceled'; return Response.json(intent()) }
  if (resource === 'payment_intents' && init?.method === 'GET') { calls.read.push(paymentId!); return Response.json(intent()) }
  if (resource === 'charges') return Response.json({ id: `ch_${paymentId}`, object: 'charge', livemode: false, amount: 10000, currency: 'usd', created: 1_790_000_000, payment_intent: `pi_${paymentId}`, receipt_url: 'https://pay.stripe.com/receipts/proof', billing_details: { email: 'buyer@krabiclaw-proof.com' } })
  if (resource === 'refunds' && init?.method === 'POST') { const paid = new URLSearchParams(String(init.body)).get('payment_intent')!; calls.refund.push(paid); return Response.json({ id: `re_${paid}`, object: 'refund', amount: 10000, currency: 'usd', status: 'succeeded', payment_intent: paid, reason: 'requested_by_customer', metadata: { krabiclaw_refund_id: new URLSearchParams(String(init.body)).get('metadata[krabiclaw_refund_id]') } }) }
  throw new Error(`Unexpected Stripe request ${init?.method} ${url.pathname}`)
 })
 return calls
}
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()
const holdOf = (db: D1Database, id: string) => db.prepare('SELECT status, expires_at FROM payment_checkout_holds WHERE payment_id=?').bind(id).first<{ status: string; expires_at: string }>()
const stripeEnv = async (runtime: Miniflare, env: CloudflareEnv) => ({ ...env, ...await runtime.getBindings<CloudflareEnv>(), STRIPE_SECRET_KEY: 'sk_test_local_boundary', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only', EMAIL_REPLY_SECRET: 'local-proof-reply' } as CloudflareEnv)
/** Email goes to Resend, as in production. */
const resendEnv = (env: CloudflareEnv) => ({ ...env, EMAIL_DELIVERY_MODE: 'provider', RESEND_API_KEY: 're_test_local', EMAIL_FROM: 'KrabiClaw <proof@example.com>' } as CloudflareEnv)
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
  await db.prepare('INSERT INTO user(id,name,email,emailVerified) VALUES(?,?,?,1)').bind(role, role, `${role}@krabiclaw-proof.com`).run()
  await db.prepare('INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,1)').bind(`${role}-member`, ORG, role, role).run()
 }
}
const sentMail = (emails: string[]) => emails.map(body => JSON.parse(body) as { to: string[]; subject: string; html: string })

test('a card is authorized, booked, then captured, and a hold that has lapsed stops the confirmation before Stripe is asked', { timeout: 120_000 }, async t => {
 const { db, runtime, env: bootEnv } = await boot()
 try {
  const env = await stripeEnv(runtime, bootEnv)
  await db.prepare("INSERT INTO stripe_connected_accounts(id,organization_id,stripe_account_id,livemode,country,status,created_at,updated_at) VALUES('connected',?,'acct_seller',0,'US','ready',?,?)").bind(ORG, NOW, NOW).run()
  const statuses: Record<string, string> = { lapsed: 'requires_confirmation', direct: 'requires_confirmation', authenticating: 'requires_confirmation' }
  const heldWhenAsked: Record<string, string> = {}
  const bookedWhenCaptured: Record<string, number> = {}
  const calls = fakeStripe(t, async (url, init) => {
   const [, , resource, id, action] = url.pathname.split('/')
   if (resource !== 'payment_intents' || init?.method !== 'POST') return null
   const paymentId = id!.slice(3)
   if (action === 'confirm') {
    heldWhenAsked[paymentId] = (await holdOf(db, paymentId))!.expires_at
    statuses[paymentId] = paymentId === 'direct' ? 'requires_capture' : 'requires_action'
   }
   if (action === 'capture') bookedWhenCaptured[paymentId] = await db.prepare('SELECT count(*) n FROM payment_checkout_holds h JOIN bookings b ON b.id=h.converted_booking_id WHERE h.payment_id=?').bind(paymentId).first<number>('n') ?? 0
   return null
  }, statuses)
  const stripe = getStripe(env)
  const confirm = (id: string, claim: string) => confirmPayment(db, stripe, env, ORG, id, claim, { payment_method_id: 'pm_proof', total: 10000 }, 'https://payments.proof.example')

  // The buyer's window is open; only the hold has gone. Stripe is never asked.
  const lapsed = await confirmable(db, 'lapsed', inMinutes(-1))
  await assert.rejects(() => confirm('lapsed', lapsed), error => error instanceof HTTPError && error.statusCode === 409 && (error.data as { code: string }).code === 'payment_expired')
  assert.deepEqual(calls.confirm, [])
  assert.equal(await db.prepare('SELECT count(*) n FROM bookings').first('n'), 0)
  await db.prepare("UPDATE payment_checkout_holds SET status='released' WHERE payment_id='lapsed'").run()

  // A card with no authentication: the hold is extended before Stripe is asked, and the money moves only after the booking exists.
  const direct = await confirmable(db, 'direct', inMinutes(1), inMinutes(1))
  assert.deepEqual(await confirm('direct', direct), { status: 'succeeded', client_secret: null, requires_action: false, bank_verification_url: null })
  assert.ok(Date.parse(heldWhenAsked.direct!) >= Date.now() + 55 * 60_000, `hold was ${heldWhenAsked.direct} when Stripe was asked`)
  assert.deepEqual(bookedWhenCaptured, { direct: 1 })
  assert.equal((await holdOf(db, 'direct'))?.status, 'converted')
  assert.equal(await db.prepare('SELECT count(*) n FROM bookings').first('n'), 1)
  assert.equal((await requirePayment(db, ORG, 'direct')).captured_amount, 10000)

  // 3DS: the seat is held across the authentication, the browser gets the secret, and the webhook books and captures once it passes.
  await db.prepare("UPDATE product_sessions SET capacity=2 WHERE id='session'").run()
  const authenticating = await confirmable(db, 'authenticating', inMinutes(1), inMinutes(1))
  assert.deepEqual(await confirm('authenticating', authenticating), { status: 'requires_action', client_secret: 'pi_authenticating_secret', requires_action: true, bank_verification_url: null })
  assert.ok(Date.parse((await holdOf(db, 'authenticating'))!.expires_at) >= Date.now() + 55 * 60_000)
  await assert.rejects(claimSessionCapacity(db, { policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: 'product', sessionId: 'session', productVariantId: 'variant', partySize: 1 }), /no longer has room/u)
  assert.deepEqual(calls.capture, ['direct'])
  statuses.authenticating = 'requires_capture'
  const event = { id: 'evt_authorized', type: 'payment_intent.amount_capturable_updated', account: 'acct_seller', livemode: false, data: { object: { id: 'pi_authenticating', metadata: { krabiclaw_payment_id: 'authenticating' } } } } as unknown as Stripe.Event
  await processPaymentEvent(db, stripe, event, env)
  assert.deepEqual(bookedWhenCaptured, { direct: 1, authenticating: 1 })
  assert.equal((await requirePayment(db, ORG, 'authenticating')).captured_amount, 10000)
  assert.deepEqual(calls.billed, ['krabiclaw_captured_volume:10000', 'krabiclaw_captured_volume:10000'], 'each capture is billed on the business’s meter')
  assert.equal(await db.prepare('SELECT count(*) n FROM bookings').first('n'), 2)
 } finally { await runtime.dispose() }
})

test('an authorization that lost its capacity is cancelled and never charged; capture failures are settled against the booking that exists', { timeout: 120_000 }, async t => {
 const { db, runtime, env: bootEnv } = await boot()
 try {
  const env = await stripeEnv(runtime, bootEnv)
  await db.prepare("INSERT INTO stripe_connected_accounts(id,organization_id,stripe_account_id,livemode,country,status,created_at,updated_at) VALUES('connected',?,'acct_seller',0,'US','ready',?,?)").bind(ORG, NOW, NOW).run()
  const statuses: Record<string, string> = { taken: 'requires_capture', lost: 'requires_capture', refused: 'requires_capture', raced: 'requires_capture' }
  let captures = 0
  const calls = fakeStripe(t, (url) => {
   if (url.pathname === '/v1/payment_intents/pi_voided/capture') return Response.json({ error: { type: 'api_error', message: 'Stripe could not capture' } }, { status: 500, headers: { 'stripe-should-retry': 'false' } })
   const failing = url.pathname.match(/^\/v1\/payment_intents\/pi_(lost|refused|raced)\/capture$/u)?.[1]
   if (!failing || captures++ > 0) return null
   // The capture went through at Stripe and only its answer was lost.
   if (failing === 'lost') { statuses.lost = 'succeeded'; return Response.json({ error: { type: 'api_error', message: 'Answer lost' } }, { status: 500, headers: { 'stripe-should-retry': 'false' } }) }
   if (failing === 'refused') return Response.json({ error: { type: 'api_error', message: 'Stripe could not capture' } }, { status: 500, headers: { 'stripe-should-retry': 'false' } })
   statuses.raced = 'succeeded'
   return Response.json({ error: { type: 'invalid_request_error', code: 'payment_intent_unexpected_state', message: 'This PaymentIntent has already been captured' } }, { status: 400 })
  }, statuses)
  const stripe = getStripe(env)
  const deliver = (id: string, event = `evt_${id}`) => processPaymentEvent(db, stripe, { id: event, type: 'payment_intent.amount_capturable_updated', account: 'acct_seller', livemode: false, data: { object: { id: `pi_${id}`, metadata: { krabiclaw_payment_id: id } } } } as unknown as Stripe.Event, env)
  const bookingsOf = (id: string) => db.prepare('SELECT count(*) n FROM bookings b JOIN payment_checkout_holds h ON h.converted_booking_id=b.id WHERE h.payment_id=?').bind(id).first('n')

  // The hold lapsed and someone else took the only seat. Stripe holds an authorization; nothing has been charged.
  await confirmable(db, 'taken', inMinutes(-1))
  await db.prepare("UPDATE payment_checkout_holds SET status='released' WHERE payment_id='taken'").run()
  const seat = await claimSessionCapacity(db, { policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: 'product', sessionId: 'session', productVariantId: 'variant', partySize: 1 })
  await deliver('taken')
  assert.deepEqual([calls.cancel, calls.capture, calls.refund], [['taken'], [], []])
  assert.equal(await db.prepare('SELECT count(*) n FROM bookings WHERE id<>?').bind(seat.bookingId).first('n'), 0)
  assert.equal(await db.prepare("SELECT count(*) n FROM payment_refunds WHERE payment_id='taken'").first('n'), 0)
  const uncharged = await requirePayment(db, ORG, 'taken')
  assert.deepEqual([uncharged.captured_amount, uncharged.subject_id], [0, null])
  await deliver('taken', 'evt_taken_again')
  assert.deepEqual([calls.cancel, calls.capture, calls.refund], [['taken'], [], []])

  await db.prepare("UPDATE product_sessions SET capacity=9 WHERE id='session'").run()
  for (const id of ['lost', 'refused', 'raced']) await confirmable(db, id, inMinutes(30))

  // Its answer was lost, so Stripe is read again: already captured, so no second capture, and the same booking.
  captures = 0
  await assert.rejects(() => deliver('lost'))
  assert.equal(await bookingsOf('lost'), 1)
  assert.equal((await requirePayment(db, ORG, 'lost')).captured_amount, 0)
  await deliver('lost', 'evt_lost_again')
  assert.deepEqual(calls.capture, [])
  assert.equal(await bookingsOf('lost'), 1)
  assert.equal((await requirePayment(db, ORG, 'lost')).captured_amount, 10000)

  // Stripe still holds the authorization, so the redelivery captures it against the same booking.
  captures = 0
  await assert.rejects(() => deliver('refused'))
  assert.equal(await bookingsOf('refused'), 1)
  assert.equal(statuses.refused, 'requires_capture')
  await deliver('refused', 'evt_refused_again')
  assert.deepEqual(calls.capture, ['refused'])
  assert.equal(await bookingsOf('refused'), 1)
  assert.equal((await requirePayment(db, ORG, 'refused')).captured_amount, 10000)

  // Another delivery captured first: Stripe's own status finishes this one.
  captures = 0
  await deliver('raced')
  assert.equal(await bookingsOf('raced'), 1)
  assert.equal((await requirePayment(db, ORG, 'raced')).captured_amount, 10000)

  // Stripe cancelled an authorization a booking was committed on: nothing was paid, and the business is told.
  await confirmable(db, 'voided', inMinutes(30))
  statuses.voided = 'requires_capture'
  await assert.rejects(() => deliver('voided'))
  assert.equal(await bookingsOf('voided'), 1)
  statuses.voided = 'canceled'
  await processPaymentEvent(db, stripe, { id: 'evt_voided_canceled', type: 'payment_intent.canceled', account: 'acct_seller', livemode: false, data: { object: { id: 'pi_voided', metadata: { krabiclaw_payment_id: 'voided' } } } } as unknown as Stripe.Event, env)
  assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE request_id='request-voided' AND event_name='payment.payment_failed'").first('n'), 1)
  assert.equal(await bookingsOf('voided'), 1)
 } finally { await runtime.dispose() }
})

test('a bank debit waiting on microdeposits keeps its capacity, sends the buyer to Stripe, and gives the capacity back if verification fails', { timeout: 120_000 }, async t => {
 const { db, runtime, env: bootEnv } = await boot()
 try {
  const env = await stripeEnv(runtime, bootEnv)
  await db.prepare("INSERT INTO stripe_connected_accounts(id,organization_id,stripe_account_id,livemode,country,status,created_at,updated_at) VALUES('connected',?,'acct_seller',0,'US','ready',?,?)").bind(ORG, NOW, NOW).run()
  const page = 'https://payments.stripe.com/microdeposit/proof'
  let stage = 'requires_confirmation'
  const reply = () => Response.json({ id: 'pi_bank', object: 'payment_intent', livemode: false, currency: 'usd', amount: 10000, amount_received: 0, status: stage, payment_method: 'pm_proof', latest_charge: null, client_secret: 'pi_bank_secret', metadata: { krabiclaw_payment_id: 'bank' },
   next_action: stage === 'requires_action' ? { type: 'verify_with_microdeposits', verify_with_microdeposits: { hosted_verification_url: page } } : null,
   last_payment_error: stage === 'requires_payment_method' ? { code: 'payment_method_microdeposit_verification_timeout', message: 'Verification expired' } : null })
  fakeStripe(t, (url, init) => {
   if (url.pathname === '/v1/payment_intents/pi_bank/confirm' && init?.method === 'POST') stage = 'requires_action'
   return url.pathname.startsWith('/v1/payment_intents/pi_bank') ? reply() : null
  }, {})
  const stripe = getStripe(env)
  const claim = await confirmable(db, 'bank', inMinutes(30), inMinutes(1))
  assert.deepEqual(await confirmPayment(db, stripe, env, ORG, 'bank', claim, { payment_method_id: 'pm_proof', total: 10000 }, 'https://payments.proof.example'), { status: 'requires_action', client_secret: null, requires_action: false, bank_verification_url: page })
  assert.ok(Date.parse((await holdOf(db, 'bank'))!.expires_at) >= Date.now() + 13 * 86_400_000)
  assert.equal((await requireClaimedPayment(db, stripe, ORG, 'bank', claim)).state, 'verifying')
  assert.equal((await requirePayment(db, ORG, 'bank')).captured_amount, 0)

  // Verification moves it to processing: still not paid, and the capacity is still held.
  stage = 'processing'
  const event = (id: string, type: string) => ({ id, type, account: 'acct_seller', livemode: false, data: { object: { id: 'pi_bank', metadata: { krabiclaw_payment_id: 'bank' } } } }) as unknown as Stripe.Event
  await processPaymentEvent(db, stripe, event('evt_bank_processing', 'payment_intent.processing'), env)
  assert.equal((await requireClaimedPayment(db, stripe, ORG, 'bank', claim)).state, 'processing')
  assert.equal((await requirePayment(db, ORG, 'bank')).captured_amount, 0)
  assert.equal(await db.prepare('SELECT count(*) n FROM bookings').first('n'), 0)

  // Verification that fails or expires gives the capacity back.
  stage = 'requires_payment_method'
  await processPaymentEvent(db, stripe, event('evt_bank_failed', 'payment_intent.payment_failed'), env)
  assert.ok(Date.parse((await holdOf(db, 'bank'))!.expires_at) <= Date.now() + 61 * 60_000)
  assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE request_id='request-bank' AND event_name='payment.payment_failed'").first('n'), 1)
 } finally { await runtime.dispose() }
})

test('a bank debit that cleared after its capacity went is refunded once and never booked; a failed delivery books once when Stripe redelivers', { timeout: 120_000 }, async t => {
 const { db, runtime, env: bootEnv } = await boot()
 try {
  const env = resendEnv(await stripeEnv(runtime, bootEnv))
  await db.prepare("INSERT INTO stripe_connected_accounts(id,organization_id,stripe_account_id,livemode,country,status,created_at,updated_at) VALUES('connected',?,'acct_seller',0,'US','ready',?,?)").bind(ORG, NOW, NOW).run()
  const emails = resendOutbox(t)
  const statuses: Record<string, string> = { taken: 'succeeded', retried: 'succeeded' }
  let chargeFailures = 0
  const calls = fakeStripe(t, (url) => {
   if (url.pathname === '/v1/refunds/re_pi_taken') return Response.json({ id: 're_pi_taken', object: 'refund', amount: 10000, currency: 'usd', status: 'succeeded', payment_intent: 'pi_taken', reason: 'requested_by_customer', metadata: {} })
   if (url.pathname === '/v1/charges/ch_retried' && chargeFailures-- > 0) return Response.json({ error: { type: 'api_error', message: 'Stripe could not answer' } }, { status: 500, headers: { 'stripe-should-retry': 'false' } })
   return null
  }, statuses)
  const stripe = getStripe(env)
  const deliver = (id: string, event = `evt_${id}`) => processPaymentEvent(db, stripe, { id: event, type: 'payment_intent.succeeded', account: 'acct_seller', livemode: false, data: { object: { id: `pi_${id}`, metadata: { krabiclaw_payment_id: id } } } } as unknown as Stripe.Event, env)

  // A debit has no authorization to cancel: the hold lapsed, someone else took the only seat, and the money goes back through the ordinary refund.
  await confirmable(db, 'taken', inMinutes(-1))
  await db.prepare("UPDATE payment_checkout_holds SET status='released' WHERE payment_id='taken'").run()
  const seat = await claimSessionCapacity(db, { policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: 'product', sessionId: 'session', productVariantId: 'variant', partySize: 1 })
  await deliver('taken')
  assert.deepEqual(calls.refund, ['pi_taken'])
  assert.equal(await db.prepare('SELECT count(*) n FROM bookings WHERE id<>?').bind(seat.bookingId).first('n'), 0)
  assert.equal((await db.prepare("SELECT idempotency_key FROM payment_refunds WHERE payment_id='taken'").first('idempotency_key')), 'unfulfillable:pi_taken')
  assert.match(emails.join(' '), /taken before your payment completed/u)

  // A redelivery that finds the seat free again still does not book a purchase already sent back.
  await db.prepare('DELETE FROM bookings WHERE id=?').bind(seat.bookingId).run()
  await deliver('taken', 'evt_taken_again')
  assert.deepEqual(calls.refund, ['pi_taken'])
  assert.equal(await db.prepare('SELECT count(*) n FROM bookings').first('n'), 0)

  // A failure Stripe will redeliver leaves nothing half done, and the booking lands once.
  await confirmable(db, 'retried', inMinutes(30))
  chargeFailures = 1
  await assert.rejects(() => deliver('retried'))
  assert.equal(await db.prepare('SELECT count(*) n FROM bookings').first('n'), 0)
  assert.equal((await holdOf(db, 'retried'))?.status, 'active')
  await deliver('retried')
  await deliver('retried', 'evt_retried_duplicate')
  assert.equal(await db.prepare('SELECT count(*) n FROM bookings').first('n'), 1)
  assert.equal((await holdOf(db, 'retried'))?.status, 'converted')
 } finally { await runtime.dispose() }
})

test('a payment reads its refunds and disputes from Stripe, carries no checkout secret, and keeps one attempt and one claim', { timeout: 120_000 }, async t => {
 const { db, runtime, env: bootEnv } = await boot()
 try {
  const env = await stripeEnv(runtime, bootEnv)
  await payable(db, 'shown')
  await db.prepare("UPDATE payments SET captured_amount=10000,stripe_charge_id='ch_shown',return_token_hash='hash-shown' WHERE id='shown'").run()
  await db.prepare("INSERT INTO payment_refunds(id,payment_id,idempotency_key,stripe_refund_id,amount,reason,status,note,created_by,created_at,updated_at) VALUES('local-refund','shown','refund:shown','re_shown',500,'requested_by_customer','pending','Goodwill','other',?,?)").bind(NOW, NOW).run()
  const originalFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
   const url = new URL(request instanceof Request ? request.url : String(request))
   if (url.origin !== 'https://api.stripe.com') return originalFetch(request, init)
   assert.equal(new Headers(init?.headers).get('stripe-account'), 'acct_seller')
   if (url.pathname === '/v1/charges/ch_shown') return Response.json({ id: 'ch_shown', object: 'charge', amount: 10000, amount_captured: 10000, amount_refunded: 3000 })
   if (url.pathname === '/v1/refunds') return Response.json({ object: 'list', has_more: false, url: '/v1/refunds', data: [{ id: 're_shown', object: 'refund', amount: 3000, status: 'succeeded', currency: 'usd' }] })
   if (url.pathname === '/v1/disputes') return Response.json({ object: 'list', has_more: false, url: '/v1/disputes', data: [{ id: 'dp_shown', object: 'dispute', amount: 7000, currency: 'usd', reason: 'fraudulent', status: 'needs_response', created: 1_790_000_000, evidence_details: { due_by: 1_790_600_000 } }] })
   throw new Error(`Unexpected Stripe request ${url.pathname}`)
  })
  const detail = await readPaymentDetails(db, env, ORG, 'shown')
  // The row still says nothing was refunded, and a succeeded PaymentIntent would too: the Charge says 3000.
  assert.equal(detail.payment.refunded_amount, 3000)
  assert.equal((await requirePayment(db, ORG, 'shown')).refunded_amount, 0)
  assert.deepEqual(detail.refunds.map(refund => ({ id: refund.id, amount: refund.amount, status: refund.status })), [{ id: 'local-refund', amount: 3000, status: 'succeeded' }])
  assert.deepEqual(detail.disputes, [{ id: 'dp_shown', stripe_dispute_id: 'dp_shown', amount: 7000, currency: 'USD', reason: 'fraudulent', status: 'needs_response', evidence_due_at: new Date(1_790_600_000_000).toISOString(), updated_at: new Date(1_790_000_000_000).toISOString() }])
  for (const field of ['idempotency_key', 'return_token', 'return_token_hash', 'review_json', 'state']) assert.equal(Object.hasOwn(detail.payment, field), false, field)

  await assert.rejects(payable(db, 'twin').then(() => db.prepare("UPDATE payments SET idempotency_key='checkout:shown' WHERE id='twin'").run()), /UNIQUE constraint failed: payments\.idempotency_key/u)
  await assert.rejects(db.prepare("UPDATE payments SET return_token_hash='hash-shown' WHERE id='twin'").run(), /UNIQUE constraint failed: payments\.return_token_hash/u)
 } finally { await runtime.dispose() }
})

test('managed ads keeps MCP creation paused, preserves updates and billing consent, and ends on its recorded day', { timeout: 120_000 }, async t => {
 t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-01T12:00:00.000Z') })
 const { db, runtime } = await boot()
 try {
  const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-managed-ads-proof-secret-long-enough', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_managed_ads_boundary' }
  await db.prepare("INSERT INTO member(id,organizationId,userId,role) VALUES('billing-owner',?,'verified','owner')").bind(ORG).run()
  await db.prepare("INSERT INTO account(id,accountId,providerId,userId,password) VALUES('billing-credential','verified','credential','verified',?)").bind(await hashPassword('ManagedAdsProof123!')).run()
  const login = await createAuth(env).api.signInEmail({ body: { email: 'verified@example.com', password: 'ManagedAdsProof123!' }, asResponse: true })
  assert.equal(login.status, 200)
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const app = new H3()
  app.post('/api/dashboard/services', servicesPostRoute)
  app.get('/api/dashboard/services', servicesGetRoute)
  app.post('/api/mcp', mcpRoute)
  const background: Promise<unknown>[] = []
  // Nitro initializes the Request context before H3; the bare in-process app shares it here too.
  const workerRuntime = { name: 'cloudflare', cloudflare: { env, context: { waitUntil: (promise: Promise<unknown>) => background.push(promise) } } }
  const call = (path: string, method = 'GET', body?: Record<string, unknown>) => app.request(Object.assign(new Request(`https://proof.example${path}`, {
   method, headers: { cookie, host: 'proof.example', origin: 'https://proof.example', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), { context: {}, runtime: workerRuntime }))
  const agree = () => agreeToService(db, env, ORG, 'managed_ads', 'verified')
  const noConsent = async () => assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM organization_services WHERE organization_id=?').bind(ORG).first('count'), 0)
  // A business without the Business subscription gets a concrete setup step before any consent is written.
  await assert.rejects(agree, /Choose Business in Plan/u)
  await noConsent()
  await db.prepare('UPDATE organization SET "stripeCustomerId"=? WHERE id=?').bind('cus_operating', ORG).run()
  await db.prepare("INSERT INTO subscription(id,plan,referenceId,status,seats,stripeSubscriptionId,stripeCustomerId,periodEnd,billingInterval) VALUES('sub-row','business',?,'active',1,'sub_operating','cus_operating',?,'month')").bind(ORG, Math.floor(Date.parse('2026-11-01T00:00:00.000Z') / 1000)).run()
  let defaultCard: string | null = 'pm_default', currency = 'USD', rate: string | null = '0.1', providerUnavailable = false
  let timeZone: string | undefined = 'America/New_York'
  let deliveryUnavailable = false
  let googleReads = 0
  const campaignMutations: Array<{ status: string; budget: string | null }> = []
  const ingests: Array<{ identifier: string | null; value: string | null }> = []
  const item = (id: string, metadata: Record<string, string>, price: Record<string, unknown>) => ({ id, object: 'subscription_item', price: { id: `price_${id}`, object: 'price', currency: 'usd', product: { id: `prod_${id}`, object: 'product', metadata }, ...price } })
  const metered = (family: string, decimal: string) => item(family, { product_family: family }, { billing_scheme: 'per_unit', unit_amount: null, unit_amount_decimal: decimal, recurring: { interval: 'month', interval_count: 1, usage_type: 'metered' } })
  // Only the provider HTTP boundary is controlled. D1, the agreement operation,
  // Better Auth's subscription and linked-account readers and the outbox run.
  t.mock.method(globalThis, 'fetch', async (input, init) => {
   const url = new URL(input instanceof Request ? input.url : String(input))
   if (url.origin === 'https://api.stripe.com') {
    if (url.pathname === '/v1/billing/meter_events') {
     assert.equal(init?.method, 'POST')
     const body = new URLSearchParams(String(init?.body))
     assert.equal(body.get('event_name'), 'krabiclaw_ad_spend')
     assert.equal(body.get('payload[stripe_customer_id]'), 'cus_operating')
     ingests.push({ identifier: body.get('identifier'), value: body.get('payload[value]') })
     return deliveryUnavailable ? Response.json({ error: { type: 'api_error', message: 'Native ingestion unavailable at test boundary' } }, { status: 500, headers: { 'stripe-should-retry': 'false' } }) : Response.json({ object: 'billing.meter_event', identifier: body.get('identifier') })
    }
    assert.equal(init?.method, 'GET')
    if (url.pathname === '/v1/payment_methods/pm_default') return Response.json({ id: 'pm_default', object: 'payment_method', customer: 'cus_operating' })
    if (url.pathname === '/v1/subscriptions/sub_operating') return Response.json({ id: 'sub_operating', object: 'subscription', customer: 'cus_operating', livemode: false, default_payment_method: null, items: { object: 'list', data: [
     item('business', { plan_id: 'business' }, { billing_scheme: 'per_unit', unit_amount: 14900, recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } }),
     metered('captured_volume', '0.014'), metered('stripe_cost', '1'), ...(rate === null ? [] : [metered('ad_spend', rate)]),
    ] } })
    assert.equal(url.pathname, '/v1/customers/cus_operating')
    return Response.json({ id: 'cus_operating', object: 'customer', invoice_settings: { default_payment_method: defaultCard } })
   }
   if (url.origin === 'https://googleads.googleapis.com') {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer managed-ads-token')
    if (url.pathname === '/v25/customers/1234567890/googleAds:mutate') {
     const body = JSON.parse(String(init?.body)) as { mutateOperations: Array<{ campaignOperation?: { create?: { status: string }; update?: { status: string } }; campaignBudgetOperation?: { create: { amountMicros: string } } }> }
     const campaign = body.mutateOperations.find(operation => operation.campaignOperation)?.campaignOperation
     if (campaign?.create) {
      assert.equal(campaign.create.status, 'PAUSED')
      campaignMutations.push({ status: campaign.create.status, budget: body.mutateOperations[0]!.campaignBudgetOperation!.create.amountMicros })
      return Response.json({ mutateOperationResponses: [
       { campaignBudgetResult: { resourceName: 'customers/1234567890/campaignBudgets/888' } },
       { campaignResult: { resourceName: 'customers/1234567890/campaigns/222' } },
       { adGroupResult: { resourceName: 'customers/1234567890/adGroups/333' } },
       { adGroupCriterionResult: { resourceName: 'customers/1234567890/adGroupCriteria/444' } },
       { adGroupAdResult: { resourceName: 'customers/1234567890/adGroupAds/555' } },
      ] })
     }
     assert(campaign?.update)
     assert.equal(campaign.update.status, 'ENABLED')
     campaignMutations.push({ status: campaign.update.status, budget: null })
     return Response.json({ mutateOperationResponses: [{ campaignResult: { resourceName: 'customers/1234567890/campaigns/222' } }] })
    }
    googleReads++
    // The managed account, and the accounts a later free connection chooses from: 3333333333 is a manager account.
    assert.ok(['1234567890', '2222222222', '3333333333'].some(id => url.pathname === `/v25/customers/${id}/googleAds:search`), url.pathname)
    if (providerUnavailable) return Response.json({ error: 'Reporting unavailable at external boundary' }, { status: 503 })
    const query = JSON.parse(String(init?.body)).query as string
    // The mutation now reads the selected campaign before changing it, so
    // its capture records observed settings rather than caller guesses.
    if (query.includes('FROM campaign WHERE campaign.id = 222')) {
     const existing = campaignMutations.at(-1)
     return Response.json({ results: existing ? [{ campaign: { id: '222', name: 'Paused Search setup', status: existing.status, advertisingChannelType: 'SEARCH' }, campaignBudget: { id: '888', amountMicros: '1000000' } }] : [] })
    }
    if (query.includes('FROM ad_group')) return Response.json({ results: [] })
    if (query.includes('metrics.cost_micros')) {
     return Response.json({ results: query.includes("'2026-10-01'") ? [] : [{ customer: { currencyCode: 'USD' }, metrics: { costMicros: '12500000', clicks: '10', impressions: '100', conversions: 1 } }] })
    }
    return Response.json({ results: [{ customer: { currencyCode: currency, timeZone, descriptiveName: 'Managed ads fixture', manager: url.pathname.includes('3333333333') } }] })
   }
   throw new Error(`Unexpected provider request: ${url.origin}${url.pathname}`)
  })
  // A subscription without the ad-spend price, or with another rate, cannot bill the service.
  for (const wrong of [null, '0.2']) {
   rate = wrong
   await assert.rejects(agree, /Choose Business in Plan/u)
  }
  rate = '0.1'
  defaultCard = null
  await assert.rejects(agree, /Add a payment method and set it as default/u)
  defaultCard = 'pm_default'
  await assert.rejects(agree, /Connect a Google Ads account billed in USD/u)
  const token = await symmetricEncrypt({ key: env.BETTER_AUTH_SECRET, data: 'managed-ads-token' })
  await db.prepare("INSERT INTO account(id,accountId,providerId,userId,accessToken) VALUES('ads-linked','google-fixture','google','verified',?)").bind(token).run()
  await storeIntegration(db, ORG, 'google_ads', { account_id: 'ads-linked', target_id: '1234567890', target_name: 'Managed ads fixture' }, { revision: null })
  const client = new Client({ name: 'payments-managed-ads-proof', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } })
  const transport = new StreamableHTTPClientTransport(new URL('https://proof.example/api/mcp'), {
   requestInit: { headers: { cookie, host: 'proof.example', origin: 'https://proof.example' } },
   fetch: async (input, init) => {
    const response = await app.request(Object.assign(new Request(input, init), { context: {}, runtime: workerRuntime }))
    assert.equal(response.status, 200, await response.clone().text())
    return response
   },
  })
  try {
   await client.connect(transport)
   const { tools } = await client.listTools()
   assert.equal(tools.some(tool => tool.name === 'get_payments_usage'), false)
   assert.equal(tools.some(tool => tool.name === 'create_google_ads_search_campaign'), true)
   assert.equal(tools.some(tool => tool.name === 'update_google_ads_campaign'), true)
   const campaignInput = { organization_id: ORG, name: 'Paused Search setup', daily_budget_micros: 1000000, target_url: 'https://proof.example', keywords: [{ text: 'local classes' }], headlines: ['Local Classes', 'Find Your Class', 'Choose A Workshop'], descriptions: ['Find a workshop that fits your plans.', 'Explore classes near you.'], contains_eu_political_advertising: false }
   const refusal = await client.callTool({ name: 'create_google_ads_search_campaign', arguments: { ...campaignInput, status: 'ENABLED' } })
   assert.equal(refusal.isError, true)
   assert.equal(refusal.structuredContent, undefined)
   assert.match(String(refusal.content[0]!.text), /Invalid arguments for tool create_google_ads_search_campaign/u)
   assert.deepEqual(campaignMutations, [])
   const creation = await client.callTool({ name: 'create_google_ads_search_campaign', arguments: campaignInput })
   assert.notEqual(creation.isError, true, JSON.stringify(creation))
   assert.deepEqual(creation.structuredContent, { campaign_id: '222', status: 'PAUSED' })
   assert.deepEqual(campaignMutations, [{ status: 'PAUSED', budget: '1000000' }])
   const enabled = await client.callTool({ name: 'update_google_ads_campaign', arguments: { organization_id: ORG, campaign_id: '222', status: 'ENABLED' } })
   assert.notEqual(enabled.isError, true, JSON.stringify(enabled))
   assert.equal(enabled.structuredContent?.status, 'ENABLED')
   assert.deepEqual(campaignMutations, [{ status: 'PAUSED', budget: '1000000' }, { status: 'ENABLED', budget: null }])
  } finally {
   await client.close()
   await Promise.all(background)
  }
  currency = 'THB'
  await assert.rejects(agree, /requires a Google Ads account billed in USD/u)
  currency = 'USD'
  for (const invalid of [undefined, 'Not/A-Timezone']) {
   timeZone = invalid
   await assert.rejects(agree, /valid reporting timezone/u)
   await noConsent()
  }
  timeZone = 'America/New_York'
  providerUnavailable = true
  await assert.rejects(agree, /Google Ads API error \(503\)/u)
  providerUnavailable = false
  await noConsent()
  const accepted = await call('/api/dashboard/services?org=payments', 'POST', { service: 'managed_ads', action: 'agree' })
  const acceptedBody = await accepted.json() as { success: boolean; services: Awaited<ReturnType<typeof listServices>> }
  assert.equal(accepted.status, 200, JSON.stringify(acceptedBody))
  assert.equal(acceptedBody.success, true)
  const agreement = acceptedBody.services.managed_ads!
  assert.deepEqual(await db.prepare('SELECT id,service,terms_version,agreed_by_user_id,agreed_at,ended_by_user_id,ended_at FROM organization_services WHERE organization_id=?').bind(ORG).first(), { id: agreement.id, service: 'managed_ads', terms_version: SERVICE_TERMS_VERSION.managed_ads, agreed_by_user_id: 'verified', agreed_at: '2026-10-01T12:00:00.000Z', ended_by_user_id: null, ended_at: null })
  assert.equal((await listServices(db, ORG)).managed_ads?.id, agreement.id)
  await assert.rejects(agree, /This service is already on/u)
  await assert.rejects(() => releaseIntegration(env, ORG, 'google-ads'), /Turn off managed ads in Plan/u)
  await assert.rejects(() => selectGoogleAdsCustomer(env, ORG, 'ads-linked', '2222222222', 'Replacement'), /Turn off managed ads in Plan/u)
  assert.equal((await readIntegration(db, ORG, 'google_ads'))?.target_id, '1234567890')
  assert.deepEqual(await unrecordedAdSpendDays(db, env, ORG, new Date('2026-10-01T12:00:00.000Z')), [])
  assert.deepEqual(await unrecordedAdSpendDays(db, env, ORG, new Date('2026-10-02T12:00:00.000Z')), ['2026-10-01'])
  t.mock.timers.setTime(new Date('2026-10-03T10:00:00.000Z').getTime())
  providerUnavailable = true
  const ended = await call('/api/dashboard/services?org=payments', 'POST', { service: 'managed_ads', action: 'end' })
  assert.equal(ended.status, 200, await ended.text())
  assert.equal((await listServices(db, ORG)).managed_ads, null)
  const statusRead = await call('/api/dashboard/services?org=payments')
  assert.equal(statusRead.status, 200)
  assert.deepEqual(await statusRead.json(), { success: true, services: { managed_ads: null, strategy: null }, offers: SERVICES })
  assert.deepEqual(await db.prepare('SELECT ended_at,ended_by_user_id FROM organization_services WHERE id=?').bind(agreement.id).first(), { ended_at: '2026-10-03T10:00:00.000Z', ended_by_user_id: 'verified' })
  await assert.rejects(() => endService(db, ORG, 'managed_ads', 'other'), /This service is not on/u)
  await assert.rejects(() => releaseIntegration(env, ORG, 'google-ads'), /Google Ads API error \(503\)/u)
  await assert.rejects(() => selectGoogleAdsCustomer(env, ORG, 'ads-linked', '2222222222', 'Replacement'), /Google Ads API error \(503\)/u)
  assert.equal((await readIntegration(db, ORG, 'google_ads'))?.account_id, 'ads-linked')
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM account WHERE id='ads-linked'").first('n'), 1)
  const runDaily = () => adSpendDailyTask.run({ name: 'marketing:ad-spend-daily', payload: {}, context: { cloudflare: { env } } })
  await assert.rejects(runDaily, /Google Ads API error \(503\)/u)
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM payment_usage_events WHERE kind='ad_spend'").first('n'), 0)
  providerUnavailable = false
  assert.deepEqual(await unrecordedAdSpendDays(db, env, ORG), ['2026-10-01', '2026-10-02'])
  await assert.rejects(() => releaseIntegration(env, ORG, 'google-ads'), /Keep Google Ads connected until your prior managed spend has been counted/u)
  deliveryUnavailable = true
  await assert.rejects(runDaily, /Native ingestion unavailable at test boundary/u)
  assert.deepEqual(await unrecordedAdSpendDays(db, env, ORG, new Date('2026-10-02T12:00:00.000Z')), [])
  assert.deepEqual(await unrecordedAdSpendDays(db, env, ORG), ['2026-10-02'])
  // All mature amounts are captured, but yesterday is still promised and not
  // mature. Neither disconnection nor replacement may lose that identity.
  await assert.rejects(() => releaseIntegration(env, ORG, 'google-ads'), /Keep Google Ads connected until your prior managed spend has been counted/u)
  await assert.rejects(() => selectGoogleAdsCustomer(env, ORG, 'ads-linked', '2222222222', 'Replacement'), /Keep Google Ads connected until your prior managed spend has been counted/u)
  // The next day recovers the failed older day as well as the newly mature one.
  t.mock.timers.setTime(new Date('2026-10-04T10:00:00.000Z').getTime())
  providerUnavailable = false
  deliveryUnavailable = true
  await Promise.all([assert.rejects(runDaily, /Native ingestion unavailable at test boundary/u), assert.rejects(runDaily, /Native ingestion unavailable at test boundary/u)])
  const captured = (await db.prepare("SELECT id,source_id,amount,provider_occurred_at,delivery_at FROM payment_usage_events WHERE kind='ad_spend' ORDER BY source_id").all()).results
  assert.deepEqual(captured.map(({ source_id, amount, provider_occurred_at, delivery_at }) => ({ source_id, amount, provider_occurred_at, delivery_at })), [
   { source_id: 'google_ads:1234567890:2026-10-01', amount: 0, provider_occurred_at: '2026-10-02T03:59:59.999Z', delivery_at: null },
   { source_id: 'google_ads:1234567890:2026-10-02', amount: 1250, provider_occurred_at: '2026-10-03T03:59:59.999Z', delivery_at: null },
  ])
  assert.deepEqual(await releaseIntegration(env, ORG, 'google-ads'), { product: 'google-ads', released: true })
  // A manager account has no campaigns or results of its own, so it is not a connection.
  await assert.rejects(selectGoogleAdsCustomer(env, ORG, 'ads-linked', '3333333333', 'Manager account'), { status: 422, message: 'That is a Google Ads manager account. Choose one of the accounts it manages.' })
  // A new free connection cannot make the previous agreement bill its account.
  await selectGoogleAdsCustomer(env, ORG, 'ads-linked', '2222222222', 'New free connection')
  const readsBeforeDelivery = googleReads
  providerUnavailable = true
  deliveryUnavailable = false
  assert.deepEqual((await runDaily()).result, { billed: 1, skipped: 0 })
  assert.equal(googleReads, readsBeforeDelivery, 'queued spend no longer needs the old Google identity')
  // Every delivery sends every pending day: the first failure, both concurrent failures, then the one Stripe took.
  const zeroSpend = ingests.filter(row => row.value === '0'), spend = ingests.filter(row => row.value === '1250')
  assert.deepEqual([ingests.length, zeroSpend.length, spend.length], [7, 4, 3])
  assert.deepEqual(ingests[0], zeroSpend.at(-1), 'a failed zero-spend event retries under the same identifier')
  assert.equal(new Set(zeroSpend.map(row => row.identifier)).size, 1, 'failed and concurrent deliveries preserve the meter event identifier')
  assert.equal(new Set(spend.map(row => row.identifier)).size, 1, 'failed and concurrent deliveries preserve the meter event identifier')
  assert.deepEqual(ingests.slice(-2).map(row => row.value), ['0', '1250'])
  const delivered = (await db.prepare("SELECT id,delivery_at FROM payment_usage_events WHERE kind='ad_spend' ORDER BY source_id").all()).results
  assert.deepEqual(delivered.map(row => row.id), captured.map(row => row.id))
  assert.ok(delivered.every(row => row.delivery_at === '2026-10-04T10:00:00.000Z'))
  assert.deepEqual((await runDaily()).result, { billed: 0, skipped: 1 })
  assert.equal(ingests.length, 7)
 } finally { await runtime.dispose() }
})

test('managed spend follows actual account-local closed days and reporting delay across DST', { timeout: 120_000 }, async t => {
 t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-02T10:00:00.000Z') })
 const { db, runtime } = await boot()
 try {
  const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-managed-calendar-proof-secret-long-enough', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_managed_calendar_boundary' }
  const token = await symmetricEncrypt({ key: env.BETTER_AUTH_SECRET, data: 'managed-calendar-token' })
  await db.prepare("INSERT INTO account(id,accountId,providerId,userId,accessToken) VALUES('historical-account','google-calendar-fixture','google','verified',?)").bind(token).run()
  await storeIntegration(db, ORG, 'google_ads', { account_id: 'historical-account', target_id: '1234567890', target_name: 'Historical connection' }, { revision: null })
  await db.prepare("INSERT INTO organization_services(id,organization_id,service,terms_version,agreed_by_user_id,agreed_at,ended_at) VALUES('historical',?,'managed_ads','historical','verified','2026-10-01T12:00:00.000Z','2026-10-04T10:00:00.000Z')").bind(ORG).run()
  let timeZone: string | undefined = 'America/New_York'
  t.mock.method(globalThis, 'fetch', async (input, init) => {
   const url = new URL(input instanceof Request ? input.url : String(input))
   assert.equal(url.origin, 'https://googleads.googleapis.com')
   assert.equal(url.pathname, '/v25/customers/1234567890/googleAds:search')
   assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer managed-calendar-token')
   const query = JSON.parse(String(init?.body)).query as string
   return Response.json({ results: query.includes('metrics.cost_micros')
    ? [{ customer: { currencyCode: 'USD' }, metrics: { costMicros: '1000000' } }]
    : [{ customer: { currencyCode: 'USD', timeZone } }] })
  })
  assert.deepEqual(await unrecordedAdSpendDays(db, env, ORG, new Date('2026-10-06T12:00:00.000Z')), ['2026-10-02', '2026-10-03'])
  assert.deepEqual(await unrecordedAdSpendDays(db, env, ORG, new Date('2026-10-02T12:00:00.000Z')), [])
  await assert.rejects(() => unrecordedAdSpendDays(db, env, ORG, new Date(NaN)), /Invalid timestamp instant/u)
  await assert.rejects(() => recordAdSpend(db, env, ORG, '2026-02-30'), /valid Gregorian/u)

  // UTC midnight is still the previous reporting day in New York. Consent and
  // connection instants between it and local midnight belong to that same day.
  await db.prepare("UPDATE organization_integrations SET created_at='2026-10-01T10:00:00.000Z' WHERE organization_id=?").bind(ORG).run()
  await db.prepare("UPDATE organization_services SET agreed_at='2026-10-01T12:00:00.000Z',ended_at='2026-10-02T02:00:00.000Z' WHERE id='historical'").run()
  assert.deepEqual(await unrecordedAdSpendDays(db, env, ORG, new Date('2026-10-03T12:00:00.000Z')), [])
  await db.prepare("UPDATE organization_services SET agreed_at='2026-10-02T01:00:00.000Z',ended_at='2026-10-02T04:00:00.000Z' WHERE id='historical'").run()
  await db.prepare("UPDATE organization_integrations SET created_at='2026-10-02T01:00:00.000Z' WHERE organization_id=?").bind(ORG).run()
  assert.deepEqual(await unrecordedAdSpendDays(db, env, ORG, new Date('2026-10-03T12:00:00.000Z')), ['2026-10-01'])

  timeZone = 'America/Chicago'
  for (const day of [
   { date: '2026-03-08', start: '2026-03-08T06:00:00.000Z', end: '2026-03-09T05:00:00.000Z', beforeMature: '2026-03-10T04:30:00.000Z', mature: '2026-03-10T05:00:00.000Z', occurred: '2026-03-09T04:59:59.999Z' },
   { date: '2026-11-01', start: '2026-11-01T05:00:00.000Z', end: '2026-11-02T06:00:00.000Z', beforeMature: '2026-11-03T05:30:00.000Z', mature: '2026-11-03T06:00:00.000Z', occurred: '2026-11-02T05:59:59.999Z' },
  ]) {
   await db.prepare('UPDATE organization_integrations SET created_at=? WHERE organization_id=?').bind(day.start, ORG).run()
   await db.prepare("UPDATE organization_services SET agreed_at=?,ended_at=? WHERE id='historical'").bind(day.start, day.end).run()
   assert.deepEqual(await unrecordedAdSpendDays(db, env, ORG, new Date(day.beforeMature), 2), [])
   assert.deepEqual(await unrecordedAdSpendDays(db, env, ORG, new Date(day.mature), 2), [day.date])
   await db.prepare("UPDATE organization_services SET ended_at=? WHERE id='historical'").bind(day.occurred).run()
   assert.deepEqual(await unrecordedAdSpendDays(db, env, ORG, new Date(day.mature), 2), [], 'ending at the final millisecond excludes that day')
   await db.prepare("UPDATE organization_services SET ended_at=? WHERE id='historical'").bind(day.end).run()
   assert.deepEqual(await recordAdSpend(db, env, ORG, day.date), { amount: 100 })
   assert.deepEqual(await db.prepare('SELECT amount,provider_occurred_at,delivery_at FROM payment_usage_events WHERE source_id=?').bind(`google_ads:1234567890:${day.date}`).first(), { amount: 100, provider_occurred_at: day.occurred, delivery_at: null })
   assert.deepEqual(await unrecordedAdSpendDays(db, env, ORG, new Date(day.mature), 2), [])
  }
  for (const invalid of [undefined, 'Not/A-Timezone']) {
   timeZone = invalid
   await assert.rejects(() => unrecordedAdSpendDays(db, env, ORG, new Date('2026-11-03T12:00:00.000Z')), /valid reporting timezone/u)
   await assert.rejects(() => recordAdSpend(db, env, ORG, '2026-11-01'), /valid reporting timezone/u)
   assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM payment_usage_events WHERE kind='ad_spend'").first('n'), 2)
  }
 } finally { await runtime.dispose() }
})

test('native Google unlink and full-user deletion require canonical Ads disconnect before credentials are removed', { timeout: 120_000 }, async t => {
 t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-01T12:00:00.000Z') })
 const { db, runtime } = await boot()
 try {
  const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-native-unlink-proof-secret-long-enough', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_native_unlink_boundary' }
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
  const env = resendEnv(await stripeEnv(runtime, bootEnv))
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
   ['Payout failed', 'admin@krabiclaw-proof.com'], ['Payout failed', 'owner@krabiclaw-proof.com'],
   ['Payout paid', 'admin@krabiclaw-proof.com'], ['Payout paid', 'owner@krabiclaw-proof.com'],
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
   { provider: 'resend', status: 'sent', subject: 'Payout failed', recipient: 'admin@krabiclaw-proof.com' },
   { provider: 'resend', status: 'sent', subject: 'Payout failed', recipient: 'owner@krabiclaw-proof.com' },
   { provider: 'resend', status: 'sent', subject: 'Payout paid', recipient: 'admin@krabiclaw-proof.com' },
   { provider: 'resend', status: 'sent', subject: 'Payout paid', recipient: 'owner@krabiclaw-proof.com' },
  ])
 } finally { await runtime.dispose() }
})

test('Better Auth Stripe tells the business its new plan, its change of plan and a plan that will not renew, once each', { timeout: 120_000 }, async t => {
 const { db, runtime, env: bootEnv } = await boot()
 try {
  const secret = 'whsec_plan_proof'
  const env = { ...resendEnv(await stripeEnv(runtime, bootEnv)), STRIPE_WEBHOOK_SECRET: secret } as CloudflareEnv
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
  t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
   const url = new URL(request instanceof Request ? request.url : String(request))
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
  const deliver = async (event: Record<string, unknown>) => {
   const payload = JSON.stringify({ object: 'event', api_version: '2025-10-29.clover', created: 1_790_000_000, livemode: false, ...event })
   const response = await auth.handler(new Request('https://proof.example/api/auth/stripe/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': await signer.webhooks.generateTestHeaderStringAsync({ payload, secret }) }, body: payload,
   }))
   assert.equal(response.status, 200)
  }
  const subjects = () => sentMail(emails).map(sent => [sent.subject, String(sent.to)]).sort()

  // Checkout completes with a free trial.
  await deliver({ id: 'evt_checkout', type: 'checkout.session.completed', data: { object: { id: 'cs_plan', object: 'checkout.session', mode: 'subscription', subscription: 'sub_plan', client_reference_id: ORG, metadata: { subscriptionId: 'sub-row', referenceId: ORG } } } })
  assert.deepEqual(subjects(), [['Your new plan: Growth', 'admin@krabiclaw-proof.com'], ['Your new plan: Growth', 'owner@krabiclaw-proof.com']])
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
  assert.deepEqual(subjects().slice(2), [['Your plan changed to Business', 'admin@krabiclaw-proof.com'], ['Your plan changed to Business', 'owner@krabiclaw-proof.com']])
  assert.match(sentMail(emails)[2]!.html, /Payments moved from Growth to Business\./u)

  // The owner cancels at the end of the period; Stripe redelivers that event too.
  const ending = { id: 'evt_ending', type: 'customer.subscription.updated', data: { object: subscription('business', { cancel_at_period_end: true }), previous_attributes: { cancel_at_period_end: false } } }
  await deliver(ending)
  await deliver(ending)
  assert.equal(emails.length, 6)
  const notRenewing = sentMail(emails).slice(4)
  assert.deepEqual(notRenewing.map(sent => [sent.subject, String(sent.to)]).sort(), [['Your Business plan will not renew', 'admin@krabiclaw-proof.com'], ['Your Business plan will not renew', 'owner@krabiclaw-proof.com']])
  assert.match(notRenewing[0]!.html, /Business stays on until Oct 21, 2026\. After that, Payments is on Basic\./u)

  // Read back apart from the sends: Better Auth's subscription, and each email Resend accepted.
  assert.deepEqual(await db.prepare("SELECT plan, status, cancelAtPeriodEnd FROM subscription WHERE id='sub-row'").first(), { plan: 'business', status: 'active', cancelAtPeriodEnd: 1 })
  assert.deepEqual((await db.prepare("SELECT json_extract(email_json, '$.message.subject') subject, count(*) n FROM guest_thread_deliveries WHERE channel='email' AND provider='resend' AND status='sent' GROUP BY subject ORDER BY subject").all()).results, [
   { subject: 'Your Business plan will not renew', n: 2 }, { subject: 'Your new plan: Growth', n: 2 }, { subject: 'Your plan changed to Business', n: 2 },
  ])
 } finally { await runtime.dispose() }
})
