import {createCanonicalNotification} from '../../server/utils/notification-center.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import Stripe from 'stripe'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { HTTPError } from 'nitro'
import { Miniflare } from 'miniflare'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import * as schema from '../../server/db/schema.ts'
import { claimSessionCapacity } from '../../server/utils/availability.ts'
import { ingestStripeFeeReport, stripeFeeMinor } from '../../server/domain/payments/costs.ts'
import { buyerActivities, buyerPaymentActivityPath, claimCheckoutReturn, tokenHash } from '../../server/domain/payments/buyer.ts'
import { loadBuyerBookingDetails } from '../../server/utils/dashboard-booking-details.ts'
import { cancelBookingRequest, requestInsertQueries, threadPayloadForGuest } from '../../server/domain/requests.ts'
import { claimReservation, listReservationSlots, upsertLocationReservationConfig } from '../../server/utils/reservations.ts'
import { appendEntry } from '../../server/domain/guest-threads/entries.ts'
import { getGuestThreadDetail } from '../../server/domain/guest-threads/detail.ts'
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
import bookingReceiptRoute from '../../server/api/public/booking-requests/[requestId].get.ts'
import { createReplayableReservationCancelToken, hashReservationCancelToken } from '../../server/utils/reservation-cancel-token.ts'
import adSpendDailyTask from '../../server/tasks/marketing-ad-spend-daily.ts'
import { recordAdSpend, unrecordedAdSpendDays } from '../../server/domain/payments/ad-spend.ts'
import { selectGoogleAdsCustomer } from '../../server/utils/google-ads.ts'
import { getStripe } from '../../server/utils/billing.ts'
import { executeGuestThreadOperation } from '../../server/domain/guest-threads/operations.ts'
import { approveRefundAuthorization, executeRefund, requirePayment } from '../../server/domain/payments/index.ts'
import { reviewPayment, confirmPayment, requireOpenAttempt } from '../../server/domain/payments/intent.ts'
import { reconcilePaymentIntent, processPaymentEvent } from '../../server/domain/payments/events.ts'
import { canRetryGuestReservationRefund } from '../../server/domain/payments/visit-refund.ts'
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
 await db.prepare(`INSERT INTO organization(id,name,slug,subdomain,settings_json,theme_id,default_currency,status,onboarding_status,url_structure,vertical,updated_at, timezone) VALUES(?,'Payments','payments','payments','{}','theme','USD','active','complete','flat','experience',?, 'America/New_York')`).bind(ORG,NOW).run()
 await db.prepare("INSERT INTO organization_locales(id,organization_id,locale,is_source,status) VALUES('payments-en',?,'en',1,'published')").bind(ORG).run()
 for(const id of ['guest','verified','other'])await db.prepare("INSERT INTO user(id,name,email,emailVerified,isAnonymous) VALUES(?,?,?,1,?)").bind(id,id,`${id}@example.com`,Number(id==='guest')).run()
 await db.prepare("INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by) VALUES('service','product',?,'Consultation','consultation','guest','guest')").bind(ORG).run()
 await db.prepare("INSERT INTO product_variants(id,organization_id,product_id,name,created_by,updated_by) VALUES('variant',?,'product','Hour','guest','guest')").bind(ORG).run()
 // Held online by its provider, in the provider's own hours.
 await db.prepare("INSERT INTO user(id,name,email,emailVerified) VALUES('host','Host','host@example.com',1)").run()
 await db.prepare("INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES('host-member',?,'host','member',1)").bind(ORG).run()
 await db.prepare(`INSERT INTO member_scheduling(member_id,organization_id,timezone,weekly_json,time_off_json,windows_json,windows_until,calendar_revision,updated_at,updated_by) VALUES('host-member',?,'America/New_York','[]','[]','[{"start":"2099-10-01T00:00:00.000Z","end":"2099-10-02T00:00:00.000Z"}]','2100-01-01T00:00:00.000Z','r1',?,'host')`).bind(ORG,NOW).run()
 await db.prepare("INSERT INTO product_booking_configs(product_id,organization_id,duration_minutes,default_capacity,confirmation_mode,held_online,scheduling_mode,assigned_member_id,online_payment_required,created_by,updated_by) VALUES('product',?,60,1,'review',1,'provider','host-member',1,'guest','guest')").bind(ORG).run()
 await db.prepare("INSERT INTO product_sessions(id,organization_id,product_id,assigned_member_id,timezone,starts_at,ends_at,capacity,status,created_by,updated_by) VALUES('session',?,'product','host-member','America/New_York','2099-10-01T13:00:00.000Z','2099-10-01T14:00:00.000Z',1,'scheduled','guest','guest')").bind(ORG).run()
 return {db,runtime}
 }catch(error){await runtime.dispose();throw error}
}
async function payable(db:D1Database,id:string,expires='2099-09-30T00:00:00.000Z'){
 await db.prepare("INSERT INTO payments(id,organization_id,buyer_user_id,stripe_account_id,livemode,subject_type,currency,amount,price_snapshot_json,created_at,updated_at) VALUES(?,?,'guest','acct_seller',0,'booking','USD',10000,?,?,?)").bind(id,ORG,JSON.stringify({title:'Consultation',price:{unit_amount:10000,currency:'USD'},quantity:1}),NOW,NOW).run()
 await db.prepare("INSERT INTO payment_attempts(id,payment_id,idempotency_key,stripe_payment_intent_id,return_token,status,expires_at,created_at,updated_at) VALUES(?,?,?,?,'test-return-proof','open',?,?,?)").bind(`a:${id}`,id,`checkout:${id}`,`pi_${id}`,expires,NOW,NOW).run()
 await db.prepare("INSERT INTO payment_checkout_holds(id,organization_id,product_id,variant_id,price_id,session_id,buyer_user_id,payment_id,quantity,amount,currency,starts_at,ends_at,status,expires_at,created_at,assigned_member_id) VALUES(?,?,'product','variant','price','session','guest',?,1,10000,'USD','2099-10-01T13:00:00.000Z','2099-10-01T14:00:00.000Z','active',?,?,'host-member')").bind(`h:${id}`,ORG,id,expires,NOW).run()
}

async function paidReservation(db: D1Database, env: CloudflareEnv, cutoff: number | null) {
 const startsAt = '2099-10-01T13:00:00.000Z', endsAt = '2099-10-01T15:00:00.000Z'
 await db.prepare("INSERT INTO business_locations(id,organization_id,slug,title,status,timezone,opening_hours) VALUES('dining',?,'dining','Dining','active','UTC',?)").bind(ORG, JSON.stringify({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] })).run()
 // A later change to the business's current policy cannot change terms already accepted at Checkout.
 await upsertLocationReservationConfig(db, { organizationId: ORG, locationId: 'dining', patch: { slot_capacity: 1, free_cancellation_until_minutes: 2880 }, actorId: 'verified', env })
 const opening = { id: 'deposit-request', kind: 'reservation' as const, organization_id: ORG, location_id: 'dining', user_id: 'verified', review_id: null, conversation_state: 'needs_attention' as const, resolved_at: null, payload: { ...threadPayloadForGuest({ name: 'Verified', email: 'verified@example.com', phone: '+12025550123' }), cancellation: { token_hash: 'deposit-token-hash', expires_at: '2100-01-01T00:00:00.000Z', used_at: null } }, created_at: NOW, updated_at: NOW }
 await db.batch(requestInsertQueries(opening).map(write => db.prepare(write.query).bind(...write.params)))
 const terms = { policy_type: 'reservation', free_cancellation_until_minutes: cutoff, reschedule_allowed: true, reschedule_cutoff_minutes: null, deposit_required: true, deposit_amount: 10000, deposit_currency: 'USD', deposit_tax_behavior: 'exclusive' }
 await db.prepare("INSERT INTO payments(id,organization_id,buyer_user_id,stripe_account_id,livemode,subject_type,location_id,currency,amount,tax_amount,captured_amount,state,stripe_payment_intent_id,stripe_charge_id,price_snapshot_json,created_at,updated_at) VALUES('deposit',?,'verified','acct_seller',0,'reservation','dining','USD',10000,500,10500,'captured','pi_deposit','ch_deposit',?,?,?)").bind(ORG, JSON.stringify({ title: 'Dining reservation deposit', reservation: terms }), NOW, NOW).run()
 await db.prepare("INSERT INTO payment_checkout_holds(id,organization_id,location_id,timezone,buyer_user_id,request_id,payment_id,quantity,amount,currency,starts_at,ends_at,status,expires_at,created_at) VALUES('deposit-hold',?,'dining','UTC','verified','deposit-request','deposit',1,10000,'USD',?,?,'active','2100-01-01T00:00:00.000Z',?)").bind(ORG, startsAt, endsAt, NOW).run()
 await claimReservation(db, { organizationId: ORG, locationId: 'dining', reservationId: 'deposit-reservation', requestId: opening.id, userId: 'verified', timezone: 'UTC', startsAt, endsAt, date: '2099-10-01', timeSlot: '13:00', partySize: 1, capturedPaymentId: 'deposit', capturedAt: NOW })
 await db.prepare("UPDATE payments SET subject_id='deposit-reservation' WHERE id='deposit'").run()
 await db.prepare("UPDATE payment_checkout_holds SET status='converted',converted_reservation_id='deposit-reservation' WHERE id='deposit-hold'").run()
 return { id: opening.id, organizationId: ORG, kind: 'reservation' as const, env }
}

