import {createCanonicalNotification} from '../../server/utils/notification-center.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import Stripe from 'stripe'
import { HTTPError } from 'nitro'
import { Miniflare } from 'miniflare'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import * as schema from '../../server/db/schema.ts'
import { claimSessionCapacity } from '../../server/utils/availability.ts'
import { ingestStripeFeeReport, stripeFeeMinor } from '../../server/domain/payments/costs.ts'
import { buyerActivities, buyerPaymentActivityPath, claimCheckoutReturn, tokenHash } from '../../server/domain/payments/buyer.ts'
import { loadBuyerBookingDetails } from '../../server/utils/dashboard-booking-details.ts'
import { requestInsertQueries, threadPayloadForGuest } from '../../server/domain/requests.ts'
import { appendEntry } from '../../server/domain/guest-threads/entries.ts'
import { getGuestThreadDetail } from '../../server/domain/guest-threads/detail.ts'
import { listGuestThreads } from '../../server/domain/guest-threads/repository.ts'
import { receiveGuestWebReply } from '../../server/domain/guest-threads/inbound-email.ts'
import { acknowledgeBuyerThreadEntries } from '../../server/utils/notification-acknowledgement.ts'
import { retainPaymentsForTenantDeletion } from '../../server/domain/payments/retention.ts'
import paymentsReconcile from '../../server/tasks/payments-reconcile.ts'
import { deliverPaymentsUsage, paymentsUsageStatus, reconcileNativeBillingCredit } from '../../server/domain/payments/usage.ts'
import { getStripe } from '../../server/utils/billing.ts'
import { executeGuestThreadOperation } from '../../server/domain/guest-threads/operations.ts'
import { approveRefundAuthorization, executeRefund, requirePayment } from '../../server/domain/payments/index.ts'
import { mcpFinancialApprovalErrorResult } from '../../server/utils/mcp-financial-handoff.ts'
import { handlePaymentsTools } from '../../server/utils/mcp-tools/payments.ts'
import { resolveOrganizationMembership } from '../../server/utils/member-access.ts'
import type { McpOrganizationContext } from '../../server/utils/mcp-auth.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
const ORG = 'payments-org', NOW = '2026-10-01T00:00:00.000Z'
async function boot(){
 const runtime=new Miniflare({workers:[{config:{name:'payments-proof',compatibilityDate:'2024-11-01',manifest:{mainModule:'index.mjs',modules:{'index.mjs':{type:'esm',contents:'export class Hub { fetch(){return new Response(null,{status:204})} } export default {fetch(){return new Response("ok")}}'}}},exports:{Hub:{type:'durable-object',storage:'sqlite'}},env:{DB:{type:'d1'},GUEST_INBOX_HUBS:{type:'durable-object',worker:'payments-proof',exportName:'Hub'}}}}]})
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
 await db.prepare("INSERT INTO payment_attempts(id,payment_id,idempotency_key,stripe_checkout_id,return_token,status,expires_at,created_at,updated_at) VALUES(?,?,?,?,'test-return-proof','open',?,?,?)").bind(`a:${id}`,id,`checkout:${id}`,`cs:${id}`,expires,NOW,NOW).run()
 await db.prepare("INSERT INTO payment_checkout_holds(id,organization_id,product_id,variant_id,price_id,session_id,buyer_user_id,payment_id,quantity,amount,currency,starts_at,ends_at,status,expires_at,created_at,assigned_member_id) VALUES(?,?,'product','variant','price','session','guest',?,1,10000,'USD','2099-10-01T13:00:00.000Z','2099-10-01T14:00:00.000Z','active',?,?,'host-member')").bind(`h:${id}`,ORG,id,expires,NOW).run()
}
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
   await db.prepare("UPDATE payments SET subject_id=?,captured_amount=10000,state='captured',stripe_payment_intent_id='pi_paid' WHERE id='paid'").bind(booking.bookingId).run()
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
   const fetchMock = t.mock.method(globalThis,'fetch',async (request, init) => {
    const url = new URL(request instanceof Request ? request.url : String(request))
    if(url.origin!=='https://api.stripe.com')return originalFetch(request,init)
    assert.equal(new Headers(init?.headers).get('stripe-account'),'acct_seller')
    if(url.pathname==='/v1/refunds' && init?.method==='POST') {
     creations++
     return Response.json({error:{type:'api_error',message:'Native response interrupted'}},{status:503,headers:{'stripe-should-retry':'false'}})
    }
    assert.equal(init?.method,'GET')
    if(url.pathname==='/v1/refunds')return Response.json({object:'list',data:[nativeRefund],has_more:false})
    if(url.pathname==='/v1/refunds/re_paid')return Response.json(nativeRefund)
    assert.equal(decodeURIComponent(url.pathname),'/v1/checkout/sessions/cs:paid')
    return Response.json({id:'cs:paid',object:'checkout.session',client_reference_id:'paid',livemode:false,currency:'usd',payment_intent:'pi_paid',customer_details:{email:'guest@example.com'}})
   })
   try {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY,{maxNetworkRetries:0,httpClient:Stripe.createFetchHttpClient()})
    const key = `${action==='reject'?'rejected':'cancelled'}:${booking.bookingId}`
    const payment = await requirePayment(db,ORG,'paid')
    const refund = () => executeRefund(db,stripe,payment,10000,key,'requested_by_customer','verified',env)
    await assert.rejects(refund,/Native response interrupted/u)
    await db.prepare("UPDATE payment_authorizations SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(authorizationId).run()
    await approveRefundAuthorization(db,principal,authorizationId)
    assert.equal((await executeGuestThreadOperation(db,approvedInput)).ok,true)
    assert.equal((await refund()).status,'succeeded')
    assert.equal((await refund()).status,'succeeded')
    assert.equal(creations,1)
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
  const usage = await call('get_payments_usage')
  assert.deepEqual(usage.pending,[{currency:'USD',kind:'stripe_cost',event_count:1,amount:100,billing_currency:'USD',billing_amount:100,action_required:true}])
  assert.equal(usage.dashboard_url,'https://proof.example/dashboard/payments/payments/invoices')
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
  assert.deepEqual(owned.payments,[{payment:{id:'claim',currency:'USD',captured_amount:10000,refunded_amount:0,state:'captured',receipt_url:'https://example.com/receipt'},refunds:[{id:'refund:claim',amount:1000,status:'pending',note:null}],order:null}])
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
  await assert.rejects(()=>paymentsReconcile.run({name:'payments:reconcile',payload:{},context:{cloudflare:{env:{DB:db}}}}),/Stripe configuration is required for outstanding Payments reconciliation/u)
 }finally{await runtime.dispose()}
})

