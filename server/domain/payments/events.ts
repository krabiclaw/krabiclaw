import { changedTaskIds, publishChangedJobs, publishEvent, type DomainEvent } from '~/server/events'
import type Stripe from 'stripe'
import type { CloudflareEnv } from '~/server/utils/auth'
import { notifyProductBookingCreated } from '~/server/domain/product-bookings'
import { execute, executeBatch, queryAll, queryFirst, type DbClient, type BatchQuery } from '~/server/db'
import { isRecord } from '~/server/utils/type-guards'
import { formAnswerSnapshotsSchema, type FormAnswerSnapshot } from '~/shared/form-questions'
import { assertBookingBatchWrite, sessionClaimQuery } from '~/server/utils/availability'
import { processStripeWebhookEvent } from '~/server/utils/stripe-webhook-events'
import { paymentsStripe, platformLivemode } from '~/server/utils/stripe-connect'
import { approvedStayBooking, executeRefund, reconcileRefundState, requirePayment, assertMinorAmount, type Payment } from './index'
import { notifyPaymentFinancialEvent, publishPaymentNotification, reconcilePayoutEvent } from './notifications'
import { checkoutWebsiteSource, recordPaymentPaid } from '~/server/domain/booking-analytics'
import { notifyStayBooked, raiseSettledFailures } from '~/server/utils/notifications'
import { paymentsBillingBasis } from './fx'
import { deliverPaymentsUsage, paymentUsageEventQuery } from './usage'
import { isStayPurchase } from './checkout'
import { TURNOVER_HOME_FROM } from '~/server/domain/tasks'
import { organizationEventQuery } from '~/server/utils/organization-events'
import { conversationTaskQueries } from '~/server/domain/guest-threads/repository'
import { stayRequestConfirmationKey } from '~/server/domain/requests'
import { approvedStayPaymentPredicate, completeStayFromCheckout, isStayNightConflict, stayFromCheckoutQueries, type CheckoutHome } from '~/server/domain/stays'

export interface CheckoutHold {
  id:string; organization_id:string; product_id:string|null; variant_id:string|null; session_id:string|null; location_id:string|null
  buyer_user_id:string|null; conversation_id:string|null; quantity:number; status:string; converted_booking_id:string|null
  home: (Omit<CheckoutHome, 'name' | 'variant_id'> & { variants: string[] }) | null
  organization_exists: number
  retained_for_servicing: number
  receipt_conversation_id: string | null
  receipt_cancellation_hash: string | null
  unfulfillable_refund: number
  refunded_amount: number
}

/** The durable hold for the payment aliased as p, including its converted receipt if present. */
export const checkoutHoldSql = `SELECT json_object(
  'id',h.id,'organization_id',h.organization_id,'product_id',h.product_id,'variant_id',h.variant_id,'session_id',h.session_id,
  'location_id',h.location_id,'buyer_user_id',h.buyer_user_id,'conversation_id',h.conversation_id,
  'quantity',h.quantity,'status',h.status,'converted_booking_id',h.converted_booking_id,
  'home',json(CASE WHEN h.session_id IS NULL AND h.status <> 'converted'
    THEN (SELECT json_object('location_id',c.location_id,'timezone',l.timezone,'check_in_time',b.check_in_time,'check_out_time',b.check_out_time,
      'variants',json((SELECT json_group_array(v.id) FROM product_variants v WHERE v.organization_id=h.organization_id AND v.product_id=h.product_id)))
      FROM ${TURNOVER_HOME_FROM} WHERE c.organization_id=h.organization_id AND c.product_id=h.product_id) END),
  'organization_exists',EXISTS (SELECT 1 FROM organization o WHERE o.id=h.organization_id),
  'retained_for_servicing',EXISTS (SELECT 1 FROM payment_servicing_tenants s WHERE s.organization_id=h.organization_id
    AND s.stripe_account_id=p.stripe_account_id AND s.livemode=p.livemode),
  'receipt_conversation_id',c.id,'receipt_cancellation_hash',json_extract(c.payload_json,'$.cancellation.token_hash'),
  'refunded_amount',p.refunded_amount,
  'unfulfillable_refund',EXISTS (SELECT 1 FROM payment_refunds r WHERE r.payment_id=p.id AND r.idempotency_key='unfulfillable:'||p.stripe_payment_intent_id)
) FROM payment_checkout_holds h LEFT JOIN conversations c ON c.booking_id=h.converted_booking_id AND c.organization_id=p.organization_id AND c.kind='booking'
WHERE h.payment_id=p.id AND h.organization_id=p.organization_id`

