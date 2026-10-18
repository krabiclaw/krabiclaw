import type Stripe from 'stripe'
import type { CloudflareEnv } from '~/server/utils/auth'
import { refreshMemberBusy } from '~/server/domain/member-scheduling'
import { reservationClaimQuery } from '~/server/utils/reservations'
import { notifyTableReservationCreated } from '~/server/domain/table-reservations'
import { localNow } from '~/utils/timezone'
import { notifyProductBookingCreated } from '~/server/domain/product-bookings'
import { execute, executeBatch, queryAll, queryFirst, type DbClient, type BatchQuery } from '~/server/db'
import { isRecord } from '~/server/utils/type-guards'
import { sessionClaimQuery, sessionAssignmentQuery } from '~/server/utils/availability'
import { processStripeWebhookEvent } from '~/server/utils/stripe-webhook-events'
import { platformLivemode } from '~/server/utils/stripe-connect'
import { executeRefund, reconcileRefundState, requirePayment, assertMinorAmount, type Payment } from './index'
import { notifyPaymentFinancialEvent, reconcilePayoutEvent } from './notifications'
import { recordPaymentPaid } from '~/server/domain/booking-analytics'
import { notifyStayBooked, raiseSettledFailures } from '~/server/utils/notifications'
import { paymentsBillingBasis } from './fx'
import { deliverPaymentsUsage } from './usage'
import { isStayPurchase } from './checkout'
import { completeStayFromCheckout, isStayNightConflict, stayFromCheckoutQueries } from '~/server/domain/stays'

