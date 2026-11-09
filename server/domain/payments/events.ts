import type Stripe from 'stripe'
import type { CloudflareEnv } from '~/server/utils/auth'
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
import { isStayPurchase, type StayPurchase } from './checkout'
import { turnoverTaskQueries } from '~/server/domain/tasks'
import { conversationTaskQueries } from '~/server/domain/guest-threads/repository'
import { completeStayFromCheckout, isStayNightConflict, releaseLapsedStayHolds, stayFromCheckoutQueries } from '~/server/domain/stays'

interface Hold {
  id:string; organization_id:string; product_id:string|null; variant_id:string|null; session_id:string|null; location_id:string|null; timezone:string|null
  buyer_user_id:string|null; request_id:string|null; quantity:number; status:string; expires_at:string; converted_booking_id:string|null; assigned_member_id:string|null; starts_at:string; ends_at:string
}
/** Provider retrieval, account/mode and frozen money checks precede every conversion; the paid analytics event and usage billing follow it. */
export async function reconcilePaymentIntent(db:DbClient,stripe:Stripe,payment:Payment,intent:Stripe.PaymentIntent, env:CloudflareEnv):Promise<Stripe.PaymentIntent> {
  const captured:{savedCard?:boolean}={}
  const settled=await settlePaymentIntent(db,stripe,payment,intent,env,captured)
  if(captured.savedCard===undefined)return settled
  await recordPaymentPaid(db,await requirePayment(db,payment.organization_id,payment.id),intent.id,captured.savedCard)
  // The capture's usage event is billed now. A failed delivery fails the webhook
  // and Stripe redelivers; the capture itself is idempotent on replay.
  await deliverPaymentsUsage(db,env,payment.organization_id)
  return settled
}
async function settlePaymentIntent(db:DbClient,stripe:Stripe,payment:Payment,reported:Stripe.PaymentIntent, env:CloudflareEnv, captured:{savedCard?:boolean}):Promise<Stripe.PaymentIntent> {
  if (reported.livemode !== Boolean(payment.livemode) || reported.currency.toUpperCase() !== payment.currency || reported.metadata.krabiclaw_payment_id !== payment.id || payment.stripe_payment_intent_id !== reported.id) throw new Error('Stripe PaymentIntent financial identity mismatch')
  // The intent is the one this purchase opened, on this account and mode; what it charged is Stripe's.
  const snapshot=JSON.parse(payment.price_snapshot_json) as {billing_fx?:unknown}
  const now = new Date().toISOString()
  const intent = reported.status === 'requires_capture' ? await captureOnceBooked(db,stripe,env,payment,reported) : reported
  if (intent.status !== 'succeeded') {
    if (intent.status === 'processing') {
      await execute(db,"UPDATE payment_checkout_holds SET expires_at=? WHERE payment_id=? AND status='active'",[new Date(Date.now()+14*86400*1000).toISOString(),payment.id])
    }
    // A declined confirmation can accept another method; only cancellation is terminal.
    if (intent.status === 'canceled') {
      await execute(db,"UPDATE payment_checkout_holds SET status='released' WHERE payment_id=? AND status='active'",[payment.id])
      if (payment.subject_type === 'stay') await releaseLapsedStayHolds(db, env, payment.id)
      // Stripe cancelled the authorization a booking was committed on, so nothing was paid; the business decides what becomes of the booking.
      if (payment.subject_id && payment.captured_amount === 0) await notifyPaymentFinancialEvent(db,stripe,env,payment,{kind:'payment_failed',nativeId:intent.id,status:intent.status,amount:intent.amount})
    }
    if (intent.status === 'requires_payment_method' && intent.last_payment_error) {
      // A bank debit that failed days later gives back the 14 days it was holding.
      const until=confirmationHoldUntil(payment)
      await execute(db,"UPDATE payment_checkout_holds SET expires_at=? WHERE payment_id=? AND status='active' AND expires_at>?",[until,payment.id,until])
      await notifyPaymentFinancialEvent(db,stripe,env,payment,{kind:'payment_failed',nativeId:intent.id,status:intent.status,amount:intent.amount})
    }
    return intent
  }
  if (intent.application_fee_amount) throw new Error('Direct charges carry no application fee')
  const chargeId=typeof intent.latest_charge==='string'?intent.latest_charge:intent.latest_charge?.id
  const charge=chargeId?await stripe.charges.retrieve(chargeId,{}, {stripeAccount:payment.stripe_account_id}):null
  if(!charge || charge.livemode!==Boolean(payment.livemode) || charge.payment_intent!==intent.id || charge.amount!==intent.amount_received) throw new Error('Captured charge financial scope mismatch')
  const billingBasis = paymentsBillingBasis(intent.amount_received, payment.currency, snapshot.billing_fx)
  // The tax inside the captured amount is Stripe Tax's calculation the intent carried; Stripe records its transaction.
  const taxCalculation=intent.hooks?.inputs?.tax?.calculation
  const calculation=taxCalculation?await stripe.tax.calculations.retrieve(taxCalculation,{},{stripeAccount:payment.stripe_account_id}):null
  const taxAmount=calculation?calculation.tax_amount_exclusive+calculation.tax_amount_inclusive:0
  await executeBatch(db,[
    {query:'UPDATE payments SET stripe_charge_id=?,receipt_url=?,surcharge_amount=? WHERE id=?',params:[charge.id,charge.receipt_url,(intent as Stripe.PaymentIntent&{amount_details?:{surcharge?:{amount?:number}}}).amount_details?.surcharge?.amount??0,payment.id]},
    {query:"UPDATE payments SET stripe_payment_intent_id=?,captured_amount=?,tax_amount=?,updated_at=? WHERE id=? AND organization_id=?",params:[intent.id,intent.amount_received,taxAmount,now,payment.id,payment.organization_id]},
    // Usage is billed in the platform's mode only: a demo's test-mode capture on a live platform is never billable volume.
    ...(Boolean(payment.livemode)===platformLivemode(env)?[{query:"INSERT OR IGNORE INTO payment_usage_events(id,organization_id,payment_id,kind,currency,amount,billing_basis_json,source_id,provider_occurred_at,created_at) VALUES(?,?,?,'captured_volume',?,?,?,?,?,?)",params:[crypto.randomUUID(),payment.organization_id,payment.id,payment.currency,intent.amount_received,JSON.stringify(billingBasis),`capture:${payment.stripe_account_id}:${payment.livemode}:${intent.id}`,new Date(charge.created*1000).toISOString(),now]}]:[]),
  ],{operation:'Record authenticated capture and usage'})
  const recorded = await requirePayment(db,payment.organization_id,payment.id)
  // A card offered from the buyer's saved ones existed before this intent did.
  const methodId=typeof charge.payment_method==='string'?charge.payment_method:null
  const method=intent.customer&&methodId?await stripe.paymentMethods.retrieve(methodId,{}, {stripeAccount:payment.stripe_account_id}):null
  captured.savedCard=Boolean(method&&method.created<intent.created)
  const capture={kind:'payment_captured' as const,nativeId:intent.id,status:intent.status,amount:intent.amount_received,email:charge.billing_details.email??null}
  // Once this purchase has been sent back to the buyer, a redelivery finishes that and never books it.
  if(await queryFirst(db,'SELECT 1 FROM payment_refunds WHERE payment_id=? AND idempotency_key=?',[payment.id,unfulfillableKey(intent)])){await refundUnfulfillable(db,stripe,env,recorded,intent,capture);return intent}
  if (payment.subject_type === 'stay' && recorded.refunded_amount === 0) { await settleStayPayment(db, stripe, env, recorded, intent, capture); return intent }
  if (recorded.refunded_amount > 0 || !['booking', 'reservation'].includes(payment.subject_type)) {await notifyPaymentFinancialEvent(db,stripe,env,recorded,capture);return intent}
  const hold = await queryFirst<Hold>(db,'SELECT * FROM payment_checkout_holds WHERE payment_id=? AND organization_id=?',[payment.id,payment.organization_id])
  if (!hold || !hold.request_id) throw new Error('Captured visit payment has no durable hold and guest request')
  if(!await commitVisit(db,env,payment,hold,new Date(charge.created*1000).toISOString())){await refundUnfulfillable(db,stripe,env,recorded,intent,capture);return intent}
  if(!await queryFirst(db,'SELECT id FROM organization WHERE id=?',[payment.organization_id])&&await queryFirst(db,'SELECT organization_id FROM payment_servicing_tenants WHERE organization_id=? AND stripe_account_id=? AND livemode=?',[payment.organization_id,payment.stripe_account_id,payment.livemode])){await notifyPaymentFinancialEvent(db,stripe,env,recorded,capture);return intent}
    const outcomes=await Promise.allSettled([notifyPaymentFinancialEvent(db,stripe,env,await requirePayment(db,payment.organization_id,payment.id),capture),payment.subject_type === 'booking' ? notifyProductBookingCreated(env,db,hold.organization_id,hold.request_id) : notifyTableReservationCreated(env,db,hold.organization_id,hold.request_id)])
  raiseSettledFailures('Captured visit delivery',payment.id,outcomes,['capture notification','booking creation notification'])
  await execute(db,"UPDATE requests SET payload_json=json_set(payload_json,'$.provenance.followups_completed',json('true')) WHERE id=? AND organization_id=? AND json_type(payload_json,'$.provenance')='object'",[hold.request_id,hold.organization_id])
  return intent
}