test('guest table cancellation uses its accepted deadline and Stripe full remaining refund for both buyer and token credentials', { timeout: 120_000 }, async t => {
 for (const credentials of [{ buyerUserId: 'verified' }, { tokenHash: 'deposit-token-hash' }]) {
  for (const policy of [{ cutoff: null, now: '2099-10-01T12:59:00.000Z', refundable: true }, { cutoff: 120, now: '2099-10-01T11:00:00.000Z', refundable: true }, { cutoff: 120, now: '2099-10-01T11:00:00.001Z', refundable: false }]) {
   const { db, runtime } = await boot()
   try {
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-proof-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only', STRIPE_SECRET_KEY: 'sk_test_local_boundary' }
    const input = { ...await paidReservation(db, env, policy.cutoff), ...credentials, now: policy.now }
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
      assert.equal(new Headers(init.headers).get('idempotency-key'), 'krabiclaw-refund:deposit:guest-cancelled-reservation:deposit-reservation')
      return Response.json({ id: 're_deposit', object: 'refund', amount: 10500, currency: 'usd', status: 'succeeded', payment_intent: 'pi_deposit', reason: 'requested_by_customer', metadata: { krabiclaw_refund_id: params.get('metadata[krabiclaw_refund_id]') } })
     }
     assert.equal(init?.method, 'GET')
     assert.equal(url.pathname, '/v1/charges/ch_deposit')
     return Response.json({ id: 'ch_deposit', object: 'charge', livemode: false, amount: 10500, amount_refunded: 10500, currency: 'usd', payment_intent: 'pi_deposit', billing_details: { email: 'verified@example.com' } })
    })
    try {
     const before = await listReservationSlots(db, { organizationId: ORG, locationId: 'dining', date: '2099-10-01' })
     assert.equal(before.slots.find(slot => slot.time_slot === '13:00')?.remaining, 0)
     assert.equal((await cancelBookingRequest(db, input))?.changed, true)
     assert.deepEqual(await db.prepare("SELECT status,cancellation_reason FROM reservations WHERE id='deposit-reservation'").first(), { status: 'cancelled', cancellation_reason: 'guest_cancelled' })
     assert.equal(await db.prepare("SELECT json_extract(payload_json,'$.cancellation.used_at') used_at FROM requests WHERE id='deposit-request'").first('used_at'), policy.now)
     assert.deepEqual(await db.prepare("SELECT state,refunded_amount FROM payments WHERE id='deposit'").first(), { state: policy.refundable ? 'refunded' : 'captured', refunded_amount: policy.refundable ? 10500 : 0 })
     assert.deepEqual((await db.prepare("SELECT amount,status,created_by FROM payment_refunds WHERE payment_id='deposit'").all()).results, policy.refundable ? [{ amount: 10500, status: 'succeeded', created_by: 'buyerUserId' in credentials ? 'verified' : null }] : [])
     assert.equal(creations, Number(policy.refundable))
     const after = await listReservationSlots(db, { organizationId: ORG, locationId: 'dining', date: '2099-10-01' })
     assert.equal(after.slots.find(slot => slot.time_slot === '13:00')?.remaining, 1)
    } finally { fetchMock.mock.restore() }
   } finally { await runtime.dispose() }
  }
 }
})