interface Hold {
  id:string; organization_id:string; product_id:string|null; variant_id:string|null; session_id:string|null; location_id:string|null; timezone:string|null
  buyer_user_id:string|null; request_id:string|null; quantity:number; status:string; expires_at:string; converted_booking_id:string|null; assigned_member_id:string|null; starts_at:string; ends_at:string
}
/** Provider retrieval, account/mode and frozen money checks precede every conversion; the paid analytics event and usage billing follow it. */
export async function reconcilePaymentIntent(db:DbClient,stripe:Stripe,payment:Payment,intent:Stripe.PaymentIntent, env:CloudflareEnv) {
  const captured:{savedCard?:boolean}={}
  await settlePaymentIntent(db,stripe,payment,intent,env,captured)
  if(captured.savedCard===undefined)return
  await recordPaymentPaid(db,await requirePayment(db,payment.organization_id,payment.id),intent.id,captured.savedCard)
  // The capture's usage event is billed now. A failed delivery fails the webhook
  // and Stripe redelivers; the capture itself is idempotent on replay.
  await deliverPaymentsUsage(db,env,payment.organization_id)
}
async function settlePaymentIntent(db:DbClient,stripe:Stripe,payment:Payment,intent:Stripe.PaymentIntent, env:CloudflareEnv, captured:{savedCard?:boolean}) {
  if (intent.livemode !== Boolean(payment.livemode) || intent.currency.toUpperCase() !== payment.currency || intent.metadata.krabiclaw_payment_id !== payment.id || (payment.stripe_payment_intent_id && payment.stripe_payment_intent_id !== intent.id)) throw new Error('Stripe PaymentIntent financial identity mismatch')
  // The intent is the one this purchase opened, on this account and mode; what it charged is Stripe's.
  const attempt=await queryFirst<{id:string}>(db,'SELECT id FROM payment_attempts WHERE payment_id=? AND stripe_payment_intent_id=? LIMIT 1',[payment.id,intent.id])
  if(!attempt) throw new Error('PaymentIntent is not an authorized purchase attempt')
  const snapshot=JSON.parse(payment.price_snapshot_json) as {billing_fx?:unknown}
  const now = new Date().toISOString()
  if (intent.status !== 'succeeded') {
    if (intent.status === 'processing') {
      await execute(db,"UPDATE payment_checkout_holds SET expires_at=? WHERE payment_id=? AND status='active'",[new Date(Date.now()+14*86400*1000).toISOString(),payment.id])
    }
    // A declined confirmation can accept another method; only cancellation is terminal.
    if (intent.status === 'canceled') {
      await executeBatch(db,[{query:"UPDATE payments SET state='failed',updated_at=? WHERE id=? AND captured_amount=0",params:[now,payment.id]},{query:"UPDATE payment_checkout_holds SET status='released' WHERE payment_id=? AND status='active'",params:[payment.id]}])
    }
    if (intent.status === 'requires_payment_method' && intent.last_payment_error) await notifyPaymentFinancialEvent(db,stripe,env,payment,{kind:'payment_failed',nativeId:intent.id,status:intent.status,amount:intent.amount})
    return
  }
  if (intent.application_fee_amount) throw new Error('Direct charges carry no application fee')
  const chargeId=typeof intent.latest_charge==='string'?intent.latest_charge:intent.latest_charge?.id
  const charge=chargeId?await stripe.charges.retrieve(chargeId,{}, {stripeAccount:payment.stripe_account_id}):null
  if(!charge || charge.livemode!==Boolean(payment.livemode) || charge.payment_intent!==intent.id || charge.amount!==intent.amount_received) throw new Error('Captured charge financial scope mismatch')
  const billingBasis = paymentsBillingBasis(intent.amount_received, payment.currency, snapshot.billing_fx)
  await executeBatch(db,[
    {query:'UPDATE payments SET stripe_charge_id=?,receipt_url=?,surcharge_amount=? WHERE id=?',params:[charge.id,charge.receipt_url,(intent as Stripe.PaymentIntent&{amount_details?:{surcharge?:{amount?:number}}}).amount_details?.surcharge?.amount??0,payment.id]},
    {query:"UPDATE payments SET stripe_payment_intent_id=?,captured_amount=?,tax_amount=?,state=CASE WHEN state IN ('refunded','recovery') THEN state ELSE 'captured' END,updated_at=? WHERE id=? AND organization_id=?",params:[intent.id,intent.amount_received,0,now,payment.id,payment.organization_id]},
    // Usage is billed in the platform's mode only: a demo's test-mode capture on a live platform is never billable volume.
    ...(Boolean(payment.livemode)===platformLivemode(env)?[{query:"INSERT OR IGNORE INTO payment_usage_events(id,organization_id,payment_id,kind,currency,amount,billing_basis_json,source_id,provider_occurred_at,created_at) VALUES(?,?,?,'captured_volume',?,?,?,?,?,?)",params:[crypto.randomUUID(),payment.organization_id,payment.id,payment.currency,intent.amount_received,JSON.stringify(billingBasis),`capture:${payment.stripe_account_id}:${payment.livemode}:${intent.id}`,new Date(charge.created*1000).toISOString(),now]}]:[]),
  ],{operation:'Record authenticated capture and usage'})
  const recorded = await requirePayment(db,payment.organization_id,payment.id)
  // A card offered from the buyer's saved ones existed before this intent did.
  const methodId=typeof charge.payment_method==='string'?charge.payment_method:null
  const method=intent.customer&&methodId?await stripe.paymentMethods.retrieve(methodId,{}, {stripeAccount:payment.stripe_account_id}):null
  captured.savedCard=Boolean(method&&method.created<intent.created)
  const capture={kind:'payment_captured' as const,nativeId:intent.id,status:intent.status,amount:intent.amount_received,email:charge.billing_details.email??null}
  if(recorded.state==='recovery'){
    const outcomes=await Promise.allSettled([executeRefund(db,stripe,recorded,null,`unfulfillable:${intent.id}`,'requested_by_customer',null,env),notifyPaymentFinancialEvent(db,stripe,env,recorded,capture)])
    raiseSettledFailures('Unfulfillable payment recovery',payment.id,outcomes,['refund','capture notification'])
    return
  }
  if (payment.subject_type === 'stay' && recorded.state !== 'refunded' && recorded.refunded_amount === 0) { await settleStayPayment(db, stripe, env, recorded, intent, capture); return }
  if (recorded.state === 'refunded' || recorded.refunded_amount > 0 || !['booking', 'reservation'].includes(payment.subject_type)) {await notifyPaymentFinancialEvent(db,stripe,env,recorded,capture);return}
  const hold = await queryFirst<Hold>(db,'SELECT * FROM payment_checkout_holds WHERE payment_id=? AND organization_id=?',[payment.id,payment.organization_id])
  if (!hold || !hold.request_id) throw new Error('Captured visit payment has no durable hold and guest request')
  if (hold.status !== 'converted') {
    const subjectId = crypto.randomUUID()
    let claim: BatchQuery
    const assignment: BatchQuery[] = []
    const kind = payment.subject_type === 'booking' ? 'booking' : 'reservation'
    const table = kind === 'booking' ? 'bookings' : 'reservations'
    const convertedColumn = kind === 'booking' ? 'converted_booking_id' : 'converted_reservation_id'
    if (kind === 'booking') {
      if (!hold.product_id || !hold.variant_id || !hold.session_id) throw new Error('Booking hold has no offering or session')
      if (hold.assigned_member_id) await refreshMemberBusy(db,env,hold.assigned_member_id,true)
      claim = await sessionClaimQuery(db, {bookingId:subjectId,organizationId:hold.organization_id,productId:hold.product_id,sessionId:hold.session_id,productVariantId:hold.variant_id,partySize:hold.quantity,userId:hold.buyer_user_id,requestId:hold.request_id,now,capturedPaymentId:payment.id,capturedAt:new Date(charge.created*1000).toISOString()})
      assignment.push(sessionAssignmentQuery(hold.session_id, hold.organization_id, subjectId))
    } else {
      if (hold.product_id || !hold.location_id || !hold.timezone) throw new Error('Reservation hold has invalid location facts')
      const local = localNow(hold.timezone, new Date(hold.starts_at))
      claim = await reservationClaimQuery(db, {organizationId:hold.organization_id,locationId:hold.location_id,reservationId:subjectId,requestId:hold.request_id,userId:hold.buyer_user_id,timezone:hold.timezone,startsAt:hold.starts_at,endsAt:hold.ends_at,date:local.date,timeSlot:local.time,partySize:hold.quantity,capturedPaymentId:payment.id,capturedAt:new Date(charge.created*1000).toISOString()})
    }
    let created: boolean
    try {
      const results = await executeBatch(db,[claim, ...assignment,
        {query:`UPDATE payment_checkout_holds SET status='converted',${convertedColumn}=? WHERE id=? AND status IN ('active','released') AND EXISTS(SELECT 1 FROM ${table} WHERE id=?)`,params:[subjectId,hold.id,subjectId]},
        {query:`INSERT INTO activity_entries(id,request_id,kind,scope_kind,actor_kind,event_name,payload_json,dedupe_key,sequence,occurred_at,created_at) SELECT ?,v.request_id,'operation','request','system',?,json_object(?,v.id,'request_id',v.request_id,'afterStatus',v.status,'payment_id',?,'intent',?),?,COALESCE((SELECT MAX(sequence) FROM activity_entries WHERE request_id=v.request_id),0)+1,?,? FROM ${table} v WHERE v.id=? AND v.request_id IS NOT NULL ON CONFLICT(dedupe_key) DO NOTHING`,params:[crypto.randomUUID(),`${kind}.created`,`operational_${kind}_id`,payment.id,`${kind}.created`,`${kind}:${subjectId}:created`,now,now,subjectId]},
        {query:`UPDATE payments SET subject_id=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM ${table} WHERE id=?)`,params:[subjectId,now,payment.id,subjectId]},
        {query:`UPDATE requests SET conversation_state='needs_attention',payload_json=json_set(payload_json,'$.payment.state','captured'),updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM ${table} WHERE id=?)`,params:[now,hold.request_id,subjectId]},
      ],{operation:'Convert authenticated visit payment'})
      created = results[0]?.meta.changes === 1
    } catch (error) {
      const converted = await queryFirst<{status:string}>(db, 'SELECT status FROM payment_checkout_holds WHERE id=?', [hold.id])
      if (converted?.status !== 'converted') throw error
      created = true
    }
    if (!created) {
      const converted = await queryFirst<{status:string}>(db,'SELECT status FROM payment_checkout_holds WHERE id=?',[hold.id])
      if (converted?.status !== 'converted') {
        await executeBatch(db,[{query:"UPDATE payment_checkout_holds SET status='released' WHERE id=? AND status='active'",params:[hold.id]},{query:"UPDATE payments SET state='recovery',updated_at=? WHERE id=?",params:[now,payment.id]}])
        const outcomes=await Promise.allSettled([executeRefund(db,stripe,await requirePayment(db,payment.organization_id,payment.id),null,`unfulfillable:${intent.id}`,'requested_by_customer',null,env),notifyPaymentFinancialEvent(db,stripe,env,recorded,capture)])
        raiseSettledFailures('Unfulfillable payment recovery',payment.id,outcomes,['refund','capture notification'])
        return
      }
    }
  }
  if(!await queryFirst(db,'SELECT id FROM organization WHERE id=?',[payment.organization_id])&&await queryFirst(db,'SELECT organization_id FROM payment_servicing_tenants WHERE organization_id=? AND stripe_account_id=? AND livemode=?',[payment.organization_id,payment.stripe_account_id,payment.livemode])){await notifyPaymentFinancialEvent(db,stripe,env,recorded,capture);return}
    const outcomes=await Promise.allSettled([notifyPaymentFinancialEvent(db,stripe,env,await requirePayment(db,payment.organization_id,payment.id),capture),payment.subject_type === 'booking' ? notifyProductBookingCreated(env,db,hold.organization_id,hold.request_id) : notifyTableReservationCreated(env,db,hold.organization_id,hold.request_id)])
  raiseSettledFailures('Captured visit delivery',payment.id,outcomes,['capture notification','booking creation notification'])
  await execute(db,"UPDATE requests SET payload_json=json_set(payload_json,'$.provenance.followups_completed',json('true')) WHERE id=? AND organization_id=? AND json_type(payload_json,'$.provenance')='object'",[hold.request_id,hold.organization_id])
}