test('tenant deletion refuses a connected account retained for another tenant without changing acceptance state', {timeout:120000},async()=>{
 const {db,runtime}=await boot();try{
  await payable(db,'retention-conflict')
  await db.prepare("INSERT INTO stripe_connected_accounts(id,organization_id,stripe_account_id,country,livemode,status,card_payments_status,requirements_json,created_at,updated_at)VALUES('connected',?,'acct_seller','US',0,'ready','active','[]',?,?)").bind(ORG,NOW,NOW).run()
  await db.prepare("INSERT INTO payment_servicing_tenants(organization_id,stripe_account_id,livemode,retained_at)VALUES('deleted-other-tenant','acct_seller',0,?)").bind(NOW).run()
  await db.prepare("INSERT INTO payment_billing_accounts(organization_id,stripe_billing_customer_id,contract_start_at,currency,status,updated_at)VALUES(?,'cus_billing',?,'USD','active',?)").bind(ORG,NOW,NOW).run()
  await assert.rejects(()=>retainPaymentsForTenantDeletion(db,ORG),/conflicting Payments servicing ownership/u)
  assert.equal(await db.prepare('SELECT organization_id FROM payment_servicing_tenants WHERE stripe_account_id=? AND livemode=0').bind('acct_seller').first('organization_id'),'deleted-other-tenant')
  assert.equal(await db.prepare('SELECT stripe_account_id FROM stripe_connected_accounts WHERE organization_id=?').bind(ORG).first('stripe_account_id'),'acct_seller')
  assert.equal(await db.prepare('SELECT id FROM organization WHERE id=?').bind(ORG).first('id'),ORG)
  assert.equal(await db.prepare("SELECT status FROM payment_checkout_holds WHERE payment_id='retention-conflict'").first('status'),'active')
  assert.equal(await db.prepare('SELECT status FROM payment_billing_accounts WHERE organization_id=?').bind(ORG).first('status'),'active')
 }finally{await runtime.dispose()}
})

