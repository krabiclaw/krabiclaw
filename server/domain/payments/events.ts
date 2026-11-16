import { changedTaskIds, publishChangedJobs, publishEvent, type DomainEvent } from '~/server/events'
import type Stripe from 'stripe'
import type { CloudflareEnv } from '~/server/utils/auth'
import { notifyProductBookingCreated } from '~/server/domain/product-bookings'
import { cancelFailedCheckoutBooking } from '~/server/domain/bookings'
import { planSourceMessages } from '~/server/domain/scheduled-guest-messages'
import { execute, executeBatch, queryAll, queryFirst, type DbClient, type BatchQuery } from '~/server/db'
import { isRecord } from '~/server/utils/type-guards'
import { formAnswerSnapshotsSchema, type FormAnswerSnapshot } from '~/shared/form-questions'
import { assertBookingBatchWrite, bookingBatchWriteRefused, CapacityUnavailableError, sessionClaimQuery } from '~/server/utils/availability'
import { processStripeWebhookEvent } from '~/server/utils/stripe-webhook-events'
import { paymentsStripe, platformLivemode } from '~/server/utils/stripe-connect'
import { approvedStayBooking, reconcileRefundState, requirePayment, assertMinorAmount, type Payment } from './index'
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
import { checkoutStayChangedEvent, isStayNightConflict, stayFromCheckoutQueries, stayHoldPredicate, type CheckoutHome } from '~/server/domain/stays'

export interface CheckoutHold {
  id:string; organization_id:string; product_id:string|null; variant_id:string|null; session_id:string|null; location_id:string|null
  buyer_user_id:string|null; conversation_id:string|null; quantity:number; status:string; converted_booking_id:string|null
  starts_at: string; ends_at: string
  booking_ends_at: string | null; booking_version: number | null
  home: (Omit<CheckoutHome, 'name' | 'variant_id'> & { variants: string[] }) | null
  organization_exists: number
  retained_for_servicing: number
  receipt_conversation_id: string | null
  receipt_cancellation_hash: string | null
}