export async function readCheckoutHold(db: DbClient, payment: Payment) {
  const row = await queryFirst<{ hold: string | null }>(db, `SELECT (${checkoutHoldSql}) AS hold FROM payments p WHERE p.id=? AND p.organization_id=?`, [payment.id, payment.organization_id])
  return row?.hold ? JSON.parse(row.hold) as CheckoutHold : null
}

/** Provider retrieval, account/mode and frozen money checks precede every conversion. */
export async function reconcilePaymentIntent(db:DbClient,stripe:Stripe,payment:Payment,reported:Stripe.PaymentIntent, env:CloudflareEnv, knownHold?: CheckoutHold | null):Promise<Stripe.PaymentIntent> {
  if (reported.livemode !== Boolean(payment.livemode) || reported.currency.toUpperCase() !== payment.currency || reported.metadata.krabiclaw_payment_id !== payment.id || payment.stripe_payment_intent_id !== reported.id) throw new Error('Stripe PaymentIntent financial identity mismatch')
  // The intent is the one this purchase opened, on this account and mode; what it charged is Stripe's.
  const snapshot: unknown = JSON.parse(payment.price_snapshot_json)
  if (!isRecord(snapshot)) throw new Error('Payment has no frozen purchase')
  const approval = approvedStayBooking(snapshot)
  const stayCheckout = isStayPurchase(snapshot.stay)
  const now = new Date().toISOString()
  const captured = reported.status === 'requires_capture' ? await captureOnceBooked(db,stripe,env,payment,reported,knownHold) : null
  const intent = captured?.intent ?? reported
  if (intent.status !== 'succeeded') {
    // A debit waiting on its bank verification or clearing keeps its capacity until Stripe says how it ended.
    if (intent.status === 'processing' || intent.next_action?.type === 'verify_with_microdeposits') {
      const expiresAt = new Date(Date.now() + 14 * 86_400_000).toISOString()
      const changed = await execute(db, "UPDATE payment_checkout_holds SET expires_at=? WHERE payment_id=? AND status='active'", [expiresAt, payment.id])
      if (stayCheckout && changed.meta.changes) await publishEvent(env, { type: 'business.wake', kind: 'checkout', organization_id: payment.organization_id, due_at: Date.parse(expiresAt) })
    }
    // A declined confirmation can accept another method; only cancellation is terminal.
    if (intent.status === 'canceled') {
      await execute(db,"UPDATE payment_checkout_holds SET status='released' WHERE payment_id=? AND status='active'",[payment.id])
      if (stayCheckout) await publishEvent(env, { type: 'business.wake', kind: 'checkout', organization_id: payment.organization_id, due_at: Date.parse(now) })
      // Stripe cancelled the authorization a booking was committed on, so nothing was paid; the business decides what becomes of the booking.
      if ((payment.subject_id || captured?.bookingId) && payment.captured_amount === 0) await publishPaymentNotification(env,payment,{kind:'payment_failed',nativeId:intent.id,status:intent.status,amount:intent.amount})
    }
    if (intent.status === 'requires_payment_method' && intent.last_payment_error) {
      // A bank debit that failed days later gives back the 14 days it was holding.
      if (approval) await releaseApprovedStayConfirmation(db, env, payment)
      else {
        const until=confirmationHoldUntil(payment)
        await execute(db,"UPDATE payment_checkout_holds SET expires_at=? WHERE payment_id=? AND status='active' AND expires_at>?",[until,payment.id,until])
        if (stayCheckout) await publishEvent(env, { type: 'business.wake', kind: 'checkout', organization_id: payment.organization_id, due_at: Date.parse(until) })
      }
      await publishPaymentNotification(env,payment,{kind:'payment_failed',nativeId:intent.id,status:intent.status,amount:intent.amount})
    }
    return intent
  }
  if (intent.application_fee_amount) throw new Error('Direct charges carry no application fee')
  const charge=typeof intent.latest_charge==='string' ? await stripe.charges.retrieve(intent.latest_charge,{}, {stripeAccount:payment.stripe_account_id}) : intent.latest_charge
  if(!charge || charge.livemode!==Boolean(payment.livemode) || charge.payment_intent!==intent.id || charge.amount!==intent.amount_received) throw new Error('Captured charge financial scope mismatch')
  let recorded: Payment & { retained_without_organization?: number } = payment
  if (payment.captured_amount === 0) {
    const billingBasis = paymentsBillingBasis(intent.amount_received, payment.currency, snapshot.billing_fx)
    // The tax inside the captured amount is Stripe Tax's calculation the intent carried; Stripe records its transaction.
    const taxCalculation=intent.hooks?.inputs?.tax?.calculation
    const calculation=taxCalculation?await stripe.tax.calculations.retrieve(taxCalculation,{},{stripeAccount:payment.stripe_account_id}):null
    const taxAmount=calculation?calculation.tax_amount_exclusive+calculation.tax_amount_inclusive:0
    const [captureWrite] = await executeBatch(db,[
      { query: `UPDATE payments SET stripe_charge_id=?,receipt_url=?,surcharge_amount=?,captured_amount=?,tax_amount=?,updated_at=?
         WHERE id=? AND organization_id=? AND captured_amount=0
         RETURNING *, EXISTS (SELECT 1 FROM payment_servicing_tenants s
           WHERE s.organization_id=payments.organization_id AND s.stripe_account_id=payments.stripe_account_id AND s.livemode=payments.livemode
             AND NOT EXISTS (SELECT 1 FROM organization o WHERE o.id=payments.organization_id)) AS retained_without_organization`,
      params: [charge.id, charge.receipt_url, (intent as Stripe.PaymentIntent & { amount_details?: { surcharge?: { amount?: number } } }).amount_details?.surcharge?.amount ?? 0,
        intent.amount_received, taxAmount, now, payment.id, payment.organization_id] },
      // Usage is billed in the platform's mode only: a demo's test-mode capture on a live platform is never billable volume.
      ...(Boolean(payment.livemode) === platformLivemode(env) ? [paymentUsageEventQuery({
        organizationId: payment.organization_id, paymentId: payment.id, kind: 'captured_volume', currency: payment.currency,
        amount: intent.amount_received, billingBasis, sourceId: `capture:${payment.stripe_account_id}:${payment.livemode}:${intent.id}`,
        occurredAt: new Date(charge.created * 1000).toISOString(), createdAt: now,
      }, { query: 'SELECT 1 WHERE changes()=1', params: [] })] : []),
    ],{operation:'Record authenticated capture and usage'})
    // Confirm and a webhook can observe the authorization together. The authenticated capture belongs to the first writer.
    recorded = (captureWrite?.results[0] as typeof recorded | undefined) ?? await requirePayment(db, payment.organization_id, payment.id)
  }
  if (recorded.stripe_charge_id !== charge.id || recorded.captured_amount !== intent.amount_received) throw new Error('Stored capture does not match Stripe')
  const capture = { kind: 'payment_captured' as const, nativeId: intent.id, status: intent.status, amount: intent.amount_received, email: charge.billing_details.email ?? null }
  const finish = async (booking: Extract<DomainEvent, { type: 'payment.captured' }>['booking'] = null) => {
    await publishEvent(env, {
      type: 'payment.captured', organization_id: payment.organization_id, payment_id: payment.id, notice: capture,
      intent_created: intent.created, saved_method_id: intent.customer && typeof charge.payment_method === 'string' ? charge.payment_method : null,
      booking,
    })
    return intent
  }
  const unfulfillable = async () => {
    const outcomes = await Promise.allSettled([refundUnfulfillable(db, stripe, env, recorded, intent), finish()])
    raiseSettledFailures('Unfulfillable payment refund', payment.id, outcomes, ['refund', 'capture event'])
    return intent
  }
  // A redelivery of a refunded purchase finishes the refund and keeps it from booking.
  if (payment.subject_type !== 'booking') return finish()
  const hold = captured ? captured.hold : knownHold === undefined ? await readCheckoutHold(db, recorded) : knownHold
  if (hold?.unfulfillable_refund) return unfulfillable()
  if (recorded.refunded_amount > 0) return finish()
  if (!hold) throw new Error('Booking payment has no durable hold')
  const nights = hold.session_id === null
  // A business deleted since the guest paid keeps the money record.
  if (!hold.organization_exists && (nights || hold.retained_for_servicing && hold.status === 'converted')) return finish()
  const bookingId = captured?.bookingId ?? await convertCheckoutHold(db, env, recorded, hold, new Date(charge.created * 1000).toISOString())
  if (!bookingId) return unfulfillable()
  if (recorded.retained_without_organization) return finish()
  if (!captured?.bookingId && hold.status !== 'converted' && await queryFirst(db, `SELECT 1 FROM payment_servicing_tenants s
    WHERE s.organization_id=? AND s.stripe_account_id=? AND s.livemode=?
      AND NOT EXISTS (SELECT 1 FROM organization o WHERE o.id=s.organization_id)`, [payment.organization_id, payment.stripe_account_id, payment.livemode])) return finish()
  if (nights) return finish({ unit: 'nights', id: bookingId })
  if (!hold.conversation_id) throw new Error('Captured visit payment has no guest conversation')
  return finish({ unit: 'slot', conversation_id: hold.conversation_id })
}