/**
 * A card or Link payment is charged only once its booking exists. When the
 * capacity has gone the authorization is cancelled and the buyer is never
 * charged. A capture or cancel that lost a race is not a failure: Stripe's own
 * status says what happened, and the hold finds the same booking.
 */
async function captureOnceBooked(db:DbClient,stripe:Stripe,env:CloudflareEnv,payment:Payment,intent:Stripe.PaymentIntent):Promise<Stripe.PaymentIntent>{
 const account={stripeAccount:payment.stripe_account_id}
 const chargeId=typeof intent.latest_charge==='string'?intent.latest_charge:intent.latest_charge?.id
 const charge=chargeId?await stripe.charges.retrieve(chargeId,{},account):null
 if(!charge||charge.livemode!==Boolean(payment.livemode)||charge.payment_intent!==intent.id)throw new Error('Authorized charge financial scope mismatch')
 const booked=await commitPurchase(db,env,payment,new Date(charge.created*1000).toISOString())
 try{
  return booked?await stripe.paymentIntents.capture(intent.id,{},account):await stripe.paymentIntents.cancel(intent.id,{},account)
 }catch(error){
  if(!(error instanceof stripe.errors.StripeInvalidRequestError)||error.code!=='payment_intent_unexpected_state')throw error
  return await stripe.paymentIntents.retrieve(intent.id,{},account)
 }
}