test('authorized guest cancellation replay recovers an interrupted Stripe refund without another cancellation or refund intent', { timeout: 120_000 }, async t => {
 for (const credentials of [{ buyerUserId: 'verified' }, { tokenHash: 'deposit-token-hash' }]) {
  const { db, runtime } = await boot()
  try {
   const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-proof-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only', STRIPE_SECRET_KEY: 'sk_test_local_boundary' }
   const scope = { ...await paidReservation(db, env, 120), now: '2099-10-01T11:00:00.000Z' }
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
    assert.equal(url.pathname, '/v1/charges/ch_deposit')
    return Response.json({ id: 'ch_deposit', object: 'charge', livemode: false, amount: 10500, amount_refunded: 10500, currency: 'usd', payment_intent: 'pi_deposit', billing_details: { email: 'verified@example.com' } })
   })
   try {
    const protectedTables = ['reservations', 'requests', 'activity_entries', 'payments', 'payment_refunds']
    const before = await Promise.all(protectedTables.map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results))
    for (const wrong of [{ buyerUserId: 'other' }, { tokenHash: 'wrong-token' }, { tokenHash: 'deposit-token-hash', now: '2100-01-01T00:00:00.000Z' }]) assert.equal(await cancelBookingRequest(db, { ...scope, ...wrong }), null)
    assert.deepEqual(await Promise.all(protectedTables.map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results)), before)
    assert.equal(creations, 0)
    await assert.rejects(() => cancelBookingRequest(db, input), /Native response interrupted/u)
    assert.equal(await db.prepare("SELECT status FROM reservations WHERE id='deposit-reservation'").first('status'), 'cancelled')
    const intent = await db.prepare("SELECT id,idempotency_key,amount,status,error,attempted_at FROM payment_refunds WHERE payment_id='deposit'").first<{ id: string; idempotency_key: string; amount: number | null; status: string; error: string; attempted_at: string }>()
    assert(intent)
    assert.equal(intent.amount, null)
    assert.equal(intent.status, 'creating')
    assert.match(intent.error, /Native response interrupted/u)
    assert.ok(intent.attempted_at)
    const cancellation = await db.prepare("SELECT * FROM activity_entries WHERE request_id='deposit-request' AND event_name='reservation.cancel'").first()
    assert(cancellation)
    const interruptedDetails = await loadBuyerBookingDetails(db, 'verified', 'reservation', scope.id)
    assert.equal(interruptedDetails.status, 'cancelled')
    assert.equal(interruptedDetails.guestCanCancel, false)
    assert.equal(interruptedDetails.guestCanRetryCancellation, true)
    await assert.rejects(() => loadBuyerBookingDetails(db, 'other', 'reservation', scope.id), error => error instanceof HTTPError && error.statusCode === 404)
    const tokenScope = { organizationId: ORG, reservationId: 'deposit-reservation', requestId: scope.id }
    assert.equal(await canRetryGuestReservationRefund(db, tokenScope), true)
    for (const foreign of [{ organizationId: 'another-org' }, { reservationId: 'another-reservation' }, { requestId: 'another-request' }, { buyerUserId: 'other' }]) assert.equal(await canRetryGuestReservationRefund(db, { ...tokenScope, ...foreign }), false)
    assert.equal(await cancelBookingRequest(db, { ...scope, buyerUserId: 'other' }), null)
    assert.equal(await cancelBookingRequest(db, { ...scope, tokenHash: 'wrong-token' }), null)
    assert.equal(await cancelBookingRequest(db, { ...scope, tokenHash: 'deposit-token-hash', now: '2100-01-01T00:00:00.000Z' }), null)
    assert.equal(creations, 1)
    // Eligibility was fixed when cancellation committed; recovery still returns the deposit after the deadline.
    const retry = { ...input, now: '2099-10-01T12:00:00.000Z' }
    assert.equal((await cancelBookingRequest(db, retry))?.changed, false)
    assert.equal((await cancelBookingRequest(db, retry))?.changed, false)
    assert.equal(creations, 2)
    assert.deepEqual([...keys], ['krabiclaw-refund:deposit:guest-cancelled-reservation:deposit-reservation'])
    assert.deepEqual((await db.prepare("SELECT id,idempotency_key,stripe_refund_id,amount,status,error FROM payment_refunds WHERE payment_id='deposit'").all()).results, [{ id: intent.id, idempotency_key: intent.idempotency_key, stripe_refund_id: 're_recovered', amount: 10500, status: 'succeeded', error: null }])
    assert.deepEqual(await db.prepare("SELECT state,refunded_amount FROM payments WHERE id='deposit'").first(), { state: 'refunded', refunded_amount: 10500 })
    const refundedDetails = await loadBuyerBookingDetails(db, 'verified', 'reservation', scope.id)
    assert.equal(refundedDetails.guestCanRetryCancellation, false)
    assert.equal(await canRetryGuestReservationRefund(db, tokenScope), false)
    assert.deepEqual(refundedDetails.payments?.flatMap(payment => payment.refunds.map(refund => ({ amount: refund.amount, status: refund.status }))), [{ amount: 10500, status: 'succeeded' }])
    assert.deepEqual((await db.prepare("SELECT * FROM activity_entries WHERE request_id='deposit-request' AND event_name='reservation.cancel'").all()).results, [cancellation])
    assert.equal(await db.prepare("SELECT COUNT(*) n FROM activity_entries WHERE request_id='deposit-request' AND event_name='payment.refund_succeeded'").first('n'), 1)
    assert.equal((await listReservationSlots(db, { organizationId: ORG, locationId: 'dining', date: '2099-10-01' })).slots.find(slot => slot.time_slot === '13:00')?.remaining, 1)
   } finally { fetchMock.mock.restore() }
  } finally { await runtime.dispose() }
 }
})
test('an active payment hold consumes the canonical session capacity until release', { timeout: 120_000 }, async () => {
 const { db, runtime } = await boot()
 try {
  await payable(db, 'held')
  await assert.rejects(() => claimSessionCapacity(db, { organizationId: ORG, productId: 'product', sessionId: 'session', productVariantId: 'variant', partySize: 1 }), /no longer has room/u)
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM bookings').first('n'), 0)
  await db.prepare("UPDATE payment_checkout_holds SET status='released' WHERE payment_id='held'").run()
  const booking = await claimSessionCapacity(db, { organizationId: ORG, productId: 'product', sessionId: 'session', productVariantId: 'variant', partySize: 1 })
  assert.equal(await db.prepare('SELECT party_size FROM bookings WHERE id=?').bind(booking.bookingId).first('party_size'), 1)
 } finally { await runtime.dispose() }
})
test('MCP paid booking cancellation and rejection hand off without preparing money, while dashboard approval and interrupted refund recovery complete once', { timeout: 120_000 }, async t => {
 for (const action of ['cancel', 'reject'] as const) {
  const { db, runtime } = await boot()
  try {
   await db.prepare("INSERT INTO member(id,organizationId,userId,role) VALUES('owner',?,'verified','owner')").bind(ORG).run()
   const opening = { id: 'paid-request', kind: 'booking' as const, organization_id: ORG, location_id: null, user_id: 'guest', review_id: null, conversation_state: 'needs_attention' as const, resolved_at: null, payload: threadPayloadForGuest({ name: 'Guest', email: 'guest@example.com' }), created_at: NOW, updated_at: NOW }
   await db.batch(requestInsertQueries(opening).map(write => db.prepare(write.query).bind(...write.params)))
   const booking = await claimSessionCapacity(db, { organizationId: ORG, productId: 'product', sessionId: 'session', productVariantId: 'variant', partySize: 1, userId: 'guest', requestId: opening.id })
   await payable(db, 'paid')
   await db.prepare("UPDATE payments SET subject_id=?,captured_amount=10000,state='captured',stripe_payment_intent_id='pi_paid',stripe_charge_id='ch_paid' WHERE id='paid'").bind(booking.bookingId).run()
   await db.prepare("UPDATE payment_checkout_holds SET request_id=?,status='converted',converted_booking_id=? WHERE payment_id='paid'").bind(opening.id,booking.bookingId).run()
   const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-proof-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only', STRIPE_SECRET_KEY: 'sk_test_local_boundary' }
   const input = { organizationId: ORG, threadId: opening.id, action, actorUserId: 'verified', idempotencyKey: 'same-request', env }
   const tables = ['bookings', 'requests', 'activity_entries', 'guest_thread_deliveries', 'payments', 'payment_attempts', 'payment_checkout_holds', 'payment_orders', 'payment_order_lines', 'payment_authorizations', 'payment_refunds', 'payment_usage_events']
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
  await db.prepare("UPDATE payments SET captured_amount=10000,refunded_amount=1000,state='captured',price_snapshot_json=? WHERE id='report'").bind(JSON.stringify({title:'Original consultation',quantity:1,price:{unit_amount:10000,currency:'USD',type:'one_time',tax_behavior:'exclusive',provider_secret:'private-provider-value'},buyer_email:'private-buyer@example.test'})).run()
  await db.prepare("INSERT INTO payment_refunds(id,payment_id,idempotency_key,amount,reason,note,status,error,created_by,created_at,updated_at) VALUES('report-refund','report','private-retry-key',1000,'requested_by_customer','private-guest-note','succeeded','private-refund-diagnostic','other',?,?)").bind(NOW,NOW).run()
  await db.prepare("INSERT INTO payment_usage_events(id,organization_id,payment_id,kind,currency,amount,source_id,provider_occurred_at,error,created_at) VALUES('report-usage',?,'report','stripe_cost','USD',100,'private-provider-source',?,'private-usage-diagnostic',?)").bind(ORG,NOW,NOW).run()
  await db.prepare("INSERT INTO stripe_connected_accounts(id,organization_id,stripe_account_id,livemode,country,status,created_at,updated_at) VALUES('report-connected',?,'acct_seller',0,'US','ready',?,?)").bind(ORG,NOW,NOW).run()
  const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_URL:'https://proof.example', BETTER_AUTH_SECRET:'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN:'https://proof.example', STRIPE_SECRET_KEY:'sk_test_local_boundary' }
  const membership = await resolveOrganizationMembership(env,{organizationId:ORG,userId:'verified'})
  assert(membership)
  const organization: McpOrganizationContext = { env,db,userId:'verified',isPlatformAdmin:false,scopes:['organization:read'],organizationId:ORG,organizationSlug:membership.organizationSlug!,role:'owner',membership }
  const call = (toolName:string,args:Record<string,unknown>={}) => handlePaymentsTools({organization,toolName,args}) as Promise<Record<string,unknown>>
  const tables = ['payments','payment_attempts','payment_checkout_holds','payment_orders','payment_order_lines','payment_authorizations','payment_refunds','payment_usage_events','stripe_connected_accounts']
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
  const csv=(amount:string)=>`fee_transaction_id,incurred_by,currency,amount,tax,incurred_at\nfee1,ch:cost,usd,${amount},0.20,2026-10-01T00:00:00Z\nfee2,unknown,usd,5.00,0,2026-10-01T00:00:00Z\nfee3,acct_seller,usd,1.00,0,2026-10-01T00:00:00Z\n`
  await ingestStripeFeeReport(db,false,csv('3.00'));await ingestStripeFeeReport(db,false,csv('3.00'));await ingestStripeFeeReport(db,false,csv('2.00'))
  const events=(await db.prepare("SELECT amount,kind FROM payment_usage_events ORDER BY kind").all()).results
  assert.deepEqual(events,[{amount:320,kind:'stripe_cost'},{amount:-100,kind:'stripe_cost_adjustment'}])
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM payment_cost_snapshots WHERE organization_id IS NULL').first('n'),2)
  assert.equal(await db.prepare("SELECT organization_id FROM payment_cost_snapshots WHERE incurred_by='acct_seller'").first('organization_id'),null)
  assert.throws(()=>stripeFeeMinor('1.2340','USD'), /precision exceeds/u)
 }finally{await runtime.dispose()}
})

test('Checkout proof attaches ownership without exposing merchant financial data or transferring an authenticated purchase', {timeout:120000},async()=>{
 const {db,runtime}=await boot();try{
  await payable(db,'claim')
  await db.prepare("UPDATE payments SET captured_amount=10000,state='captured',stripe_payment_intent_id='pi:claim',stripe_charge_id='ch:claim',receipt_url='https://example.com/receipt' WHERE id='claim'").run()
  await db.prepare("INSERT INTO payment_refunds(id,payment_id,idempotency_key,stripe_refund_id,amount,reason,status,error,created_by,created_at,updated_at) VALUES('refund:claim','claim','refund-retry:claim','re:claim',1000,'requested_by_customer','pending','operator-only diagnostic','other',?,?)").bind(NOW,NOW).run()
  const token=crypto.randomUUID()+crypto.randomUUID(),hash=await tokenHash(token)
  await db.prepare("INSERT INTO payment_claims(token_hash,payment_id,expires_at)VALUES(?,'claim','2099-01-01T00:00:00.000Z')").bind(hash).run()
  // The capture webhook alerted the buyer the payment named at that moment; the return re-sends the same event for the account that proved it. One event, one alert.
  await db.prepare("INSERT INTO user(id,name,email,isAnonymous) VALUES('anon-buyer','Guest','anon-buyer@customers.krabiclaw.local',1)").run()
  await db.prepare("UPDATE payments SET buyer_user_id='anon-buyer' WHERE id='claim'").run()
  const alert={scope:'global' as const,template:'payments:acct_seller:0:pi:claim:succeeded:payment_captured',idempotencyKey:'payments:acct_seller:0:pi:claim:succeeded:payment_captured:buyer',title:'Payment received',deepLink:'/dashboard/account/activity/payment/claim'}
  const first=await createCanonicalNotification(db,{...alert,targetUserId:'anon-buyer'})
  assert.deepEqual(await claimCheckoutReturn(db,'verified',token),{payment_id:'claim',claimed:true})
  assert.equal(await createCanonicalNotification(db,{...alert,targetUserId:'verified'}),first)
  assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE kind='notification' AND event_name=?").bind(alert.template).first('n'),1)
  const originalClaim=await db.prepare('SELECT * FROM payment_claims WHERE token_hash=?').bind(hash).first()
  const originalPayment=await db.prepare("SELECT * FROM payments WHERE id='claim'").first()
  const originalHold=await db.prepare("SELECT * FROM payment_checkout_holds WHERE payment_id='claim'").first()
  assert.equal(originalClaim?.claimed_user_id,'verified')
  assert.equal(typeof originalClaim?.claimed_at,'string')
  assert.equal(originalPayment?.buyer_user_id,'verified')
  assert.equal(originalHold?.buyer_user_id,'verified')
  assert.deepEqual(await claimCheckoutReturn(db,'verified',token),{payment_id:'claim',claimed:true})
  assert.deepEqual(await db.prepare('SELECT * FROM payment_claims WHERE token_hash=?').bind(hash).first(),originalClaim)
  assert.deepEqual(await db.prepare("SELECT * FROM payments WHERE id='claim'").first(),originalPayment)
  assert.deepEqual(await db.prepare("SELECT * FROM payment_checkout_holds WHERE payment_id='claim'").first(),originalHold)
  assert.deepEqual((await buyerActivities(db,'verified')).activities.map(({kind,id})=>({kind,id})),[{kind:'payment',id:'claim'}])
  assert.equal(await buyerPaymentActivityPath(db,'verified','claim'),'/dashboard/account/activity/payment/claim')
  const owned=await loadBuyerBookingDetails(db,'verified','payment','claim')
  assert.equal(owned.type,'payment')
  assert.equal(owned.resourceTitle,'Consultation')
  assert.equal(owned.threadId,null)
  assert.deepEqual(owned.payments,[{payment:{id:'claim',currency:'USD',captured_amount:10000,refunded_amount:0,surcharge_amount:0,state:'captured',receipt_url:'https://example.com/receipt'},refunds:[{id:'refund:claim',amount:1000,status:'pending',note:null}],order:null}])
  for(const field of ['stripe_account_id','stripe_payment_intent_id','stripe_charge_id','livemode','buyer_user_id','price_snapshot_json'])assert.equal(Object.hasOwn(owned.payments![0]!.payment,field),false)
  for(const field of ['idempotency_key','stripe_refund_id','reason','error','attempted_at','created_by'])assert.equal(Object.hasOwn(owned.payments![0]!.refunds[0]!,field),false)
  assert.deepEqual(await db.prepare("SELECT stripe_account_id,stripe_payment_intent_id,stripe_charge_id,buyer_user_id FROM payments WHERE id='claim'").first(),{stripe_account_id:'acct_seller',stripe_payment_intent_id:'pi:claim',stripe_charge_id:'ch:claim',buyer_user_id:'verified'})
  assert.deepEqual(await db.prepare("SELECT idempotency_key,stripe_refund_id,error,created_by FROM payment_refunds WHERE id='refund:claim'").first(),{idempotency_key:'refund-retry:claim',stripe_refund_id:'re:claim',error:'operator-only diagnostic',created_by:'other'})
  assert.equal(await db.prepare("SELECT buyer_user_id FROM payment_checkout_holds WHERE payment_id='claim'").first('buyer_user_id'),'verified')
  await assert.rejects(()=>claimCheckoutReturn(db,'other',token),error=>error instanceof HTTPError&&error.statusCode===404&&error.statusMessage==='Purchase return proof expired or already used')

  const otherToken=crypto.randomUUID()+crypto.randomUUID(),otherHash=await tokenHash(otherToken)
  await db.prepare("INSERT INTO payment_claims(token_hash,payment_id,expires_at)VALUES(?,'claim','2099-01-01T00:00:00.000Z')").bind(otherHash).run()
  await assert.rejects(()=>claimCheckoutReturn(db,'other',otherToken),error=>error instanceof HTTPError&&error.statusCode===404&&error.statusMessage==='Purchase return proof expired or already used')
  assert.equal(await db.prepare('SELECT claimed_at FROM payment_claims WHERE token_hash=?').bind(otherHash).first('claimed_at'),null)
  assert.deepEqual((await buyerActivities(db,'verified')).activities.map(activity=>activity.id),['claim'])
  assert.deepEqual(await buyerActivities(db,'other'),{activities:[]})
  await assert.rejects(()=>loadBuyerBookingDetails(db,'other','payment','claim'),error=>error instanceof HTTPError&&error.statusCode===404)
  await claimCheckoutReturn(db,'verified',otherToken)
  const claimed=await db.prepare('SELECT claimed_at,claimed_user_id FROM payment_claims WHERE token_hash=?').bind(otherHash).first()
  assert.equal(typeof claimed?.claimed_at,'string')
  assert.equal(claimed?.claimed_user_id,'verified')
  assert.deepEqual((await buyerActivities(db,'verified')).activities.map(activity=>activity.id),['claim'])

  await db.prepare("UPDATE payment_claims SET expires_at='2000-01-01T00:00:00.000Z' WHERE token_hash=?").bind(hash).run()
  const expiredClaim=await db.prepare('SELECT * FROM payment_claims WHERE token_hash=?').bind(hash).first()
  assert.equal(expiredClaim?.expires_at,'2000-01-01T00:00:00.000Z')
  await assert.rejects(()=>claimCheckoutReturn(db,'verified',token),error=>error instanceof HTTPError&&error.statusCode===404&&error.statusMessage==='Purchase return proof expired or already used')
  assert.deepEqual(await db.prepare('SELECT * FROM payment_claims WHERE token_hash=?').bind(hash).first(),expiredClaim)
  assert.deepEqual(await db.prepare("SELECT * FROM payments WHERE id='claim'").first(),originalPayment)

  await db.prepare("UPDATE payments SET buyer_user_id='other' WHERE id='claim'").run()
  const changedOwner=await db.prepare("SELECT * FROM payments WHERE id='claim'").first()
  const currentClaim=await db.prepare('SELECT * FROM payment_claims WHERE token_hash=?').bind(otherHash).first()
  assert.equal(changedOwner?.buyer_user_id,'other')
  assert.equal(currentClaim?.claimed_user_id,'verified')
  await assert.rejects(()=>claimCheckoutReturn(db,'verified',otherToken),error=>error instanceof HTTPError&&error.statusCode===404&&error.statusMessage==='Purchase return proof expired or already used')
  assert.deepEqual(await claimCheckoutReturn(db,'other',otherToken),{payment_id:'claim',claimed:true})
  assert.deepEqual(await db.prepare('SELECT * FROM payment_claims WHERE token_hash=?').bind(otherHash).first(),currentClaim)
  assert.deepEqual(await db.prepare("SELECT * FROM payments WHERE id='claim'").first(),changedOwner)
  assert.deepEqual(await db.prepare("SELECT * FROM payment_checkout_holds WHERE payment_id='claim'").first(),originalHold)

  await db.prepare('UPDATE payment_claims SET claimed_user_id=NULL WHERE token_hash=?').bind(otherHash).run()
  const retainedClaim=await db.prepare('SELECT * FROM payment_claims WHERE token_hash=?').bind(otherHash).first()
  assert.equal(retainedClaim?.claimed_user_id,null)
  assert.equal(retainedClaim?.claimed_at,currentClaim?.claimed_at)
  assert.deepEqual(await claimCheckoutReturn(db,'other',otherToken),{payment_id:'claim',claimed:true})
  await assert.rejects(()=>claimCheckoutReturn(db,'verified',otherToken),error=>error instanceof HTTPError&&error.statusCode===404&&error.statusMessage==='Purchase return proof expired or already used')
  assert.deepEqual(await db.prepare('SELECT * FROM payment_claims WHERE token_hash=?').bind(otherHash).first(),retainedClaim)
  assert.deepEqual(await db.prepare("SELECT * FROM payments WHERE id='claim'").first(),changedOwner)
  assert.deepEqual(await db.prepare("SELECT * FROM payment_checkout_holds WHERE payment_id='claim'").first(),originalHold)

  await db.prepare("UPDATE payments SET buyer_user_id=NULL WHERE id='claim'").run()
  const unownedPayment=await db.prepare("SELECT * FROM payments WHERE id='claim'").first()
  assert.equal(unownedPayment?.buyer_user_id,null)
  for(const userId of ['verified','other'])await assert.rejects(()=>claimCheckoutReturn(db,userId,otherToken),error=>error instanceof HTTPError&&error.statusCode===404&&error.statusMessage==='Purchase return proof expired or already used')
  assert.deepEqual(await db.prepare('SELECT * FROM payment_claims WHERE token_hash=?').bind(otherHash).first(),retainedClaim)
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
  // on payment, its hold, and no reservation yet. The return claims all of it for the signed-in buyer.
  const startsAt = '2099-10-01T13:00:00.000Z', endsAt = '2099-10-01T15:00:00.000Z'
  await db.prepare("INSERT INTO business_locations(id,organization_id,slug,title,status,timezone,opening_hours) VALUES('dining',?,'dining','Dining','active','UTC',?)").bind(ORG, JSON.stringify({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] })).run()
  await upsertLocationReservationConfig(db, { organizationId: ORG, locationId: 'dining', patch: { slot_capacity: 1 }, actorId: 'verified', env })
  const receipt = await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET, 'deposit-request')
  const opening = { id: 'deposit-request', kind: 'reservation' as const, organization_id: ORG, location_id: 'dining', user_id: 'guest', review_id: null, conversation_state: 'waiting_on_guest' as const, resolved_at: null, payload: { ...threadPayloadForGuest({ name: 'Verified', email: 'verified@example.com', phone: '+12025550123' }), cancellation: { token_hash: await hashReservationCancelToken(receipt.token), expires_at: receipt.expiresAt, used_at: null } }, created_at: NOW, updated_at: NOW }
  await db.batch(requestInsertQueries(opening).map(write => db.prepare(write.query).bind(...write.params)))
  const terms = { policy_type: 'reservation', free_cancellation_until_minutes: null, reschedule_allowed: true, reschedule_cutoff_minutes: null, deposit_required: true, deposit_amount: 10000, deposit_currency: 'USD', deposit_tax_behavior: 'exclusive' }
  await db.prepare("INSERT INTO payments(id,organization_id,buyer_user_id,stripe_account_id,livemode,subject_type,location_id,currency,amount,price_snapshot_json,created_at,updated_at) VALUES('deposit',?,?,'acct_seller',0,'reservation','dining','USD',10000,?,?,?)").bind(ORG, 'guest', JSON.stringify({ title: 'Dining reservation deposit', reservation: terms }), NOW, NOW).run()
  await db.prepare("INSERT INTO payment_checkout_holds(id,organization_id,location_id,timezone,buyer_user_id,request_id,payment_id,quantity,amount,currency,starts_at,ends_at,status,expires_at,created_at) VALUES('deposit-hold',?,'dining','UTC',?,'deposit-request','deposit',1,10000,'USD',?,?,'active','2099-09-30T00:00:00.000Z',?)").bind(ORG, 'guest', startsAt, endsAt, NOW).run()
  const claims: Record<string, string> = {}
  for (const id of ['deposit', 'clearing', 'declined']) {
   claims[id] = crypto.randomUUID() + crypto.randomUUID()
   await db.prepare("INSERT INTO payment_claims(token_hash,payment_id,expires_at) VALUES(?,?,'2099-01-01T00:00:00.000Z')").bind(await tokenHash(claims[id]!), id).run()
  }
  await db.prepare("INSERT INTO payment_attempts(id,payment_id,idempotency_key,stripe_payment_intent_id,return_token,status,expires_at,created_at,updated_at) VALUES('a:deposit','deposit','checkout:deposit','pi_deposit',?,'open','2099-09-30T00:00:00.000Z',?,?)").bind(claims.deposit, NOW, NOW).run()

  const statuses: Record<string, string> = { pi_deposit: 'succeeded', pi_clearing: 'processing', pi_declined: 'requires_payment_method' }
  const originalFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
   const url = new URL(request instanceof Request ? request.url : String(request))
   if (url.origin !== 'https://api.stripe.com') return originalFetch(request, init)
   assert.equal(init?.method, 'GET')
   assert.equal(new Headers(init?.headers).get('stripe-account'), 'acct_seller')
   assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer sk_test_local_boundary')
   const charge = { id: 'ch_deposit', object: 'charge', livemode: false, amount: 10000, currency: 'usd', created: 1_790_000_000, payment_intent: 'pi_deposit', payment_method: 'pm_card', receipt_url: 'https://pay.stripe.com/receipts/deposit', billing_details: { email: 'card@example.com' } }
   if (url.pathname === '/v1/charges/ch_deposit') return Response.json(charge)
   const id = url.pathname.split('/').at(-1)!
   assert.ok(id in statuses, `Unexpected Stripe request: ${url.pathname}`)
   if (id === 'pi_deposit') assert.equal(url.searchParams.get('expand[0]'), 'latest_charge')
   const paid = statuses[id] === 'succeeded'
   return Response.json({ id, object: 'payment_intent', livemode: false, currency: 'usd', amount: 10000, amount_received: paid ? 10000 : 0, status: statuses[id], customer: null, application_fee_amount: null, latest_charge: paid ? charge : null, last_payment_error: null, metadata: { krabiclaw_payment_id: id.slice(3) } })
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
  assert.deepEqual(await db.prepare("SELECT claimed_at,claimed_user_id FROM payment_claims WHERE payment_id='clearing'").first(), { claimed_at: null, claimed_user_id: null })
  assert.equal((await requirePayment(db, ORG, 'clearing')).buyer_user_id, 'guest')

  // A method Stripe has not accepted is not a purchase.
  const declined = await back('declined')
  assert.equal(declined.status, 409)
  assert.equal((await declined.json() as { message?: string }).message, 'Stripe has not authenticated this purchase')
  assert.deepEqual(await db.prepare("SELECT claimed_at FROM payment_claims WHERE payment_id='declined'").first(), { claimed_at: null })

  // Another business's site cannot complete this business's payment.
  const elsewhere = new H3()
  elsewhere.use((event) => { event.context.organizationId = 'another-org' })
  elsewhere.post('/api/public/payments/:paymentId/return', paymentReturnRoute)
  const foreign = await elsewhere.request(Object.assign(new Request('https://another.proof.example/api/public/payments/deposit/return', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ claim: claims.deposit }) }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
  assert.equal(foreign.status, 404)
  assert.equal(await db.prepare("SELECT claimed_at FROM payment_claims WHERE payment_id='deposit'").first('claimed_at'), null)

  // Paid: Stripe's capture makes the reservation, the purchase is claimed for the browser's own buyer,
  // and the receipt is the business's confirmation, not the platform's.
  const paid = await back('deposit', { cookie })
  assert.equal(paid.status, 200)
  assert.deepEqual(await paid.json(), { state: 'paid', kind: 'reservation', request_id: 'deposit-request', cancellation_token: receipt.token })
  assert.deepEqual(paid.headers.getSetCookie(), [])
  assert.deepEqual(await db.prepare("SELECT claimed_user_id FROM payment_claims WHERE payment_id='deposit'").first(), { claimed_user_id: buyer })
  const reservationId = await db.prepare("SELECT converted_reservation_id FROM payment_checkout_holds WHERE id='deposit-hold' AND status='converted'").first<string>('converted_reservation_id')
  assert.equal(typeof reservationId, 'string')
  assert.deepEqual(await db.prepare("SELECT buyer_user_id,state,captured_amount,receipt_url,subject_id FROM payments WHERE id='deposit'").first(), { buyer_user_id: buyer, state: 'captured', captured_amount: 10000, receipt_url: 'https://pay.stripe.com/receipts/deposit', subject_id: reservationId })
  assert.deepEqual(await db.prepare('SELECT request_id,user_id,status FROM reservations WHERE id=?').bind(reservationId).first(), { request_id: 'deposit-request', user_id: buyer, status: 'confirmed' })
  // The capture alert went to the buyer who proved the purchase, once.
  assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE request_id='deposit-request' AND event_name='payment.payment_captured'").first('n'), 1)

  // The confirmation page reads that receipt through the business's receipt endpoint, with the guest's booking email for the account prompt.
  const read = await call('/api/public/booking-requests/deposit-request', { headers: { authorization: `Bearer ${receipt.token}` } })
  assert.equal(read.status, 200)
  const booking = (await read.json() as { booking: Record<string, unknown> }).booking
  assert.deepEqual({ kind: booking.kind, status: booking.status, name: booking.name, email: booking.email, starts_at: booking.starts_at, timezone: booking.timezone, guests: booking.guests, location_id: booking.location_id },
   { kind: 'reservation', status: 'confirmed', name: 'Verified', email: 'verified@example.com', starts_at: '2099-10-01T13:00:00.000Z', timezone: 'UTC', guests: '1', location_id: 'dining' })

  // Returning again, as a reload of the pay page does, names the same receipt and changes nothing.
  const before = await db.prepare("SELECT * FROM payment_claims WHERE payment_id='deposit'").first()
  const again = await back('deposit', { cookie })
  assert.deepEqual(await again.json(), { state: 'paid', kind: 'reservation', request_id: 'deposit-request', cancellation_token: receipt.token })
  assert.deepEqual(await db.prepare("SELECT * FROM payment_claims WHERE payment_id='deposit'").first(), before)
  assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE request_id='deposit-request' AND event_name='payment.payment_captured'").first('n'), 1)
 } finally {
  await runtime.dispose()
 }
})