/** The committed processor state, audit and receipts are consumed independently of the checkout response. */
export async function notifyRecordedPayment(env: CloudflareEnv, event: Extract<DomainEvent, { type: 'payment.financial' | 'payment.captured' }>): Promise<void> {
  const db = env.DB
  const payment = await requirePayment(db, event.organization_id, event.payment_id)
  const stripe = paymentsStripe(env, Boolean(payment.livemode))
  const notice = notifyPaymentFinancialEvent(db, stripe, env, payment, event.notice)
  if (event.type === 'payment.financial') {
    const bookingId = payment.subject_id
    if (event.notice.kind !== 'payment_failed' || payment.subject_type !== 'booking' || !bookingId) return notice
    const followup = async () => {
      const stay = await queryFirst(db, `SELECT 1 FROM bookings b JOIN organization o ON o.id=b.organization_id
        JOIN payment_checkout_holds h ON h.converted_booking_id=b.id AND h.organization_id=b.organization_id AND h.status='converted'
        WHERE h.payment_id=? AND b.id=? AND b.organization_id=? AND b.product_session_id IS NULL`, [payment.id, bookingId, event.organization_id])
      if (stay) await completeStayFromCheckout(db, env, event.organization_id, bookingId, false)
    }
    const outcomes = await Promise.allSettled([notice, followup()])
    raiseSettledFailures('Failed booking payment delivery', payment.id, outcomes, ['payment failure notification', 'booking follow-up'])
    return
  }
  const capture = async () => {
    const method = event.saved_method_id ? await stripe.paymentMethods.retrieve(event.saved_method_id, {}, { stripeAccount: payment.stripe_account_id }) : null
    await recordPaymentPaid(db, payment, event.notice.nativeId, Boolean(method && method.created < event.intent_created))
    await deliverPaymentsUsage(db, env, event.organization_id)
  }
  const confirm = async () => {
    const { booking } = event
    if (!booking) return
    if (booking.unit === 'nights') {
      await completeStayFromCheckout(db, env, event.organization_id, booking.id, true)
      await notifyStayBooked(env, db, event.organization_id, booking.id)
    } else {
      await notifyProductBookingCreated(env, db, event.organization_id, booking.conversation_id)
    }
  }
  const outcomes = await Promise.allSettled([notice, capture(), confirm()])
  raiseSettledFailures('Captured booking delivery', payment.id, outcomes, ['capture notification', 'captured usage and analytics', 'booking follow-up'])
}