/**
 * A captured stay payment becomes its confirmed direct stay: the hold's nights
 * pass to the stay in one batch. A night someone else holds by then refunds the
 * guest in full. A replay finds the hold converted and repeats only the
 * idempotent follow-ups: channel push, realtime and notifications.
 */
async function settleStayPayment(db: DbClient, stripe: Stripe, env: CloudflareEnv, payment: Payment, intent: Stripe.PaymentIntent, capture: Parameters<typeof notifyPaymentFinancialEvent>[4]) {
  if (!await queryFirst(db, 'SELECT id FROM organization WHERE id=?', [payment.organization_id])) { await notifyPaymentFinancialEvent(db, stripe, env, payment, capture); return }
  const hold = await queryFirst<{ id: string; product_id: string | null; session_id: string | null; location_id: string | null; status: string; converted_stay_id: string | null; buyer_user_id: string | null }>(db,
    'SELECT id, product_id, session_id, location_id, status, converted_stay_id, buyer_user_id FROM payment_checkout_holds WHERE payment_id=? AND organization_id=?', [payment.id, payment.organization_id])
  if (!hold || !hold.product_id || hold.session_id || !hold.location_id) throw new Error('Captured stay payment has no stay hold')
  const snapshot: unknown = JSON.parse(payment.price_snapshot_json)
  const purchase = isRecord(snapshot) ? snapshot.stay : undefined
  if (!isStayPurchase(purchase) || purchase.product_id !== hold.product_id || purchase.total_minor !== payment.amount) throw new Error('Captured stay payment has no valid stay purchase')
  let stayId = hold.converted_stay_id
  if (hold.status !== 'converted') {
    const candidate = crypto.randomUUID()
    const now = new Date().toISOString()
    let created = false
    try {
      const results = await executeBatch(db, [
        ...stayFromCheckoutQueries({ organizationId: payment.organization_id, locationId: hold.location_id, stayId: candidate, holdId: hold.id, paymentId: payment.id, buyerUserId: payment.buyer_user_id ?? hold.buyer_user_id, now, stay: { quote: purchase, guest: purchase.guest } }),
        { query: "UPDATE payment_checkout_holds SET status='converted', converted_stay_id=? WHERE id=? AND status IN ('active','released') AND EXISTS(SELECT 1 FROM stays WHERE id=?)", params: [candidate, hold.id, candidate] },
        { query: 'UPDATE payments SET subject_id=?, updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM stays WHERE id=?)', params: [candidate, now, payment.id, candidate] },
      ], { operation: 'Convert captured stay payment' })
      created = results[1]?.meta.changes === 1
      if (created) stayId = candidate
    } catch (error) {
      if (!isStayNightConflict(error) && !/UNIQUE constraint failed: stays\.organization_id, stays\.idempotency_key/.test(error instanceof Error ? error.message : String(error))) throw error
    }
    if (!created) {
      const converted = await queryFirst<{ status: string; converted_stay_id: string | null }>(db, 'SELECT status, converted_stay_id FROM payment_checkout_holds WHERE id=?', [hold.id])
      if (converted?.status === 'converted' && converted.converted_stay_id) stayId = converted.converted_stay_id
      else {
        await executeBatch(db, [{ query: "UPDATE payment_checkout_holds SET status='released' WHERE id=? AND status='active'", params: [hold.id] }, { query: "UPDATE payments SET state='recovery',updated_at=? WHERE id=?", params: [now, payment.id] }])
        const outcomes = await Promise.allSettled([executeRefund(db, stripe, await requirePayment(db, payment.organization_id, payment.id), null, `unfulfillable:${intent.id}`, 'requested_by_customer', null, env), notifyPaymentFinancialEvent(db, stripe, env, payment, capture)])
        raiseSettledFailures('Unfulfillable stay payment recovery', payment.id, outcomes, ['refund', 'capture notification'])
        return
      }
    }
  }
  if (!stayId) throw new Error('Converted stay hold has no stay')
  const outcomes = await Promise.allSettled([
    completeStayFromCheckout(db, env, payment.organization_id, stayId),
    requirePayment(db, payment.organization_id, payment.id).then(recorded => notifyPaymentFinancialEvent(db, stripe, env, recorded, capture)),
    notifyStayBooked(env, db, payment.organization_id, stayId),
  ])
  raiseSettledFailures('Captured stay completion', payment.id, outcomes, ['channel and publication', 'capture notification', 'stay confirmation'])
}