test('buyer Activity groups exact owned visits and immutable orders without manufacturing conversations', {timeout:120000},async()=>{
 const {db,runtime}=await boot();try{
  const opening={id:'booking-request',kind:'booking' as const,organization_id:ORG,location_id:null,user_id:'verified',review_id:null,conversation_state:'needs_attention' as const,resolved_at:null,payload:threadPayloadForGuest({name:'Verified',email:'verified@example.com',notes:'My booking note',ipHash:'private-ip-hash'}),created_at:NOW,updated_at:NOW}
  await db.batch(requestInsertQueries(opening).map(write=>db.prepare(write.query).bind(...write.params)))
  const booking=await claimSessionCapacity(db,{organizationId:ORG,productId:'product',sessionId:'session',productVariantId:'variant',partySize:1,userId:'verified',requestId:opening.id})
  assert.notEqual(booking.bookingId,opening.id)
  assert.equal(await db.prepare('SELECT request_id FROM bookings WHERE id=?').bind(booking.bookingId).first('request_id'),opening.id)
  await payable(db,'visit-payment')
  await db.prepare("UPDATE payments SET buyer_user_id='verified',subject_id=?,captured_amount=10000,state='captured' WHERE id='visit-payment'").bind(booking.bookingId).run()
  await db.prepare("UPDATE payment_checkout_holds SET buyer_user_id='verified',request_id=?,status='converted' WHERE payment_id='visit-payment'").bind(opening.id).run()
  await db.prepare("INSERT INTO payments(id,organization_id,buyer_user_id,stripe_account_id,livemode,subject_type,subject_id,currency,amount,captured_amount,state,price_snapshot_json,created_at,updated_at) VALUES('other-payment',?,'other','acct_seller',0,'booking',?,'USD',10000,10000,'captured',?,?,?)").bind(ORG,booking.bookingId,JSON.stringify({title:'Other private purchase'}),NOW,NOW).run()
  const visits=(await buyerActivities(db,'verified')).activities
  assert.deepEqual(visits.map(({kind,id,requestId,operationalId})=>({kind,id,requestId,operationalId})),[{kind:'booking',id:opening.id,requestId:opening.id,operationalId:booking.bookingId}])
  assert.equal(await buyerPaymentActivityPath(db,'verified','visit-payment'),`/dashboard/account/activity/booking/${opening.id}`)
  const detail=await loadBuyerBookingDetails(db,'verified','booking',opening.id)
  assert.deepEqual(detail.payments!.map(item=>item.payment.id),['visit-payment'])
  assert.equal(detail.threadId,opening.id)
  assert.deepEqual(detail.notes,[])
  assert.equal(detail.assignedMemberName,null)
  await assert.rejects(()=>loadBuyerBookingDetails(db,'verified','booking',booking.bookingId),error=>error instanceof HTTPError&&error.statusCode===404)
  await assert.rejects(()=>loadBuyerBookingDetails(db,'other','booking',opening.id),error=>error instanceof HTTPError&&error.statusCode===404)
  await db.prepare("INSERT INTO payments(id,organization_id,buyer_user_id,stripe_account_id,livemode,subject_type,currency,amount,captured_amount,state,price_snapshot_json,created_at,updated_at) VALUES('order-payment',?,'verified','acct_seller',0,'order','USD',2500,2500,'captured',?,?,?)").bind(ORG,JSON.stringify({title:'Immutable item'}),NOW,NOW).run()
  await db.prepare("INSERT INTO payment_orders(id,organization_id,buyer_user_id,payment_id,currency,amount,created_at) VALUES('immutable-order',?,'verified','order-payment','USD',2500,?)").bind(ORG,NOW).run()
  await db.prepare("INSERT INTO payment_order_lines(id,order_id,product_id,variant_id,price_id,title,unit_amount,quantity,currency,tax_behavior) VALUES('immutable-line','immutable-order','product','variant','historic-price','Original item title',1250,2,'USD','exclusive')").run()
  const requestsBefore=(await db.prepare('SELECT * FROM requests ORDER BY id').all()).results
  const order=await loadBuyerBookingDetails(db,'verified','order','order-payment')
  assert.equal(order.type,'order')
  assert.equal(order.threadId,null)
  assert.equal(order.partySize,null)
  assert.deepEqual(order.payments![0]!.order,{lines:[{id:'immutable-line',title:'Original item title',unit_amount:1250,quantity:2,currency:'USD'}]})
  assert.deepEqual((await db.prepare('SELECT * FROM requests ORDER BY id').all()).results,requestsBefore)
  await assert.rejects(()=>loadBuyerBookingDetails(db,'other','order','order-payment'),error=>error instanceof HTTPError&&error.statusCode===404)
  await db.prepare("UPDATE bookings SET user_id='other' WHERE id=?").bind(booking.bookingId).run()
  assert.equal((await buyerActivities(db,'verified')).activities.some(item=>item.kind==='booking'),false)
  await assert.rejects(()=>loadBuyerBookingDetails(db,'verified','booking',opening.id),error=>error instanceof HTTPError&&error.statusCode===404)
  const retainedPayment=await loadBuyerBookingDetails(db,'verified','payment','visit-payment')
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
  const opening=requestInsertQueries({id:'buyer-conversation',kind:'contact',organization_id:ORG,location_id:null,user_id:'verified',review_id:null,conversation_state:'needs_attention',resolved_at:null,payload:{guest:{name:'Verified',email:'verified@example.com',phone:null},subject:'Sandbox conversation',message:'My question',consent_at:null,ip_hash:'private-ip-hash'},created_at:NOW,updated_at:NOW})
  await db.batch(opening.map(write=>db.prepare(write.query).bind(...write.params)))
  const publicReply=await appendEntry(db,{threadId:'buyer-conversation',kind:'message',actorKind:'member',actorUserId:'other',channel:'web',eventName:'thread.member_reply',body:'Public host reply',payloadJson:{provider_secret:'private-diagnostic'},dedupeKey:'public-host-reply'})
  const capture=await appendEntry(db,{threadId:'buyer-conversation',kind:'operation',actorKind:'system',eventName:'payment.payment_captured',body:'Payment received',payloadJson:{stripe_charge_id:'private-charge'},dedupeKey:'public-capture'})
  const internal=await appendEntry(db,{threadId:'buyer-conversation',kind:'message',actorKind:'member',actorUserId:'other',channel:'system',body:'Internal staff note',dedupeKey:'internal-note'})
  const dispute=await appendEntry(db,{threadId:'buyer-conversation',kind:'operation',actorKind:'system',eventName:'payment.dispute_created',body:'Merchant dispute diagnostic',payloadJson:{stripe_dispute_id:'private-dispute'},dedupeKey:'merchant-dispute'})
  await db.prepare("UPDATE requests SET archived_at=?,archived_by_user_id='other',conversation_state='resolved',resolved_at=? WHERE id='buyer-conversation'").bind(NOW,NOW).run()
  const view=await getGuestThreadDetail(db,'buyer-conversation',ORG,{buyerUserId:'verified'})
  assert(view)
  assert.deepEqual(view.entries.filter(entry=>entry.kind!=='submission').map(entry=>entry.id),[publicReply.id,capture.id])
  assert(view.entries.every(entry=>(entry.actorUserId===null||(entry.actorKind==='guest'&&entry.actorUserId==='verified'))&&entry.deliveries.length===0))
  assert.deepEqual(view.deliveryFailures,[])
  assert.deepEqual(view.availableActions,[])
  assert.equal(view.conversationState,null)
  assert.equal(view.manuallyArchived,false)
  assert.equal(view.archivedByUserId,null)
  for(const secret of ['private-ip-hash','private-diagnostic','private-charge','private-dispute','Internal staff note','Merchant dispute diagnostic'])assert.equal(JSON.stringify(view).includes(secret),false)
  const inbox=await listGuestThreads(db,null,{userId:'verified',buyerAudience:true})
  assert.equal(inbox[0]?.unreadCount,1)
  assert.equal(inbox[0]?.unread,true)
  assert.equal(inbox[0]?.preview?.text,'Public host reply')
  assert.deepEqual(await listGuestThreads(db,null,{userId:'other',buyerAudience:true}),[])
  assert.equal(await acknowledgeBuyerThreadEntries(db,'other','buyer-conversation',[publicReply.id,capture.id]),0)
  assert.equal(await acknowledgeBuyerThreadEntries(db,'verified','buyer-conversation',[publicReply.id,capture.id,internal.id,dispute.id]),2)
  assert.deepEqual((await db.prepare("SELECT parent_id,actor_user_id FROM activity_entries WHERE kind='acknowledgement' AND request_id='buyer-conversation' ORDER BY parent_id").all()).results,[{parent_id:publicReply.id,actor_user_id:'verified'},{parent_id:capture.id,actor_user_id:'verified'}].sort((a,b)=>a.parent_id.localeCompare(b.parent_id)))
  assert.equal(await acknowledgeBuyerThreadEntries(db,'verified','buyer-conversation',[publicReply.id,capture.id]),0)
  const readInbox=await listGuestThreads(db,null,{userId:'verified',buyerAudience:true})
  assert.equal(readInbox[0]?.unreadCount,0)
  assert.equal(readInbox[0]?.unread,false)
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
  const projection=await db.prepare("SELECT updated_at,conversation_state FROM requests WHERE id='buyer-conversation'").first()
  assert.equal(projection?.updated_at,message.occurred_at)
  const notices=(await db.prepare("SELECT * FROM activity_entries WHERE kind='notification' AND parent_id=?").bind(message.id).all()).results
  assert.equal(notices.length,1)
  await receiveGuestWebReply(env,input)
  assert.deepEqual((await db.prepare("SELECT * FROM activity_entries WHERE request_id='buyer-conversation' ORDER BY sequence").all()).results,ledger)
  assert.deepEqual(await db.prepare("SELECT updated_at,conversation_state FROM requests WHERE id='buyer-conversation'").first(),projection)
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
  assert.deepEqual(await db.prepare("SELECT updated_at,conversation_state FROM requests WHERE id='buyer-conversation'").first(),projection)
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
 const {db,runtime}=await boot();try{
  await payable(db,'expired','2000-01-01T00:00:00.000Z')
  const booking=await claimSessionCapacity(db,{organizationId:ORG,productId:'product',sessionId:'session',productVariantId:'variant',partySize:1})
  assert.equal(await db.prepare('SELECT party_size FROM bookings WHERE id=?').bind(booking.bookingId).first('party_size'),1)
  assert.equal(await db.prepare("SELECT status FROM payment_checkout_holds WHERE payment_id='expired'").first('status'),'active')
 }finally{await runtime.dispose()}
})

test('Payments usage reaches its Stripe meters once, a correction as a negative value, and a rejected event keeps Stripe’s reason', {timeout:120000},async(t)=>{
 const {db,runtime}=await boot();try{
  await db.prepare('UPDATE organization SET "stripeCustomerId"=? WHERE id=?').bind('cus_operating',ORG).run()
  await db.prepare(`INSERT INTO organization(id,name,slug,subdomain,settings_json,theme_id,default_currency,status,onboarding_status,url_structure,vertical,updated_at,timezone) VALUES('platform','KrabiClaw','krabiclaw','krabiclaw','{}','krabiclaw-theme-v1','USD','active','complete','flat','service',?,'America/Los_Angeles')`).bind(NOW).run()
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
   if(answer==='invalid')return Response.json({error:{type:'invalid_request_error',message:'No active meter was found for event_name krabiclaw_ad_spend'}},{status:400})
   return Response.json({object:'billing.meter_event',event_name:body.get('event_name'),identifier:body.get('identifier'),payload:{},timestamp:1,created:1,livemode:false})
  })
  const env={DB:db,STRIPE_SECRET_KEY:'sk_test_meter_boundary'} as CloudflareEnv
  // Stripe unavailable: the event keeps the reason and stays deliverable.
  await assert.rejects(()=>deliverPaymentsUsage(db,env,ORG),/unavailable at the test boundary/u)
  assert.deepEqual(await db.prepare("SELECT delivery_at,dead_letter_at,error FROM payment_usage_events WHERE id='volume'").first(),{delivery_at:null,dead_letter_at:null,error:'Meter events are unavailable at the test boundary'})
  // Delivered: each to its meter, the correction negative, the repeat of the first under the same identifier and key.
  answer='ok'
  assert.deepEqual(await deliverPaymentsUsage(db,env,ORG),{delivered:4})
  assert.deepEqual(sent.slice(1).map(({identifier,key,...row})=>row),[
   {event_name:'krabiclaw_captured_volume',customer:'cus_operating',value:'10000'},
   {event_name:'krabiclaw_stripe_cost',customer:'cus_operating',value:'320'},
   {event_name:'krabiclaw_stripe_cost',customer:'cus_operating',value:'-30'},
   {event_name:'krabiclaw_ad_spend',customer:'cus_operating',value:'50000'},
  ])
  assert.equal(sent[1]!.identifier,sent[0]!.identifier)
  assert.equal(sent[1]!.key,sent[1]!.identifier)
  assert.equal(sent[1]!.identifier,`payments:${await tokenHash('capture:billable')}`)
  assert.equal(new Set(sent.slice(1).map(row=>row.identifier)).size,4)
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM payment_usage_events WHERE delivery_at IS NOT NULL AND error IS NULL').first('n'),4)
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM analytics_events WHERE organization_id='platform' AND payload_json->>'$.event_name'='payments_volume_billed' AND payload_json->>'$.properties.volume_minor'=10000").first('n'),1)
  assert.deepEqual(await deliverPaymentsUsage(db,env,ORG),{delivered:0})
  assert.equal(sent.length,5)
  // Stripe refuses an event outright: it is set aside with Stripe’s reason, not retried.
  answer='invalid'
  await db.prepare("INSERT INTO payment_usage_events(id,organization_id,kind,currency,amount,source_id,provider_occurred_at,created_at)VALUES('late',?,'ad_spend','USD',100,'google_ads:1234567890:2026-10-01',?,?)").bind(ORG,NOW,NOW).run()
  await assert.rejects(()=>deliverPaymentsUsage(db,env,ORG),/No active meter/u)
  const late=await db.prepare("SELECT delivery_at,dead_letter_at,error FROM payment_usage_events WHERE id='late'").first<{delivery_at:string|null;dead_letter_at:string|null;error:string}>()
  assert.equal(late?.delivery_at,null)
  assert.equal(typeof late?.dead_letter_at,'string')
  assert.equal(late?.error,'No active meter was found for event_name krabiclaw_ad_spend')
  assert.deepEqual(await deliverPaymentsUsage(db,env,ORG),{delivered:0})
  assert.equal(sent.length,6)
 }finally{await runtime.dispose()}
})