/**
 * A card or Link payment is charged only once its booking exists. When the
 * capacity has gone the authorization is cancelled and the buyer is never
 * charged. A capture or cancel that lost a race is not a failure: Stripe's own
 * status says what happened, and the hold finds the same booking.
 */
async function captureOnceBooked(db:DbClient,stripe:Stripe,env:CloudflareEnv,payment:Payment,intent:Stripe.PaymentIntent,knownHold?:CheckoutHold|null){
 const account={stripeAccount:payment.stripe_account_id}
 const charge=typeof intent.latest_charge==='string'?await stripe.charges.retrieve(intent.latest_charge,{},account):intent.latest_charge
 if(!charge||charge.livemode!==Boolean(payment.livemode)||charge.payment_intent!==intent.id)throw new Error('Authorized charge financial scope mismatch')
 const snapshot: unknown = JSON.parse(payment.price_snapshot_json)
 if (!isRecord(snapshot)) throw new Error('Booking payment has no frozen purchase')
 const approval = approvedStayBooking(snapshot)
 const hold = payment.subject_type==='booking' ? knownHold === undefined ? await readCheckoutHold(db, payment) : knownHold : null
 let bookingId: string | null = null
 let booked = payment.subject_type !== 'booking'
 if (approval) {
  // The approved booking already owns its nights. Capture first, then confirm that same booking.
  const purchase = snapshot.stay
  if (!hold?.conversation_id || !hold.buyer_user_id || !isStayPurchase(purchase) || purchase.product_id !== hold.product_id) {
   throw new Error('Approved stay payment has no stay or guest conversation')
  }
  const now = new Date().toISOString()
  const bookable = await approvedStayPaymentPredicate(db, { ...approval, organizationId: payment.organization_id,
   productId: purchase.product_id, checkIn: purchase.check_in_date, checkOut: purchase.check_out_date,
   conversationId: hold.conversation_id, buyerUserId: hold.buyer_user_id, through: now, allowInFlight: payment.id })
  const expiresAt = confirmationHoldUntil(payment, now)
  const renewed = await execute(db, `UPDATE payment_checkout_holds SET expires_at=MAX(expires_at, ?)
    WHERE payment_id=? AND organization_id=? AND status='active' AND ${bookable.query}
      AND EXISTS (SELECT 1 FROM payments p WHERE p.id=payment_checkout_holds.payment_id AND json_type(p.review_json,'$.confirmation_started_at')='text')`,
  [expiresAt, payment.id, payment.organization_id, ...bookable.params])
  booked = renewed.meta.changes === 1
  if (booked) await publishEvent(env, { type: 'business.wake', kind: 'checkout', organization_id: payment.organization_id, due_at: Date.parse(expiresAt) })
 } else if (!booked) {
  bookingId = await convertCheckoutHold(db, env, payment, hold, new Date(charge.created * 1000).toISOString())
  booked = bookingId !== null
 }
 try{
  const updated=booked?await stripe.paymentIntents.capture(intent.id,{},account):await stripe.paymentIntents.cancel(intent.id,{},account)
  return { intent: updated, hold, bookingId }
 }catch(error){
  if(!(error instanceof stripe.errors.StripeInvalidRequestError)||error.code!=='payment_intent_unexpected_state')throw error
  return { intent: await stripe.paymentIntents.retrieve(intent.id,{},account), hold, bookingId }
 }
}