test('reconciliation releases expired capacity and reports missing provider configuration for outstanding work', {timeout:120000},async()=>{
 const {db,runtime}=await boot();try{
  await payable(db,'expired','2000-01-01T00:00:00.000Z')
  await assert.rejects(()=>paymentsReconcile.run({name:'payments:reconcile',payload:{},context:{cloudflare:{env:{DB:db}}}}),/Stripe configuration is required for outstanding Payments reconciliation/u)
  assert.equal(await db.prepare("SELECT status FROM payment_checkout_holds WHERE payment_id='expired'").first('status'),'released')
  const booking=await claimSessionCapacity(db,{organizationId:ORG,productId:'product',sessionId:'session',productVariantId:'variant',partySize:1})
  assert.equal(await db.prepare('SELECT party_size FROM bookings WHERE id=?').bind(booking.bookingId).first('party_size'),1)
 }finally{await runtime.dispose()}
})

test('failed historical reconciliation rotates later payments while reporting every Stripe failure', {timeout:120000},async(t)=>{
 const {db,runtime}=await boot();try{
  const historical=Array.from({length:26},(_,index)=>({id:`historical-${String(index).padStart(2,'0')}`,intent:`pi_historical_${String(index).padStart(2,'0')}`,updatedAt:new Date(Date.parse(NOW)+index*1000).toISOString()}))
  await db.batch(historical.map(payment=>db.prepare("INSERT INTO payments(id,organization_id,buyer_user_id,stripe_account_id,livemode,subject_type,currency,amount,captured_amount,state,stripe_payment_intent_id,price_snapshot_json,created_at,updated_at)VALUES(?,?,'guest','acct_seller',0,'order','USD',10000,10000,'captured',?,?,?,?)").bind(payment.id,ORG,payment.intent,JSON.stringify({price:{unit_amount:10000,currency:'USD'},quantity:1}),NOW,payment.updatedAt)))
  const before=(await db.prepare('SELECT * FROM payments ORDER BY id').all()).results
  assert.equal(before.length,26)
  assert.deepEqual(before.map(payment=>({id:payment.id,intent:payment.stripe_payment_intent_id,updatedAt:payment.updated_at})),historical)
  const requests:string[]=[],originalFetch=globalThis.fetch
  t.mock.method(globalThis,'fetch',async(input,init)=>{
   const url=new URL(input instanceof Request?input.url:String(input))
   if(url.origin!=='https://api.stripe.com')return originalFetch(input,init)
   assert.equal(init?.method,'GET')
   assert.equal(new Headers(init?.headers).get('stripe-account'),'acct_seller')
   assert.match(url.pathname,/^\/v1\/payment_intents\/pi_historical_\d{2}$/u)
   const intent=url.pathname.split('/').at(-1)!
   requests.push(intent)
   return Response.json({error:{type:'invalid_request_error',code:'resource_missing',message:`No such payment_intent: '${intent}'`}},{status:404,headers:{'stripe-should-retry':'false'}})
  })
  const run={name:'payments:reconcile',payload:{},context:{cloudflare:{env:{DB:db,STRIPE_SECRET_KEY:'sk_test_reconciliation_boundary'}}}}
  const snapshots=[before]
  for(let pass=0;pass<2;pass++){
   const started=Date.now(),offset=requests.length
   await assert.rejects(()=>paymentsReconcile.run(run),error=>{
    assert.ok(error instanceof AggregateError)
    assert.equal(error.message,'Payments reconciliation has unresolved provider failures')
    assert.equal(error.errors.length,25)
    for(const failure of error.errors){assert.ok(failure instanceof Stripe.errors.StripeInvalidRequestError);assert.equal(failure.code,'resource_missing')}
    return true
   })
   const finished=Date.now(),requested=requests.slice(offset)
   if(pass===0)assert.deepEqual(requested,historical.slice(0,25).map(payment=>payment.intent))
   else{assert.equal(requested.length,25);assert.equal(requested[0],historical[25]!.intent)}
   const after=(await db.prepare('SELECT * FROM payments ORDER BY id').all()).results
   assert.equal(after.length,26)
   assert.deepEqual(after.map(({updated_at,...payment})=>payment),before.map(({updated_at,...payment})=>payment))
   for(const [index,payment] of after.entries()){
    const previous=snapshots[pass]![index]!
    if(!requested.includes(String(payment.stripe_payment_intent_id))){assert.equal(payment.updated_at,previous.updated_at);continue}
    assert.equal(typeof payment.updated_at,'string')
    const updated=Date.parse(String(payment.updated_at))
    assert.ok(updated>=started&&updated<=finished)
    assert.ok(updated>Date.parse(String(previous.updated_at)))
   }
   snapshots.push(after)
  }
 }finally{await runtime.dispose()}
})