async function commitPurchase(db:DbClient,env:CloudflareEnv,payment:Payment,chargedAt:string):Promise<boolean>{
 if(payment.subject_type==='stay')return await commitStay(db,payment)!==null
 if(payment.subject_type!=='booking'&&payment.subject_type!=='reservation')return true
 const hold=await queryFirst<Hold>(db,'SELECT * FROM payment_checkout_holds WHERE payment_id=? AND organization_id=?',[payment.id,payment.organization_id])
 if(!hold||!hold.request_id)throw new Error('Authorized visit payment has no durable hold and guest request')
 return await commitVisit(db,env,payment,hold,chargedAt)
}

/** The hold becomes its booking or reservation. True when it is one, now or already; false when its capacity has gone. */
async function commitVisit(db:DbClient,env:CloudflareEnv,payment:Payment,hold:Hold,chargedAt:string):Promise<boolean>{
 if(hold.status==='converted')return true
 if(!hold.request_id)throw new Error('Visit hold has no guest request')
 const now=new Date().toISOString()
 const subjectId = crypto.randomUUID()
 let claim: BatchQuery
 const assignment: BatchQuery[] = []
 const kind = payment.subject_type === 'booking' ? 'booking' : 'reservation'
 const table = kind === 'booking' ? 'bookings' : 'reservations'
 const convertedColumn = kind === 'booking' ? 'converted_booking_id' : 'converted_reservation_id'
 if (kind === 'booking') {
   if (!hold.product_id || !hold.variant_id || !hold.session_id) throw new Error('Booking hold has no offering or session')
   claim = await sessionClaimQuery(db, {env,bookingId:subjectId,organizationId:hold.organization_id,productId:hold.product_id,sessionId:hold.session_id,productVariantId:hold.variant_id,partySize:hold.quantity,userId:hold.buyer_user_id,requestId:hold.request_id,now,chargedPaymentId:payment.id,chargedAt:chargedAt})
   assignment.push(sessionAssignmentQuery(hold.session_id, hold.organization_id, subjectId))
 } else {
   if (hold.product_id || !hold.location_id || !hold.timezone) throw new Error('Reservation hold has invalid location facts')
   const local = localNow(hold.timezone, new Date(hold.starts_at))
   claim = await reservationClaimQuery(db, {organizationId:hold.organization_id,locationId:hold.location_id,reservationId:subjectId,requestId:hold.request_id,userId:hold.buyer_user_id,timezone:hold.timezone,startsAt:hold.starts_at,endsAt:hold.ends_at,date:local.date,timeSlot:local.time,partySize:hold.quantity,chargedPaymentId:payment.id,chargedAt:chargedAt})
 }
 let created: boolean
 try {
   const results = await executeBatch(db,[claim, ...assignment,
     {query:`UPDATE payment_checkout_holds SET status='converted',${convertedColumn}=? WHERE id=? AND status IN ('active','released') AND EXISTS(SELECT 1 FROM ${table} WHERE id=?)`,params:[subjectId,hold.id,subjectId]},
     {query:`INSERT INTO activity_entries(id,request_id,kind,scope_kind,actor_kind,event_name,payload_json,dedupe_key,sequence,occurred_at,created_at) SELECT ?,v.request_id,'operation','request','system',?,json_object(?,v.id,'request_id',v.request_id,'afterStatus',v.status,'payment_id',?,'intent',?),?,COALESCE((SELECT MAX(sequence) FROM activity_entries WHERE request_id=v.request_id),0)+1,?,? FROM ${table} v WHERE v.id=? AND v.request_id IS NOT NULL ON CONFLICT(dedupe_key) DO NOTHING`,params:[crypto.randomUUID(),`${kind}.created`,`operational_${kind}_id`,payment.id,`${kind}.created`,`${kind}:${subjectId}:created`,now,now,subjectId]},
     {query:`UPDATE payments SET subject_id=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM ${table} WHERE id=?)`,params:[subjectId,now,payment.id,subjectId]},
     ...conversationTaskQueries(hold.request_id,now),
   ],{operation:'Convert authenticated visit payment'})
   created = results[0]?.meta.changes === 1
 } catch (error) {
   const converted = await queryFirst<{status:string}>(db, 'SELECT status FROM payment_checkout_holds WHERE id=?', [hold.id])
   if (converted?.status !== 'converted') throw error
   created = true
 }
 if(created)return true
 const converted=await queryFirst<{status:string}>(db,'SELECT status FROM payment_checkout_holds WHERE id=?',[hold.id])
 return converted?.status==='converted'
}