/**
 * A paid hold becomes its booking: the one paid conversion for every kind. Its
 * inventory is claimed per unit in the same batch that converts the hold and
 * points the payment at the booking: a session's seats, under the capacity the
 * hold kept, or a home's nights, which pass from the hold to the booking. The
 * terms the guest saw when they started paying are the terms they booked. The
 * booking's id, now or already; null when its capacity has gone or the
 * business no longer exists.
 */
/** The answers a slot checkout froze with its purchase (the data move gives earlier purchases their conversation's); none is a corrupt purchase. */
function frozenAnswers(snapshot: Record<string, unknown>): FormAnswerSnapshot[] {
 const parsed=formAnswerSnapshotsSchema.safeParse(snapshot.answers)
 if(!parsed.success)throw new Error('Booking payment has no frozen answers')
 return parsed.data
}

export async function commitBooking(db:DbClient,env:CloudflareEnv,payment:Payment,chargedAt:string):Promise<string|null>{
 return convertCheckoutHold(db, env, payment, await readCheckoutHold(db, payment), chargedAt)
}

async function convertCheckoutHold(db: DbClient, env: CloudflareEnv, payment: Payment, hold: CheckoutHold | null, chargedAt: string): Promise<string | null> {
 if (!hold?.product_id) throw new Error('Booking payment has no durable hold')
 if (hold.status === 'converted') {
  if (!hold.converted_booking_id) throw new Error('Converted hold has no booking')
  return hold.converted_booking_id
 }
 const now=new Date().toISOString()
 const snapshot:unknown=JSON.parse(payment.price_snapshot_json)
 if(!isRecord(snapshot)||!isRecord(snapshot.policy))throw new Error('Booking payment has no frozen booking policy')
 const approval = approvedStayBooking(snapshot)
 const bookingId = approval?.bookingId ?? crypto.randomUUID()
 const policy=JSON.stringify(snapshot.policy)
 const bookingExists = approval
  ? { query: `EXISTS (SELECT 1 FROM bookings WHERE id=? AND organization_id=? AND status='confirmed' AND version=?)`, params: [bookingId, payment.organization_id, approval.version + 1] }
  : { query: 'EXISTS (SELECT 1 FROM bookings WHERE id=?)', params: [bookingId] }
 let claim:BatchQuery[]
 if(hold.session_id){
  if(!hold.conversation_id)throw new Error('Visit hold has no guest conversation')
  if(!hold.variant_id)throw new Error('Booking hold has no offering or session')
  claim=[await sessionClaimQuery(db,{env,bookingId,organizationId:hold.organization_id,productId:hold.product_id,sessionId:hold.session_id,productVariantId:hold.variant_id,partySize:hold.quantity,userId:hold.buyer_user_id,now,chargedPaymentId:payment.id,chargedAt,policyJson:policy,answers:frozenAnswers(snapshot),websiteSource:await checkoutWebsiteSource(db,payment,hold.conversation_id)}),
   // The conversation the checkout waited in is the booking's; an operator's checkout records the status the booking was created in.
   {query:`UPDATE conversations SET booking_id=v.id,payload_json=CASE WHEN json_type(payload_json,'$.provenance')='object' THEN json_set(payload_json,'$.provenance.creation_status',v.status) ELSE payload_json END FROM bookings v
     WHERE v.id=? AND conversations.id=? AND conversations.organization_id=v.organization_id AND conversations.kind='booking' AND conversations.booking_id IS NULL`,params:[bookingId,hold.conversation_id]},
   ...conversationTaskQueries(hold.conversation_id,now)]
 }else{
  if(!hold.organization_exists)return null
  const purchase=snapshot.stay
  if(!isStayPurchase(purchase)||purchase.product_id!==hold.product_id||purchase.total_minor!==payment.amount)throw new Error('Stay payment has no valid stay purchase')
  const buyerUserId=payment.buyer_user_id??hold.buyer_user_id
  if(!buyerUserId)throw new Error('Stay payment has no guest account')
  if (approval) {
   if (!hold.conversation_id || hold.buyer_user_id !== buyerUserId || !hold.location_id) throw new Error('Approved stay payment has no guest conversation')
   const bookable = await approvedStayPaymentPredicate(db, { ...approval, organizationId: payment.organization_id,
    productId: purchase.product_id, checkIn: purchase.check_in_date, checkOut: purchase.check_out_date,
    conversationId: hold.conversation_id, buyerUserId, through: now, allowInFlight: payment.id })
   claim = [
    { query: `UPDATE bookings SET status='confirmed', version=version+1, updated_at=? WHERE id=? AND organization_id=? AND ${bookable.query}`,
      params: [now, bookingId, payment.organization_id, ...bookable.params] },
    organizationEventQuery({ organizationId: payment.organization_id, locationId: hold.location_id, actorId: null, eventType: 'stay.updated',
     entityType: 'stay', entityId: bookingId, metadata: { status: 'confirmed', payment_id: payment.id },
     dedupeKey: stayRequestConfirmationKey(bookingId), onlyIfPreviousChangedOneRow: true }),
    ...conversationTaskQueries(hold.conversation_id, now),
   ]
  } else {
   if (typeof snapshot.title !== 'string' || !hold.home) throw new Error('Stay checkout has no home or stay window')
   const { variants, ...clocks } = hold.home
   if (variants.length !== 1) throw new Error(`Home ${purchase.product_id} has ${variants.length} variants; a home has exactly one`)
   const home = { ...clocks, name: snapshot.title, variant_id: variants[0]! }
   claim = stayFromCheckoutQueries({ organizationId: payment.organization_id, stayId: bookingId, holdId: hold.id, paymentId: payment.id, buyerUserId, now, stay: { quote: purchase, guest: purchase.guest }, home, policy, websiteSource: await checkoutWebsiteSource(db, payment, hold.conversation_id) })
  }
 }
 let taskIds:string[]=[]
 let convertedBookingId: string | undefined
 try{
  const writes=await executeBatch(db,[...claim,
   {query:`UPDATE payment_checkout_holds SET status='converted',converted_booking_id=? WHERE id=? AND organization_id=? AND status IN ('active','released') AND ${bookingExists.query}
    RETURNING converted_booking_id`,params:[bookingId,hold.id,payment.organization_id,...bookingExists.params]},
   {query:`UPDATE payments SET subject_id=?,updated_at=? WHERE id=? AND organization_id=? AND ${bookingExists.query}`,params:[bookingId,now,payment.id,payment.organization_id,...bookingExists.params]},
   // A refused inventory claim changes nothing. A committed booking requires
   // its conversation and its checkout association in the same transaction.
   assertBookingBatchWrite({ query: `NOT ${bookingExists.query} OR EXISTS (
     SELECT 1 FROM payment_checkout_holds h JOIN payments p ON p.id=h.payment_id AND p.organization_id=h.organization_id
       JOIN conversations c ON c.organization_id=p.organization_id AND c.booking_id=p.subject_id AND c.kind='booking'
     WHERE h.id=? AND h.organization_id=? AND h.status='converted' AND h.converted_booking_id=? AND p.subject_id=h.converted_booking_id
       AND (h.conversation_id IS NULL OR c.id=h.conversation_id))`, params:[...bookingExists.params,hold.id,payment.organization_id,bookingId] }),
  ],{operation:'Convert paid booking hold'})
  taskIds=changedTaskIds(writes)
  const converted = writes[claim.length]?.results[0] as { converted_booking_id?: string } | undefined
  if (converted?.converted_booking_id === bookingId) convertedBookingId = bookingId
 }catch(error){
  // A night someone else holds by now refuses the batch: the guest is refunded in full. Any other failure is raised unless a concurrent conversion landed.
  const message=error instanceof Error?error.message:String(error)
  if(!isStayNightConflict(error)&&!/UNIQUE constraint failed: bookings\.organization_id, bookings\.idempotency_key/.test(message)){
   const raced=await queryFirst<{status:string}>(db,'SELECT status FROM payment_checkout_holds WHERE id=?',[hold.id])
   if(raced?.status!=='converted')throw error
  }
 }
 if (!convertedBookingId) {
  const current=await queryFirst<{status:string;converted_booking_id:string|null}>(db,'SELECT status,converted_booking_id FROM payment_checkout_holds WHERE id=?',[hold.id])
  if(current?.status!=='converted')return null
  if(!current.converted_booking_id)throw new Error('Converted hold has no booking')
  convertedBookingId = current.converted_booking_id
 }
 await publishChangedJobs(env,payment.organization_id,taskIds)
 return convertedBookingId
}