test('owner-serviced credits leave the usage batch without hiding credits or starving later delivery', {timeout:120000},async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-05T00:00:00.000Z')})
 const {db,runtime}=await boot();try{
  const customer='11111111-1111-4111-8111-111111111111',contractId='22222222-2222-4222-8222-222222222222',rateCard='33333333-3333-4333-8333-333333333333'
  const start='2026-09-01T00:00:00.000Z',occurred='2026-09-30T23:00:00.000Z'
  await db.prepare("INSERT INTO payment_billing_accounts(organization_id,stripe_billing_customer_id,metronome_customer_id,metronome_contract_id,contract_start_at,currency,status,updated_at)VALUES(?,'cus_operating',?,?,?,'USD','servicing',?)").bind(ORG,customer,contractId,start,NOW).run()
  const credits=Array.from({length:100},(_,index)=>({id:`credit-${String(index).padStart(3,'0')}`,source:`fee-credit:${index}`,createdAt:new Date(Date.parse(NOW)+index*1000).toISOString()}))
  await db.batch(credits.map(credit=>db.prepare("INSERT INTO payment_usage_events(id,organization_id,kind,currency,amount,source_id,provider_occurred_at,created_at)VALUES(?,?,'stripe_cost_adjustment','USD',-100,?,?,?)").bind(credit.id,ORG,credit.source,occurred,credit.createdAt)))
  await db.prepare("INSERT INTO payment_usage_events(id,organization_id,kind,currency,amount,source_id,provider_occurred_at,created_at)VALUES('billable',?,'captured_volume','USD',10000,'capture:billable',?,?)").bind(ORG,NOW,new Date(Date.parse(NOW)+100000).toISOString()).run()
  const before=(await db.prepare('SELECT * FROM payment_usage_events ORDER BY created_at').all()).results
  assert.equal(before.length,101)
  assert.deepEqual(before.map(event=>event.id),[...credits.map(credit=>credit.id),'billable'])
  const native={id:contractId,customer_id:customer,uniqueness_key:`payments:${ORG}`,rate_card_id:rateCard,starting_at:start,customer_billing_provider_configuration:{customer_id:customer,billing_provider:'stripe',delivery_method:'direct_to_billing_provider',configuration:{stripe_customer_id:'cus_operating',stripe_collection_method:'charge_automatically'},delivery_method_configuration:{stripe_account_id:'acct_platform'}}}
  const invoice={id:'44444444-4444-4444-8444-444444444444',customer_id:customer,contract_id:contractId,type:'USAGE',status:'FINALIZED',start_timestamp:start,end_timestamp:NOW,credit_type:{id:'55555555-5555-4555-8555-555555555555',name:'USD (cents)'},total:10000,external_invoice:null}
  let ended=true
  const ingests:unknown[][]=[],creditReads:string[]=[],originalFetch=globalThis.fetch
  // External reads are inputs; failed writes never fabricate native acceptance or settlement.
  t.mock.method(globalThis,'fetch',async(input,init)=>{
   const url=new URL(input instanceof Request?input.url:String(input))
   if(url.origin==='https://api.metronome.com'){
    const body=init?.body?JSON.parse(String(init.body)):undefined
    const readContract={...native,...(ended?{ending_before:'2026-10-02T00:00:00.000Z'}:{})}
    if(url.pathname==='/v2/contracts/get'){assert.equal(init?.method,'POST');assert.deepEqual(body,{customer_id:customer,contract_id:contractId});return Response.json({data:readContract})}
    if(url.pathname==='/v2/contracts/list'){assert.equal(init?.method,'POST');assert.deepEqual(body,{customer_id:customer,limit:20});return Response.json({data:[readContract]})}
    if(url.pathname===`/v1/customers/${customer}/invoices`){assert.equal(init?.method,'GET');assert.equal(url.searchParams.get('contract_id'),contractId);return Response.json({data:[invoice]})}
    assert.equal(url.pathname,'/v1/ingest')
    assert.equal(init?.method,'POST')
    assert.ok(Array.isArray(body))
    ingests.push(body)
    return Response.json({message:'Ingest unavailable at the external test boundary'},{status:503})
   }
   if(url.origin==='https://api.stripe.com'){
    assert.equal(init?.method,'GET')
    if(url.pathname==='/v1/account')return Response.json({id:'acct_platform',object:'account',livemode:false})
    assert.equal(url.pathname,'/v1/credit_notes/cn_owner_credit')
    creditReads.push(url.pathname)
    return Response.json({error:{type:'invalid_request_error',code:'resource_missing',message:'No such credit_note'}},{status:404,headers:{'stripe-should-retry':'false'}})
   }
   return originalFetch(input,init)
  })
  const env={DB:db,STRIPE_SECRET_KEY:'sk_test_credit_boundary',METRONOME_API_KEY:'metronome_external_boundary',METRONOME_RATE_CARD_ID:rateCard} as CloudflareEnv
  const began=Date.now()
  assert.deepEqual(await deliverPaymentsUsage(db,env,ORG),{delivered:0})
  const finished=Date.now(),after=(await db.prepare('SELECT * FROM payment_usage_events ORDER BY created_at').all()).results
  assert.equal(after.length,101)
  assert.deepEqual(after.map(({error,dead_letter_at,...event})=>event),before.map(({error,dead_letter_at,...event})=>event))
  const error='Closed-period actual-cost credit requires native Stripe credit memo settlement; retained for owner servicing'
  for(const event of after.slice(0,100)){assert.equal(event.error,error);assert.equal(typeof event.dead_letter_at,'string');assert.ok(Date.parse(String(event.dead_letter_at))>=began&&Date.parse(String(event.dead_letter_at))<=finished)}
  assert.deepEqual(after[100],before[100])
  assert.equal(ingests.length,0)
  const status=await paymentsUsageStatus(db,env,ORG)
  assert.equal(status.account?.status,'closed')
  assert.deepEqual(status.pending,[{currency:'USD',kind:'captured_volume',event_count:1,amount:10000,billing_amount:10000,invalid_basis:0,error:null},{currency:'USD',kind:'stripe_cost_adjustment',event_count:100,amount:-10000,billing_amount:-10000,invalid_basis:0,error}])
  assert.deepEqual(status.credits.map(event=>({id:event.id,source_id:event.source_id,amount:event.amount,error:event.error})),credits.map(credit=>({id:credit.id,source_id:credit.source,amount:-100,error})))
  // A subsequent native read reports the same contract open; held credits stay owner-serviced.
  ended=false
  for(let attempt=0;attempt<2;attempt++)await assert.rejects(()=>deliverPaymentsUsage(db,env,ORG),failure=>{assert.ok(failure instanceof HTTPError);assert.equal(failure.status,502);assert.equal(failure.data?.provider_status,503);return true})
  assert.equal(ingests.length,2)
  assert.deepEqual(ingests[1],ingests[0])
  assert.equal(ingests[0]?.length,1)
  const ingest=ingests[0]?.[0] as {customer_id:string;timestamp:string;event_type:string;properties:Record<string,string>}
  assert.equal(ingest.customer_id,customer)
  assert.equal(ingest.timestamp,NOW)
  assert.equal(ingest.event_type,'payments_captured_volume')
  assert.equal(ingest.properties.payment_source,'capture:billable')
  assert.equal(ingest.properties.amount_minor,'10000')
  await assert.rejects(()=>reconcileNativeBillingCredit(db,getStripe(env),env,{organizationId:ORG,userId:'verified',role:'owner'},credits[0]!.id,'cn_owner_credit'),failure=>{assert.ok(failure instanceof Stripe.errors.StripeInvalidRequestError);assert.equal(failure.code,'resource_missing');return true})
  assert.deepEqual(creditReads,['/v1/credit_notes/cn_owner_credit'])
  const retained=(await db.prepare('SELECT * FROM payment_usage_events ORDER BY created_at').all()).results
  assert.equal(retained.length,101)
  assert.deepEqual(retained.slice(0,100),after.slice(0,100))
  assert.equal(retained[100]?.delivery_at,null)
  assert.equal(retained[100]?.dead_letter_at,null)
  assert.equal(retained[100]?.billing_timestamp,NOW)
  assert.match(String(retained[100]?.error),/Metronome request failed \(503\)/u)
 }finally{await runtime.dispose()}
})