export function paymentEventKey(event:Pick<Stripe.Event,'id'|'account'|'livemode'>):string{return `payments:${event.account??'unscoped'}:${Number(event.livemode)}:${event.id}`}
export async function processPaymentEvent(db:DbClient,stripe:Stripe,event:Stripe.Event,env:CloudflareEnv) {
  if(!['payment_intent.','refund.','charge.dispute.','payout.'].some(prefix=>event.type.startsWith(prefix)))return true
  const object=event.data.object as {id?:string;metadata?:Record<string,string>|null}
  const payload=JSON.stringify({id:event.id,type:event.type,account:event.account,livemode:event.livemode,data:{object:{id:object.id,metadata:{krabiclaw_payment_id:object.metadata?.krabiclaw_payment_id}}}})
  return await processStripeWebhookEvent(db,{id:paymentEventKey(event),type:event.type,payload,processor:'tenant_payments'},async()=>{
    if (!event.account) throw new Error('Tenant payment event requires connected account context')
    const mappings = await queryAll<{organization_id:string;livemode:number}>(db,'SELECT organization_id,livemode FROM stripe_connected_accounts WHERE stripe_account_id=? AND livemode=? UNION SELECT organization_id,livemode FROM payment_servicing_tenants WHERE stripe_account_id=? AND livemode=? LIMIT 2',[event.account,Number(event.livemode),event.account,Number(event.livemode)])
    if(mappings.length>1)throw new Error('Stripe connected account has ambiguous tenant attribution')
    const connected=mappings[0]
    if (!connected) return
    if (Boolean(connected.livemode) !== event.livemode) throw new Error('Stripe connected event mode mismatch')
    if(event.type.startsWith('payout.')) {
      if(event.type!=='payout.paid'&&event.type!=='payout.failed')return
      await reconcilePayoutEvent(db,stripe,env,{organizationId:connected.organization_id,stripeAccountId:event.account,livemode:event.livemode},event)
      return
    }
    if (event.type.startsWith('payment_intent.')) {
      const object = event.data.object as Stripe.PaymentIntent
      const id = object.metadata.krabiclaw_payment_id
      if (!id) return
      const payment = await requirePayment(db,connected.organization_id,id)
      if (payment.stripe_account_id!==event.account || Boolean(payment.livemode)!==event.livemode) throw new Error('Payment event account mismatch')
      await reconcilePaymentIntent(db,stripe,payment,await stripe.paymentIntents.retrieve(object.id,{}, {stripeAccount:event.account}),env)
      return
    }
    if (event.type.startsWith('refund.')) {
      const object = event.data.object as Stripe.Refund
      const refund = await stripe.refunds.retrieve(object.id,{}, {stripeAccount:event.account})
      const intentId = typeof refund.payment_intent==='string'?refund.payment_intent:refund.payment_intent?.id
      const payment = await queryFirst<Payment>(db,'SELECT * FROM payments WHERE stripe_account_id=? AND livemode=? AND stripe_payment_intent_id=?',[event.account,Number(event.livemode),intentId])
      if (!payment) return
      await reconcileRefundState(db,stripe,payment,refund,env)
      return
    }
    if (event.type.startsWith('charge.dispute.')) {
      const object=event.data.object as Stripe.Dispute
      const dispute=await stripe.disputes.retrieve(object.id,{}, {stripeAccount:event.account})
      const intentId=typeof dispute.payment_intent==='string'?dispute.payment_intent:dispute.payment_intent?.id
      const payment=await queryFirst<Payment>(db,'SELECT * FROM payments WHERE stripe_account_id=? AND livemode=? AND stripe_payment_intent_id=?',[event.account,Number(event.livemode),intentId])
      if (!payment) return
      await reconcileDisputeState(db,stripe,payment,dispute,env)
    }
  })
}