const CONFIRMATION_HOLD_MS=60*60*1000

export async function releaseApprovedStayConfirmation(db: DbClient, env: CloudflareEnv, payment: Payment) {
 if (!payment.checkout_expires_at) throw new Error('Approved stay payment has no checkout window')
 await executeBatch(db, [
  { query: `UPDATE payments SET review_json=json_remove(review_json,'$.confirmation_started_at')
    WHERE id=? AND organization_id=? AND captured_amount=0 AND review_json=? AND json_type(review_json,'$.confirmation_started_at')='text'`,
  params: [payment.id, payment.organization_id, payment.review_json] },
  { query: "UPDATE payment_checkout_holds SET expires_at=? WHERE payment_id=? AND organization_id=? AND status='active' AND changes()=1",
  params: [payment.checkout_expires_at, payment.id, payment.organization_id] },
 ], { operation: 'Release failed approved-stay payment' })
 await publishEvent(env, { type: 'business.wake', kind: 'checkout', organization_id: payment.organization_id, due_at: Date.now() })
}

/** When a hold on a payment that has begun confirming ends: an hour on, and never before the buyer's time to pay. */
export function confirmationHoldUntil(payment:Pick<Payment,'checkout_expires_at'>, approvedStartedAt?: string):string{
 if (approvedStartedAt) return new Date(Date.parse(approvedStartedAt) + CONFIRMATION_HOLD_MS).toISOString()
 const buyerWindow=Date.parse(payment.checkout_expires_at??'')
 if(!Number.isFinite(buyerWindow))throw new Error('Payment has no checkout window')
 return new Date(Math.max(Date.now()+CONFIRMATION_HOLD_MS,buyerWindow)).toISOString()
}