test('ACH Direct Debit payment review and confirmation handles bank account details, zero surcharge, and processing hold extension', { timeout: 120_000 }, async (t) => {
  const { db, runtime } = await boot()
  try {
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-proof-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only', STRIPE_SECRET_KEY: 'sk_test_local_boundary' }
    await payable(db, 'ach-payment')
    const opening = { id: 'ach-request', kind: 'booking' as const, organization_id: ORG, location_id: null, user_id: 'guest', review_id: null, conversation_state: 'needs_attention' as const, resolved_at: null, payload: threadPayloadForGuest({ name: 'Guest', email: 'guest@example.com' }), created_at: NOW, updated_at: NOW }
    await db.batch(requestInsertQueries(opening).map(write => db.prepare(write.query).bind(...write.params)))
    await db.prepare("UPDATE payment_checkout_holds SET request_id=? WHERE payment_id='ach-payment'").bind(opening.id).run()
    const originalFetch = globalThis.fetch

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
          payment_method: {
            id: 'pm_achproof123',
            object: 'payment_method',
            type: 'us_bank_account',
            us_bank_account: {
              bank_name: 'STRIPE TEST BANK',
              last4: '6789',
              routing_number: '110000000',
              account_holder_type: 'individual',
            },
          },
        })
      }
      if (url.pathname === '/v1/payment_intents/pi_ach-payment' && init?.method === 'GET') {
        return Response.json({
          id: 'pi_ach-payment',
          object: 'payment_intent',
          status: 'requires_confirmation',
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
        })
      }
      throw new Error(`Unexpected Stripe request: ${init?.method} ${url.pathname}`)
    })

    const stripe = getStripe(env)
    const claim = crypto.randomUUID() + crypto.randomUUID()
    const hash = await tokenHash(claim)
    await db.prepare("INSERT INTO payment_claims(token_hash, payment_id, expires_at) VALUES (?, 'ach-payment', '2099-01-01T00:00:00.000Z')").bind(hash).run()

    // A confirmation decline leaves the purchase open for another method.
    const declinedIntent = {
      id: 'pi_ach-payment', livemode: false, currency: 'usd',
      metadata: { krabiclaw_payment_id: 'ach-payment' },
      status: 'requires_payment_method', amount: 10000,
      last_payment_error: { type: 'card_error', code: 'card_declined' },
    } as Stripe.PaymentIntent
    const originalHold = await db.prepare("SELECT status, expires_at FROM payment_checkout_holds WHERE payment_id='ach-payment'").first()
    await reconcilePaymentIntent(db, stripe, await requirePayment(db, ORG, 'ach-payment'), declinedIntent, env)
    assert.equal((await requirePayment(db, ORG, 'ach-payment')).state, 'pending')
    assert.equal((await requireOpenAttempt(db, ORG, 'ach-payment', claim)).state, 'open')
    assert.deepEqual(await db.prepare("SELECT status, expires_at FROM payment_checkout_holds WHERE payment_id='ach-payment'").first(), originalHold)

    const review = await reviewPayment(db, stripe, ORG, 'ach-payment', claim, 'pm_achproof123')
    assert.equal(review.surcharge, 0)
    assert.equal(review.total, 10000)
    assert.equal(review.method.type, 'us_bank_account')
    assert.equal(review.method.bank_name, 'STRIPE TEST BANK')
    assert.equal(review.method.last4, '6789')

    const confirm = await confirmPayment(db, stripe, env, ORG, 'ach-payment', claim, { payment_method_id: 'pm_achproof123', total: 10000 }, 'https://payments.proof.example')
    assert.deepEqual(confirm, { status: 'processing', client_secret: 'pi_ach-payment_secret', requires_action: false })

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
    const payment = await requirePayment(db, ORG, 'ach-payment')
    await reconcilePaymentIntent(db, stripe, payment, failedIntent, env)

    assert.equal((await requirePayment(db, ORG, 'ach-payment')).state, 'pending')
    assert.deepEqual(await db.prepare("SELECT status, expires_at FROM payment_checkout_holds WHERE payment_id='ach-payment'").first(), hold)
    assert.equal(await db.prepare("SELECT count(*) FROM activity_entries WHERE request_id=? AND event_name='payment.payment_failed'").bind(opening.id).first('count(*)'), 1)

    // Cancellation is terminal and releases the active capacity hold.
    await reconcilePaymentIntent(db, stripe, await requirePayment(db, ORG, 'ach-payment'), { ...failedIntent, status: 'canceled', last_payment_error: null }, env)
    assert.equal((await requirePayment(db, ORG, 'ach-payment')).state, 'failed')
    assert.equal((await requireOpenAttempt(db, ORG, 'ach-payment', claim)).state, 'failed')
    const releasedHold = await db.prepare("SELECT status FROM payment_checkout_holds WHERE payment_id='ach-payment'").first<{ status: string }>()
    assert.equal(releasedHold?.status, 'released')
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
      assert.equal(await processPaymentEvent(db, getStripe(env), event, env), true)
      const hold = await db.prepare('SELECT status, expires_at FROM payment_checkout_holds WHERE payment_id=?').bind(id).first<{ status: string; expires_at: string }>()
      assert.equal(hold?.status, status)
      assert.equal((await requirePayment(db, ORG, id)).state, 'pending')
      if (status === 'active') {
        assert.ok(Date.parse(hold!.expires_at) >= Date.now() + 13 * 86400_000)
        await assert.rejects(claimSessionCapacity(db, { organizationId: ORG, productId: 'product', sessionId: 'session', productVariantId: 'variant', partySize: 1 }), /no longer has room/u)
      } else {
        assert.equal(hold?.expires_at, expires)
      }
    }
  } finally {
    await runtime.dispose()
  }
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
  assert.deepEqual(await statusRead.json(), { success: true, services: { managed_ads: null, strategy: null } })
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
  assert.equal(ingests.length, 5)
  assert.deepEqual(ingests[0], ingests[1], 'failed delivery preserves the meter event identifier')
  assert.deepEqual(ingests[1], ingests[2], 'concurrent failed deliveries preserve the meter event identifier')
  assert.deepEqual(ingests[0], ingests[3], 'a failed zero-spend event retries under the same identifier')
  assert.equal(ingests[3]?.value, '0')
  assert.equal(ingests[4]?.value, '1250')
  const delivered = (await db.prepare("SELECT id,delivery_at FROM payment_usage_events WHERE kind='ad_spend' ORDER BY source_id").all()).results
  assert.deepEqual(delivered.map(row => row.id), captured.map(row => row.id))
  assert.ok(delivered.every(row => row.delivery_at === '2026-10-04T10:00:00.000Z'))
  assert.deepEqual((await runDaily()).result, { billed: 0, skipped: 1 })
  assert.equal(ingests.length, 5)
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