export async function reconcileDisputeState(db:DbClient,stripe:Stripe,payment:Payment,dispute:Stripe.Dispute,env:CloudflareEnv) {
 const intentId=typeof dispute.payment_intent==='string'?dispute.payment_intent:dispute.payment_intent?.id
 if(dispute.livemode!==Boolean(payment.livemode)||dispute.currency.toUpperCase()!==payment.currency||intentId!==payment.stripe_payment_intent_id)throw new Error('Dispute native financial identity mismatch')
 assertMinorAmount(dispute.amount,false)
 await execute(db,`INSERT INTO payment_disputes(id,payment_id,stripe_dispute_id,amount,currency,reason,status,evidence_due_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(payment_id,stripe_dispute_id) DO UPDATE SET status=excluded.status,evidence_due_at=excluded.evidence_due_at,updated_at=excluded.updated_at`,[crypto.randomUUID(),payment.id,dispute.id,dispute.amount,payment.currency,dispute.reason,dispute.status,dispute.evidence_details.due_by?new Date(dispute.evidence_details.due_by*1000).toISOString():null,new Date().toISOString()])
 const kind=dispute.status==='needs_response'||dispute.status==='warning_needs_response'?'dispute_needs_response':dispute.status==='won'?'dispute_won':dispute.status==='lost'?'dispute_lost':dispute.status==='warning_closed'||dispute.status==='prevented'?'dispute_closed':null
 if(kind)await notifyPaymentFinancialEvent(db,stripe,env,payment,{kind,nativeId:dispute.id,status:dispute.status,amount:dispute.amount,responseDueBy:dispute.evidence_details.due_by?`${new Intl.DateTimeFormat('en-US',{timeZone:'UTC',dateStyle:'medium',timeStyle:'short'}).format(new Date(dispute.evidence_details.due_by*1000))} UTC`:null})
}