function unfulfillableKey(intent:Pick<Stripe.PaymentIntent,'id'>):string{return `unfulfillable:${intent.id}`}

/** A bank debit has no authorization to cancel, so one that cleared after its capacity went goes back through the ordinary refund; a redelivery repeats it idempotently. */
async function refundUnfulfillable(db:DbClient,stripe:Stripe,env:CloudflareEnv,payment:Payment,intent:Stripe.PaymentIntent){
 await execute(db,"UPDATE payment_checkout_holds SET status='released' WHERE payment_id=? AND status='active'",[payment.id])
 if (isStayPurchase((JSON.parse(payment.price_snapshot_json) as Record<string, unknown>).stay)) {
  await publishEvent(env, { type: 'business.wake', kind: 'checkout', organization_id: payment.organization_id, due_at: Date.now() })
 }
 await executeRefund(db, stripe, payment, null, unfulfillableKey(intent), 'requested_by_customer', null, env)
}

export function paymentEventKey(event:Pick<Stripe.Event,'id'|'account'|'livemode'>):string{return `payments:${event.account??'unscoped'}:${Number(event.livemode)}:${event.id}`}
export async function processPaymentEvent(db:DbClient,stripe:Stripe,event:Stripe.Event,env:CloudflareEnv) {
  if(!['payment_intent.','refund.','charge.dispute.','payout.'].some(prefix=>event.type.startsWith(prefix)))return
  const object=event.data.object as {id?:string;metadata?:Record<string,string>|null}
  const payload=JSON.stringify({id:event.id,type:event.type,account:event.account,livemode:event.livemode,data:{object:{id:object.id,metadata:{krabiclaw_payment_id:object.metadata?.krabiclaw_payment_id}}}})
  await processStripeWebhookEvent(db,{id:paymentEventKey(event),type:event.type,payload,processor:'tenant_payments'},async()=>{
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