/** The checkout record for the payment aliased as p, including its converted receipt if present. */
export const checkoutHoldSql = `SELECT json_object(
  'id',h.id,'organization_id',h.organization_id,'product_id',h.product_id,'variant_id',h.variant_id,'session_id',h.session_id,
  'location_id',h.location_id,'buyer_user_id',h.buyer_user_id,'conversation_id',h.conversation_id,
  'starts_at',h.starts_at,'ends_at',h.ends_at,'quantity',h.quantity,'status',h.status,'converted_booking_id',h.converted_booking_id,
  'home',json(CASE WHEN h.session_id IS NULL AND h.status <> 'converted'
    THEN (SELECT json_object('location_id',c.location_id,'timezone',l.timezone,'check_in_time',b.check_in_time,'check_out_time',b.check_out_time,
      'variants',json((SELECT json_group_array(v.id) FROM product_variants v WHERE v.organization_id=h.organization_id AND v.product_id=h.product_id)))
      FROM ${TURNOVER_HOME_FROM} WHERE c.organization_id=h.organization_id AND c.product_id=h.product_id) END),
  'organization_exists',EXISTS (SELECT 1 FROM organization o WHERE o.id=h.organization_id),
  'retained_for_servicing',EXISTS (SELECT 1 FROM payment_servicing_tenants s WHERE s.organization_id=h.organization_id
    AND s.stripe_account_id=p.stripe_account_id AND s.livemode=p.livemode),
  'receipt_conversation_id',c.id,'receipt_cancellation_hash',json_extract(c.payload_json,'$.cancellation.token_hash'),
  'booking_ends_at',b.ends_at,'booking_version',b.version
) FROM payment_checkout_holds h
LEFT JOIN bookings b ON b.id=COALESCE(h.converted_booking_id, json_extract(p.price_snapshot_json,'$.approved_stay.bookingId')) AND b.organization_id=p.organization_id
LEFT JOIN conversations c ON c.booking_id=h.converted_booking_id AND c.organization_id=p.organization_id AND c.kind='booking'
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
  const now = new Date().toISOString()
  const account = { stripeAccount: payment.stripe_account_id }
  const expand = ['latest_charge', 'payment_method']
  const debitInitiated = reported.next_action?.type === 'verify_with_microdeposits' ||
    (reported.status === 'processing' &&
      ((typeof reported.payment_method === 'object' && reported.payment_method?.type === 'us_bank_account') ||
       (typeof reported.latest_charge === 'object' && reported.latest_charge?.payment_method_details?.type === 'us_bank_account')))
  const failed = reported.status === 'requires_payment_method' && reported.last_payment_error
  if (!debitInitiated && !failed && !['requires_capture', 'succeeded', 'canceled'].includes(reported.status)) return reported

  let intent = reported
  let hold = payment.subject_type === 'booking' ? knownHold === undefined ? await readCheckoutHold(db, payment) : knownHold : null
  if (reported.status === 'requires_capture') {
    const charge = reported.latest_charge
    if (!charge || typeof charge === 'string' || charge.livemode !== Boolean(payment.livemode) || charge.payment_intent !== reported.id) throw new Error('Authorized charge financial scope mismatch')
  }
  if (payment.subject_type === 'booking' && (debitInitiated || reported.status === 'requires_capture')) {
    if (!hold) throw new Error('Booking payment has no checkout record')
    if (hold.status === 'converted') {
      // A webhook can resume after the booking committed and before follow-up publication.
      if (hold.session_id === null && hold.organization_exists) {
        if (!hold.converted_booking_id || !hold.product_id || !hold.location_id || !hold.receipt_conversation_id || !hold.booking_version || !hold.booking_ends_at) {
          throw new Error('Saved stay is missing its booking or conversation')
        }
        await publishEvent(env, checkoutStayChangedEvent({ organizationId: hold.organization_id, stayId: hold.converted_booking_id,
          productId: hold.product_id, locationId: hold.location_id, conversationId: hold.receipt_conversation_id,
          version: hold.booking_version, range: approval ? null : [hold.starts_at, hold.ends_at], endsAt: hold.booking_ends_at }))
      } else if (hold.converted_booking_id && hold.organization_exists) {
        await publishEvent(env, { type: 'calendar.changed', organization_id: hold.organization_id, booking_id: hold.converted_booking_id })
      }
    } else {
      try {
        const bookingId = await saveCheckoutBooking(db, env, payment, hold, snapshot, now)
        hold = { ...hold, status: 'converted', converted_booking_id: bookingId }
      } catch (error) {
        if (!isStayNightConflict(error) && !bookingBatchWriteRefused(error) && !(error instanceof CapacityUnavailableError)) throw error
        const current = await readCheckoutHold(db, payment)
        if (current?.status === 'converted') hold = current
        else {
          intent = await stripe.paymentIntents.cancel(intent.id, { cancellation_reason: 'abandoned', expand },
            { ...account, idempotencyKey: `krabiclaw-unavailable:${payment.id}` })
          if (intent.status !== 'canceled') throw new Error('Stripe did not cancel the unavailable checkout', { cause: error })
        }
      }
    }
  }
  if (intent.status === 'requires_capture') {
    intent = await stripe.paymentIntents.capture(intent.id, { expand }, { ...account, idempotencyKey: `krabiclaw-capture:${payment.id}` })
  }
  if (failed && hold?.status === 'converted') {
    intent = await stripe.paymentIntents.cancel(intent.id, { cancellation_reason: 'abandoned', expand },
      { ...account, idempotencyKey: `krabiclaw-failed:${payment.id}` })
    if (intent.status !== 'canceled') throw new Error('Stripe did not close the failed booking payment')
  }
  if (intent.status === 'canceled') {
    await execute(db, "UPDATE payment_checkout_holds SET status='released' WHERE payment_id=? AND organization_id=? AND status='active'", [payment.id, payment.organization_id])
    if (approval && hold?.status !== 'converted') await releaseApprovedStayConfirmation(db, env, payment)
    if (hold?.status === 'converted' && payment.captured_amount === 0) {
      await publishPaymentNotification(env, payment, { kind: 'payment_failed', nativeId: intent.id, status: intent.status, amount: intent.amount })
    }
  } else if (failed) {
    if (approval) await releaseApprovedStayConfirmation(db, env, payment)
    await publishPaymentNotification(env, payment, { kind: 'payment_failed', nativeId: intent.id, status: intent.status, amount: intent.amount })
  }
  if (intent.status !== 'succeeded') return intent

  const bookingId = hold?.status === 'converted' ? hold.converted_booking_id : null
  const keepPaymentOnly = hold && !hold.organization_exists && (hold.session_id === null || (hold.retained_for_servicing && bookingId))
  if (intent.application_fee_amount) throw new Error('Direct charges carry no application fee')
  const charge = intent.latest_charge
  if (!charge || typeof charge === 'string' || charge.livemode !== Boolean(payment.livemode) || charge.payment_intent !== intent.id || charge.amount !== intent.amount_received) throw new Error('Captured charge financial scope mismatch')
  const matchesCapture = (row: Payment) => row.stripe_charge_id === charge.id && row.captured_amount === intent.amount_received
  if (payment.captured_amount && !matchesCapture(payment)) throw new Error('Stored capture does not match Stripe')
  const captureQueries: BatchQuery[] = []
  if (payment.captured_amount === 0) {
    const billingBasis = paymentsBillingBasis(intent.amount_received, payment.currency, snapshot.billing_fx)
    // The tax inside the captured amount is Stripe Tax's calculation the intent carried; Stripe records its transaction.
    const taxCalculation=intent.hooks?.inputs?.tax?.calculation
    const calculation=taxCalculation?await stripe.tax.calculations.retrieve(taxCalculation,{},{stripeAccount:payment.stripe_account_id}):null
    const taxAmount=calculation?calculation.tax_amount_exclusive+calculation.tax_amount_inclusive:0
    captureQueries.push(
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
    )
  }
  const [write] = captureQueries.length ? await executeBatch(db, captureQueries, { operation: 'Record payment capture' }) : []
  // Confirm and the Stripe webhook may observe the same capture.
  const capture = write?.results[0] as (Payment & { retained_without_organization: number }) | undefined
  const recorded = capture ?? (captureQueries.length ? await requirePayment(db, payment.organization_id, payment.id) : payment)
  if (!matchesCapture(recorded)) throw new Error('Stored capture does not match Stripe')
  // Record a confirmed charge for servicing even when the booking is missing.
  if (payment.subject_type === 'booking' && !keepPaymentOnly && !bookingId) throw new Error('Captured payment has no saved booking')
  const notice = { kind: 'payment_captured' as const, nativeId: intent.id, status: intent.status, amount: intent.amount_received, email: charge.billing_details.email ?? null }
  const finish = async (booking: Extract<DomainEvent, { type: 'payment.captured' }>['booking'] = null) => {
    await publishEvent(env, {
      type: 'payment.captured', organization_id: payment.organization_id, payment_id: payment.id, notice,
      intent_created: intent.created, saved_method_id: intent.customer && typeof charge.payment_method === 'string' ? charge.payment_method : null,
      booking,
    })
    return intent
  }
  if (!bookingId || !hold || keepPaymentOnly || recorded.refunded_amount > 0 || capture?.retained_without_organization) return finish()
  if (hold.session_id === null) return finish({ unit: 'nights', id: bookingId })
  if (!hold.conversation_id) throw new Error('Captured visit payment has no guest conversation')
  return finish({ unit: 'slot', conversation_id: hold.conversation_id })
}

/** The committed processor state, audit and receipts are consumed independently of the checkout response. */
export async function notifyRecordedPayment(env: CloudflareEnv, event: Extract<DomainEvent, { type: 'payment.financial' | 'payment.captured' }>): Promise<void> {
  const db = env.DB
  const payment = await requirePayment(db, event.organization_id, event.payment_id)
  const stripe = paymentsStripe(env, Boolean(payment.livemode))
  if (event.type === 'payment.financial') {
    if (event.notice.kind === 'payment_failed' && event.notice.status === 'canceled' && payment.subject_type === 'booking' && payment.subject_id) {
      await cancelFailedCheckoutBooking(db, env, payment, event.notice.nativeId)
    }
    return notifyPaymentFinancialEvent(db, stripe, env, payment, event.notice)
  }
  const notice = notifyPaymentFinancialEvent(db, stripe, env, payment, event.notice)
  const capture = async () => {
    const method = event.saved_method_id ? await stripe.paymentMethods.retrieve(event.saved_method_id, {}, { stripeAccount: payment.stripe_account_id }) : null
    await recordPaymentPaid(db, payment, event.notice.nativeId, Boolean(method && method.created < event.intent_created))
    await deliverPaymentsUsage(db, env, event.organization_id)
  }
  const confirm = async () => {
    const { booking } = event
    if (!booking) return
    if (booking.unit === 'nights') {
      await planSourceMessages(db, event.organization_id, booking.id)
      await notifyStayBooked(env, db, event.organization_id, booking.id)
    } else {
      await notifyProductBookingCreated(env, db, event.organization_id, booking.conversation_id)
    }
  }
  const outcomes = await Promise.allSettled([notice, capture(), confirm()])
  raiseSettledFailures('Captured booking delivery', payment.id, outcomes, ['capture notification', 'captured usage and analytics', 'booking follow-up'])
}

/** The answers a slot checkout froze with its purchase (the data move gives earlier purchases their conversation's); none is a corrupt purchase. */
function frozenAnswers(snapshot: Record<string, unknown>): FormAnswerSnapshot[] {
 const parsed=formAnswerSnapshotsSchema.safeParse(snapshot.answers)
 if(!parsed.success)throw new Error('Booking payment has no frozen answers')
 return parsed.data
}

/** Save the booking, claim inventory and attach the payment in one transaction. */
async function saveCheckoutBooking(db: DbClient, env: CloudflareEnv, payment: Payment, hold: CheckoutHold, snapshot: Record<string, unknown>, now: string) {
 if (!hold.product_id || !isRecord(snapshot.policy)) throw new Error('Booking payment has no offering or frozen policy')
 const approval = approvedStayBooking(snapshot)
 const bookingId = approval?.bookingId ?? crypto.randomUUID()
 const policy=JSON.stringify(snapshot.policy)
 const activeCheckout = { query: "EXISTS (SELECT 1 FROM payment_checkout_holds WHERE id=? AND organization_id=? AND status='active')",
   params: [hold.id, payment.organization_id] }
 let claim:BatchQuery[]
 if(hold.session_id){
  if(!hold.conversation_id)throw new Error('Visit hold has no guest conversation')
  if(!hold.variant_id)throw new Error('Booking hold has no offering or session')
  claim=[await sessionClaimQuery(db,{env,bookingId,organizationId:hold.organization_id,productId:hold.product_id,sessionId:hold.session_id,productVariantId:hold.variant_id,partySize:hold.quantity,userId:hold.buyer_user_id,now,payment: { id: payment.id, startsAt: hold.starts_at, endsAt: hold.ends_at, locationId: hold.location_id },policyJson:policy,answers:frozenAnswers(snapshot),websiteSource:await checkoutWebsiteSource(db,payment,hold.conversation_id)}),
   assertBookingBatchWrite({ query: 'changes() = 1', params: [] }),
   // The conversation the checkout waited in is the booking's; an operator's checkout records the status the booking was created in.
   {query:`UPDATE conversations SET booking_id=v.id,payload_json=CASE WHEN json_type(payload_json,'$.provenance')='object' THEN json_set(payload_json,'$.provenance.creation_status',v.status) ELSE payload_json END FROM bookings v
     WHERE v.id=? AND conversations.id=? AND conversations.organization_id=v.organization_id AND conversations.kind='booking' AND conversations.booking_id IS NULL`,params:[bookingId,hold.conversation_id]},
   ...conversationTaskQueries(hold.conversation_id,now)]
 }else{
  const purchase=snapshot.stay
  if(!isStayPurchase(purchase)||purchase.product_id!==hold.product_id||purchase.total_minor!==payment.amount)throw new Error('Stay payment has no valid stay purchase')
  const buyerUserId=payment.buyer_user_id??hold.buyer_user_id
  if(!buyerUserId)throw new Error('Stay payment has no guest account')
  if (approval) {
   if (!hold.conversation_id || hold.buyer_user_id !== buyerUserId || !hold.location_id || !hold.booking_ends_at) throw new Error('Approved stay payment has no guest conversation')
   claim = [
    { query: `UPDATE bookings SET status='confirmed', version=version+1, updated_at=? WHERE id=? AND organization_id=?
       AND status='pending' AND version=? AND ${activeCheckout.query}`,
      params: [now, bookingId, payment.organization_id, approval.version, ...activeCheckout.params],
      event: checkoutStayChangedEvent({ organizationId: hold.organization_id, stayId: bookingId, productId: hold.product_id,
        locationId: hold.location_id, conversationId: hold.conversation_id, version: approval.version + 1, range: null, endsAt: hold.booking_ends_at }) },
    organizationEventQuery({ organizationId: payment.organization_id, locationId: hold.location_id, actorId: null, eventType: 'stay.updated',
     entityType: 'stay', entityId: bookingId, metadata: { status: 'confirmed', payment_id: payment.id },
     dedupeKey: stayRequestConfirmationKey(bookingId), onlyIfPreviousChangedOneRow: true }),
    assertBookingBatchWrite({ query: "EXISTS (SELECT 1 FROM bookings WHERE id=? AND organization_id=? AND status='confirmed' AND version=?)",
      params: [bookingId, payment.organization_id, approval.version + 1] }),
    ...conversationTaskQueries(hold.conversation_id, now),
   ]
  } else {
   if (typeof snapshot.title !== 'string' || !hold.home) throw new Error('Stay checkout has no home or stay window')
   const { variants, ...clocks } = hold.home
   if (variants.length !== 1) throw new Error(`Home ${purchase.product_id} has ${variants.length} variants; a home has exactly one`)
   const home = { ...clocks, name: snapshot.title, variant_id: variants[0]! }
   const bookable = await stayHoldPredicate(db, { organizationId: payment.organization_id, productId: purchase.product_id, checkIn: purchase.check_in_date, checkOut: purchase.check_out_date })
   const availability = { query: `${activeCheckout.query} AND ${bookable.query} AND ?>?`,
     params: [...activeCheckout.params, ...bookable.params ?? [], payment.checkout_expires_at, now] }
   claim = stayFromCheckoutQueries({ organizationId: payment.organization_id, stayId: bookingId, paymentId: payment.id, buyerUserId, now, stay: { quote: purchase, guest: purchase.guest },
    home, policy, availability, websiteSource: await checkoutWebsiteSource(db, payment, hold.conversation_id) })
  }
 }
 const writes = await executeBatch(db, [...claim,
   { query: "UPDATE payment_checkout_holds SET status='converted', converted_booking_id=? WHERE id=? AND organization_id=? AND status='active'",
     params: [bookingId, hold.id, payment.organization_id] },
   assertBookingBatchWrite({ query: 'changes() = 1', params: [] }),
   { query: 'UPDATE payments SET subject_id=?, updated_at=? WHERE id=? AND organization_id=? AND subject_id IS NULL',
     params: [bookingId, now, payment.id, payment.organization_id] },
   assertBookingBatchWrite({ query: `changes()=1 AND EXISTS (SELECT 1 FROM conversations WHERE organization_id=? AND booking_id=? AND kind='booking'
     AND (? IS NULL OR id=?))`, params: [payment.organization_id, bookingId, hold.conversation_id, hold.conversation_id] }),
 ], { operation: 'Save checkout booking' })
 await publishChangedJobs(env, payment.organization_id, changedTaskIds(writes))
 return bookingId
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

/** End of an approved stay's payment lock. */
export function confirmationHoldUntil(startedAt: string): string {
  return new Date(Date.parse(startedAt) + CONFIRMATION_HOLD_MS).toISOString()
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
      await reconcilePaymentIntent(db,stripe,payment,await stripe.paymentIntents.retrieve(object.id,{expand:['latest_charge','payment_method']}, {stripeAccount:event.account}),env)
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