/**
 * The conversion itself: a captured stay payment's hold becomes the buyer's
 * confirmed direct stay, its hold converted to it and the payment pointed at
 * it, in one batch. The stay belongs to the buyer who paid. Returns the new
 * stay's id, or null when another conversion of the same hold landed first.
 */
export async function convertStayHold(db: DbClient, input: {
  payment: Pick<Payment, 'id' | 'organization_id' | 'buyer_user_id'>
  hold: { id: string; product_id: string; location_id: string; buyer_user_id: string | null }
  purchase: StayPurchase
}): Promise<string | null> {
  const { payment, hold, purchase } = input
  const candidate = crypto.randomUUID()
  const now = new Date().toISOString()
  const home = await queryFirst<{ name: string }>(db, 'SELECT name FROM products WHERE id = ? AND organization_id = ?', [hold.product_id, payment.organization_id])
  if (!home) throw new Error('Captured stay payment names a home that does not exist')
  const turnovers = await turnoverTaskQueries(db, { organizationId: payment.organization_id, now, before: null,
    after: { id: candidate, product_id: purchase.product_id, status: 'confirmed', check_in_date: purchase.check_in_date, check_out_date: purchase.check_out_date } })
  const results = await executeBatch(db, [
    ...stayFromCheckoutQueries({ organizationId: payment.organization_id, locationId: hold.location_id, stayId: candidate, holdId: hold.id, paymentId: payment.id, buyerUserId: payment.buyer_user_id ?? hold.buyer_user_id, now, stay: { quote: purchase, guest: purchase.guest }, homeTitle: home.name }),
    { query: "UPDATE payment_checkout_holds SET status='converted', converted_stay_id=? WHERE id=? AND status IN ('active','released') AND EXISTS(SELECT 1 FROM stays WHERE id=?)", params: [candidate, hold.id, candidate] },
    { query: 'UPDATE payments SET subject_id=?, updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM stays WHERE id=?)', params: [candidate, now, payment.id, candidate] },
    ...turnovers,
  ], { operation: 'Convert captured stay payment' })
  // The stay's own insert, after the hold's held nights are released.
  return results[1]?.meta.changes === 1 ? candidate : null
}

/**
 * A captured stay payment becomes its confirmed direct stay: the hold's nights
 * pass to the stay in one batch. A night someone else holds by then refunds the
 * guest in full. A replay finds the hold converted and repeats only the
 * idempotent follow-ups: channel push, realtime and notifications.
 */
async function settleStayPayment(db: DbClient, stripe: Stripe, env: CloudflareEnv, payment: Payment, intent: Stripe.PaymentIntent, capture: Parameters<typeof notifyPaymentFinancialEvent>[4]) {
  if (!await queryFirst(db, 'SELECT id FROM organization WHERE id=?', [payment.organization_id])) { await notifyPaymentFinancialEvent(db, stripe, env, payment, capture); return }
  const stayId = await commitStay(db, payment)
  if (!stayId) { await refundUnfulfillable(db, stripe, env, payment, intent, capture); return }
  const outcomes = await Promise.allSettled([
    completeStayFromCheckout(db, env, payment.organization_id, stayId),
    requirePayment(db, payment.organization_id, payment.id).then(recorded => notifyPaymentFinancialEvent(db, stripe, env, recorded, capture)),
    notifyStayBooked(env, db, payment.organization_id, stayId),
  ])
  raiseSettledFailures('Captured stay completion', payment.id, outcomes, ['channel and publication', 'capture notification', 'stay confirmation'])
}

/** The hold's nights become the confirmed stay. The stay's id, now or already; null when a night has gone. */
async function commitStay(db: DbClient, payment: Payment): Promise<string | null> {
  if (!await queryFirst(db, 'SELECT id FROM organization WHERE id=?', [payment.organization_id])) return null
  const hold = await queryFirst<{ id: string; product_id: string | null; session_id: string | null; location_id: string | null; status: string; converted_stay_id: string | null; buyer_user_id: string | null }>(db,
    'SELECT id, product_id, session_id, location_id, status, converted_stay_id, buyer_user_id FROM payment_checkout_holds WHERE payment_id=? AND organization_id=?', [payment.id, payment.organization_id])
  if (!hold || !hold.product_id || hold.session_id || !hold.location_id) throw new Error('Stay payment has no stay hold')
  if (hold.status === 'converted') {
    if (!hold.converted_stay_id) throw new Error('Converted stay hold has no stay')
    return hold.converted_stay_id
  }
  const snapshot: unknown = JSON.parse(payment.price_snapshot_json)
  const purchase = isRecord(snapshot) ? snapshot.stay : undefined
  if (!isStayPurchase(purchase) || purchase.product_id !== hold.product_id || purchase.total_minor !== payment.amount) throw new Error('Stay payment has no valid stay purchase')
  try {
    const converted = await convertStayHold(db, { payment, hold: { ...hold, product_id: hold.product_id, location_id: hold.location_id }, purchase })
    if (converted) return converted
  } catch (error) {
    if (!isStayNightConflict(error) && !/UNIQUE constraint failed: stays\.organization_id, stays\.idempotency_key/.test(error instanceof Error ? error.message : String(error))) throw error
  }
  const current = await queryFirst<{ status: string; converted_stay_id: string | null }>(db, 'SELECT status, converted_stay_id FROM payment_checkout_holds WHERE id=?', [hold.id])
  return current?.status === 'converted' ? current.converted_stay_id : null
}

const CONFIRMATION_HOLD_MS=60*60*1000

/** When a hold on a payment that has begun confirming ends: an hour on, and never before the buyer's time to pay. */
export function confirmationHoldUntil(payment:Pick<Payment,'checkout_expires_at'>):string{
 const buyerWindow=Date.parse(payment.checkout_expires_at??'')
 if(!Number.isFinite(buyerWindow))throw new Error('Payment has no checkout window')
 return new Date(Math.max(Date.now()+CONFIRMATION_HOLD_MS,buyerWindow)).toISOString()
}

function unfulfillableKey(intent:Pick<Stripe.PaymentIntent,'id'>):string{return `unfulfillable:${intent.id}`}

/** A bank debit has no authorization to cancel, so one that cleared after its capacity went goes back through the ordinary refund; a redelivery repeats it idempotently. */
async function refundUnfulfillable(db:DbClient,stripe:Stripe,env:CloudflareEnv,payment:Payment,intent:Stripe.PaymentIntent,capture:Parameters<typeof notifyPaymentFinancialEvent>[4]){
 await execute(db,"UPDATE payment_checkout_holds SET status='released' WHERE payment_id=? AND status='active'",[payment.id])
 const outcomes=await Promise.allSettled([executeRefund(db,stripe,payment,null,unfulfillableKey(intent),'requested_by_customer',null,env),notifyPaymentFinancialEvent(db,stripe,env,payment,capture)])
 raiseSettledFailures('Unfulfillable payment refund',payment.id,outcomes,['refund','capture notification'])
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
