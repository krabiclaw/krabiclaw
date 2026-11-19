import type Stripe from 'stripe'
import { HTTPError } from 'nitro'
import { execute, executeBatch, queryAll, queryFirst, type DbClient } from '~/server/db'
import { assertRoleAllows } from '~/server/utils/member-access'
import { paymentsStripe } from '~/server/utils/stripe-connect'
import type { CloudflareEnv } from '~/server/utils/auth'
import { publishPaymentNotification } from './notifications'
import { recordPaymentRefunded } from '~/server/domain/booking-analytics'
import { isCurrencyCode, type CurrencyCode } from '~/shared/currencies'
import { isRecord } from '~/server/utils/type-guards'
import { paymentDisplay, paymentRefundsDisplay } from '~/shared/payment-display'

export interface ApprovedStayBooking {
  bookingId: string
  version: number
}

/** An approved stay keeps its original booking while the guest pays. */
export function approvedStayBooking(snapshot: Record<string, unknown>): ApprovedStayBooking | null {
  if (snapshot.approved_stay === undefined) return null
  const approval = snapshot.approved_stay
  if (!isRecord(approval) || typeof approval.bookingId !== 'string' || typeof approval.version !== 'number' || !Number.isSafeInteger(approval.version)) {
    throw new Error('Approved stay checkout has no valid booking and version')
  }
  return { bookingId: approval.bookingId, version: approval.version }
}

/** What a guest paid on the site for one booking, net of refunds; null when it was not paid online. */
export async function paidOnline(db: DbClient, organizationId: string, bookingId: string): Promise<{ amount: number; currency: CurrencyCode } | null> {
  const rows = await queryAll<{ amount: number; currency: string }>(db, "SELECT SUM(captured_amount - refunded_amount) AS amount, currency FROM payments WHERE organization_id=? AND subject_type='booking' AND subject_id=? AND captured_amount>0 GROUP BY currency", [organizationId, bookingId])
  if (rows.length > 1) throw new Error('Payments for one booking are in more than one currency')
  const row = rows[0]
  if (!row) return null
  if (!isCurrencyCode(row.currency)) throw new Error('Paid payment has an unsupported currency')
  return { amount: row.amount, currency: row.currency }
}

export interface Payment {
  id: string
  organization_id: string
  buyer_user_id: string | null
  stripe_account_id: string
  livemode: number
  subject_type: 'booking'
  subject_id: string | null
  location_id: string | null
  currency: string
  amount: number
  price_snapshot_json: string
  tax_amount: number
  captured_amount: number
  refunded_amount: number
  surcharge_amount: number
  stripe_payment_intent_id: string | null
  stripe_charge_id: string | null
  receipt_url: string | null
  idempotency_key: string | null
  checkout_expires_at: string | null
  review_json: string | null
  return_token: string | null
  return_token_hash: string | null
  return_expires_at: string | null
  claimed_at: string | null
  claimed_user_id: string | null
  created_at: string
  updated_at: string
}
/** The columns that authorize the pay page never leave the payment record. */
export type VisiblePayment = Omit<Payment, 'idempotency_key' | 'review_json' | 'return_token' | 'return_token_hash'>
function visiblePayment(payment: Payment): VisiblePayment {
  const visible: Partial<Payment> = { ...payment }
  const snapshot = JSON.parse(payment.price_snapshot_json) as Record<string, unknown>
  if ('checkout_origin' in snapshot) {
    delete snapshot.checkout_origin
    visible.price_snapshot_json = JSON.stringify(snapshot)
  }
  delete visible.idempotency_key
  delete visible.review_json
  delete visible.return_token
  delete visible.return_token_hash
  return visible as VisiblePayment
}
export type FinancialAction = 'read' | 'refund' | 'disputes' | 'payouts' | 'integration'
export interface FinancialPrincipal { organizationId: string; userId: string; role: string }
export async function authorizePayments(principal: FinancialPrincipal, action: FinancialAction): Promise<void> {
  await assertRoleAllows({ organizationId: principal.organizationId, role: principal.role, permissions: { payments: [action] } })
}
export function assertMinorAmount(amount: number, positive = true): void {
  if (!Number.isSafeInteger(amount) || amount < (positive ? 1 : 0)) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'Amount must be an integer in currency minor units' })
  }
}
export async function requirePayment(db: DbClient, organizationId: string, paymentId: string): Promise<Payment> {
  const payment = await queryFirst<Payment>(db, 'SELECT * FROM payments WHERE id = ? AND organization_id = ?', [paymentId, organizationId])
  if (!payment) throw new HTTPError({ statusCode: 404, statusMessage: 'Payment not found' })
  return payment
}
type StripeReceiptScope = Pick<Payment, 'stripe_payment_intent_id' | 'stripe_charge_id' | 'livemode' | 'stripe_account_id'>
type RecordedRefund = { id: string; amount: number | null; status: string; stripe_refund_id: string | null; note: string | null }

/** A succeeded PaymentIntent stays succeeded after a refund. Use its charge and refunds. */
async function stripePaymentFacts(env: CloudflareEnv, payment: StripeReceiptScope, includeDisputes: boolean) {
  if (!payment.stripe_payment_intent_id || !payment.stripe_charge_id) return null
  const stripe = paymentsStripe(env, Boolean(payment.livemode))
  const account = { stripeAccount: payment.stripe_account_id }
  const [charge, refunds, disputes] = await Promise.all([
    stripe.charges.retrieve(payment.stripe_charge_id, {}, account),
    stripe.refunds.list({ payment_intent: payment.stripe_payment_intent_id, limit: 100 }, account).autoPagingToArray({ limit: 10_000 }),
    includeDisputes
      ? stripe.disputes.list({ payment_intent: payment.stripe_payment_intent_id, limit: 100 }, account).autoPagingToArray({ limit: 10_000 })
      : [],
  ])
  return { amounts: { captured_amount: charge.amount_captured, refunded_amount: charge.amount_refunded }, refunds, disputes }
}

/** Stripe owns sent refunds. The recorded row supplies the note and refunds still awaiting submission. */
function mergeRefunds(rows: RecordedRefund[], provider: Stripe.Refund[] | undefined) {
  if (!provider) return rows
  const byProviderId = new Map(rows.map(row => [row.stripe_refund_id, row]))
  return [...provider.map(refund => {
    const local = byProviderId.get(refund.id)
    return { ...local, id: local?.id ?? refund.id, stripe_refund_id: refund.id, amount: refund.amount, status: refund.status ?? 'pending' }
  }), ...rows.filter(row => !row.stripe_refund_id)]
}

/** The receipt fields shown for an authorized booking or standalone purchase. */
export function paymentReceiptsQuery(organizationId: string, scope: { bookingId: string } | { paymentId: string }, buyerUserId?: string) {
  const booking = 'bookingId' in scope
  return { query: `
    SELECT p.id, p.currency, p.captured_amount, p.refunded_amount, p.surcharge_amount, p.receipt_url,
           p.stripe_account_id, p.livemode, p.stripe_payment_intent_id, p.stripe_charge_id,
           (SELECT json_group_array(json_object('id', f.id, 'amount', f.amount, 'status', f.status,
               'stripe_refund_id', f.stripe_refund_id, 'note', f.note))
            FROM payment_refunds f WHERE f.payment_id = p.id) AS refunds_json
    FROM payments p WHERE p.organization_id = ? AND ${booking ? "p.subject_type = 'booking' AND p.subject_id" : 'p.id'} = ?
      ${buyerUserId === undefined ? '' : 'AND p.buyer_user_id = ?'}
    ORDER BY p.created_at, p.id`, params: [organizationId, booking ? scope.bookingId : scope.paymentId, ...(buyerUserId === undefined ? [] : [buyerUserId])] }
}

export function paymentReceiptsFromRows(env: CloudflareEnv, results: unknown[]) {
  const rows = results as (StripeReceiptScope & { refunds_json: string })[]
  return Promise.all(rows.map(async row => {
    const facts = await stripePaymentFacts(env, row, false)
    return {
      payment: paymentDisplay({ ...row, ...facts?.amounts }),
      refunds: paymentRefundsDisplay(mergeRefunds(JSON.parse(row.refunds_json) as RecordedRefund[], facts?.refunds)),
    }
  }))
}

export async function readPaymentReceipts(db: DbClient, env: CloudflareEnv, organizationId: string, scope: { bookingId: string } | { paymentId: string }, buyerUserId?: string) {
  const { query, params } = paymentReceiptsQuery(organizationId, scope, buyerUserId)
  return paymentReceiptsFromRows(env, await queryAll(db, query, params))
}

/** Full merchant detail; callers must authorize before reading or projecting it. */
export async function readPaymentDetails(db:DbClient,env:CloudflareEnv,organizationId:string,paymentId:string){
 const scope=[organizationId,paymentId]
 const [recordedResult,refundResult,disputeResult,bookingResult]=await executeBatch(db,[
  {query:'SELECT * FROM payments WHERE organization_id=? AND id=?',params:scope},
  {query:'SELECT r.* FROM payments p JOIN payment_refunds r ON r.payment_id=p.id WHERE p.organization_id=? AND p.id=?',params:scope},
  {query:'SELECT d.* FROM payments p JOIN payment_disputes d ON d.payment_id=p.id WHERE p.organization_id=? AND p.id=?',params:scope},
  {query:`SELECT (SELECT c.id FROM conversations c WHERE c.booking_id=b.id AND c.kind='booking') AS conversation_id
      FROM payments p JOIN bookings b ON p.subject_type='booking' AND b.id=p.subject_id AND b.organization_id=p.organization_id
      WHERE p.organization_id=? AND p.id=?`,params:scope},
 ],{operation:'Read merchant payment detail'})
 const recorded=recordedResult!.results[0] as Payment|undefined
 if(!recorded)throw new HTTPError({statusCode:404,statusMessage:'Payment not found'})
 const refundRows=refundResult!.results as RecordedRefund[]
 const disputeRows=disputeResult!.results as Array<{id:string;stripe_dispute_id:string;amount:number;currency:string;reason:string;status:string;evidence_due_at:string|null;updated_at:string}>
 const booking=bookingResult!.results[0] as {conversation_id:string|null}|undefined
 const stripeFacts=await stripePaymentFacts(env,recorded,true)
 const payment=visiblePayment({...recorded,...stripeFacts?.amounts})
 const refunds=mergeRefunds(refundRows,stripeFacts?.refunds)
 return {payment,refunds,disputes:stripeFacts?stripeFacts.disputes.map(dispute=>{const row=disputeRows.find(item=>item.stripe_dispute_id===dispute.id);return {id:row?.id??dispute.id,stripe_dispute_id:dispute.id,amount:dispute.amount,currency:dispute.currency.toUpperCase(),reason:dispute.reason,status:dispute.status,evidence_due_at:dispute.evidence_details?.due_by?new Date(dispute.evidence_details.due_by*1000).toISOString():null,updated_at:row?.updated_at??new Date(dispute.created*1000).toISOString()}}):disputeRows,visit:booking?.conversation_id?{kind:payment.subject_type,conversation_id:booking.conversation_id}:null}
}
export type PaymentsEarningsType = 'paid' | 'refunded'
export async function listPayments(db: DbClient, principal: FinancialPrincipal, input: { from: string; to: string; after?: string; limit?: number; location_id?: string; earnings_type?: PaymentsEarningsType }) {
  await authorizePayments(principal, 'read')
  const from = new Date(input.from), to = new Date(input.to)
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw new HTTPError({ statusCode: 400, statusMessage: 'Valid UTC period is required' })
  const limit = Math.min(input.limit ?? 50, 100)
  if (!Number.isInteger(limit) || limit < 1) throw new HTTPError({statusCode:400,statusMessage:'Page size must be a positive integer'})
  if (input.earnings_type !== undefined && input.earnings_type !== 'paid' && input.earnings_type !== 'refunded') throw new HTTPError({ statusCode: 400, statusMessage: 'earnings_type must be paid or refunded' })
  const rows = await queryAll<Payment>(db, `SELECT * FROM payments WHERE organization_id = ? AND created_at >= ? AND created_at < ? AND id > ? AND (? IS NULL OR location_id = ?) AND (? IS NULL OR (CASE WHEN ? = 'refunded' THEN refunded_amount > 0 ELSE refunded_amount < captured_amount END)) ORDER BY id LIMIT ?`,
    [principal.organizationId, from.toISOString(), to.toISOString(), input.after ?? '', input.location_id ?? null, input.location_id ?? null, input.earnings_type ?? null, input.earnings_type ?? null, limit + 1])
  return { organization_id: principal.organizationId, timezone: 'UTC', from: from.toISOString(), to: to.toISOString(), payments: rows.slice(0, limit).map(visiblePayment), next_cursor: rows.length > limit ? rows[limit - 1]!.id : null }
}
export async function paymentSummary(db: DbClient, principal: FinancialPrincipal, from: string, to: string) {
  await authorizePayments(principal, 'read')
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(from) >= Date.parse(to)) throw new HTTPError({ statusCode: 400, statusMessage: 'Valid UTC period is required' })
  from = new Date(from).toISOString(); to = new Date(to).toISOString()
  const amounts = await queryAll(db, `SELECT currency, SUM(captured_amount) AS captured_amount, SUM(refunded_amount) AS refunded_amount,
    COALESCE((SELECT SUM(d.amount) FROM payment_disputes d JOIN payments p2 ON p2.id=d.payment_id WHERE p2.organization_id=p.organization_id AND d.currency=p.currency AND p2.created_at>=? AND p2.created_at<? AND d.status NOT IN ('won','warning_closed')),0) AS disputed_amount
    FROM payments p WHERE organization_id=? AND created_at>=? AND created_at<? GROUP BY currency`, [from,to,principal.organizationId,from,to])
  const usage = await queryAll(db, `SELECT unit AS currency, resource AS kind, SUM(quantity) AS amount, SUM(CASE WHEN delivery_at IS NULL THEN 1 ELSE 0 END) AS pending_delivery FROM usage_events WHERE organization_id=? AND provider_occurred_at>=? AND provider_occurred_at<? GROUP BY unit,resource`, [principal.organizationId,from,to])
  return { organization_id: principal.organizationId, timezone: 'UTC', from, to, amounts, usage, usage_status: 'Stripe meters bill captured volume on the plan subscription; Stripe costs follow once Stripe itemizes them', source: 'Stripe authenticated projections', refreshed_at: new Date().toISOString() }
}

/** Only an explicit authenticated dashboard or native-app approval may approve this request. MCP receives a handoff. */
export type RefundAuthorizationAction = 'refund' | 'reject_booking' | 'cancel_booking'
/** How long a business has to approve a refund it asked for. */
export const AUTHORIZATION_WINDOW_SECONDS = 600
export async function requestRefundAuthorization(db: DbClient, principal: FinancialPrincipal, paymentId: string, amount: number | null, action: RefundAuthorizationAction = 'refund', note?: string) {
  await authorizePayments(principal, 'refund')
  if (amount !== null) assertMinorAmount(amount)
  const payment = await requirePayment(db, principal.organizationId, paymentId)
  if (!payment.stripe_payment_intent_id || payment.captured_amount === 0) throw new HTTPError({ statusCode: 409, statusMessage: 'Payment has no captured provider object' })
  const id = crypto.randomUUID()
  await execute(db, `INSERT INTO payment_authorizations(id,organization_id,user_id,payment_id,action,amount,note,expires_at) VALUES(?,?,?,?,?,?,?,?)`, [id, principal.organizationId, principal.userId, paymentId, action, amount, note?.trim() || null, new Date(Date.now()+AUTHORIZATION_WINDOW_SECONDS*1000).toISOString()])
  return { authorization_id: id, payment_id: paymentId, amount, currency: payment.currency, confirmation_required: true }
}
export async function approveRefundAuthorization(db: DbClient, principal: FinancialPrincipal, id: string) {
  await authorizePayments(principal, 'refund')
  const now = new Date().toISOString()
  const result = await execute(db, `UPDATE payment_authorizations SET approved_at=COALESCE(approved_at,?) WHERE id=? AND organization_id=? AND user_id=? AND action IN ('refund','reject_booking','cancel_booking') AND expires_at>? AND consumed_at IS NULL`, [now,id,principal.organizationId,principal.userId,now])
  if (result.meta.changes !== 1) {
    const replay=await queryFirst(db,`SELECT a.id FROM payment_authorizations a WHERE a.id=? AND a.organization_id=? AND a.user_id=? AND a.approved_at IS NOT NULL AND a.consumed_at IS NOT NULL AND EXISTS(SELECT 1 FROM payment_refunds r JOIN payments p ON p.id=r.payment_id WHERE r.payment_id=a.payment_id AND (r.idempotency_key='approved:'||a.id OR (a.action='reject_booking' AND r.idempotency_key='rejected:'||p.subject_id) OR (a.action='cancel_booking' AND r.idempotency_key='cancelled:'||p.subject_id)))`,[id,principal.organizationId,principal.userId])
    if(!replay)throw new HTTPError({statusCode:409,statusMessage:'Financial authorization expired or unavailable'})
  }
}
export async function refundPayment(db: DbClient, stripe: Stripe, principal: FinancialPrincipal, authorizationId: string, env: CloudflareEnv) {
  await authorizePayments(principal, 'refund')
  // Expiry prevents a new financial instruction; an already-authorized durable intent still needs recovery.
  const authorization = await queryFirst<{payment_id:string;amount:number|null;note:string|null}>(db, `SELECT a.payment_id,a.amount,a.note FROM payment_authorizations a WHERE a.id=? AND a.organization_id=? AND a.user_id=? AND a.action='refund' AND a.approved_at IS NOT NULL AND (a.expires_at>? OR a.consumed_at IS NOT NULL)`, [authorizationId, principal.organizationId, principal.userId, new Date().toISOString()])
  if (!authorization) throw new HTTPError({ statusCode: 403, statusMessage: 'Explicit browser financial approval is required' })
  return await executeRefund(db,stripe,await requirePayment(db,principal.organizationId,authorization.payment_id),authorization.amount,`approved:${authorizationId}`,'requested_by_customer',principal.userId,env,authorization.note)
}
/** Stripe keeps an idempotency key for at least this long; after it, a lost response can no longer be matched to its refund. */
const REFUND_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000
/**
 * The one financial boundary that moves money back: merchant approval, a
 * declined or cancelled paid visit, a guest's own cancellation and the recovery
 * of a capture nothing could be fulfilled for. `amount` null is Stripe's
 * full-remaining refund: no local balance decides what is left, Stripe does.
 * Every call is one native request under a stable idempotency key, so a lost
 * response is retried against Stripe's own record of the first attempt.
 */
export async function executeRefund(db: DbClient, stripe: Stripe, payment: Payment, amount: number | null, key: string, reason: Stripe.RefundCreateParams.Reason, actor: string | null, env: CloudflareEnv, note: string | null = null) {
  if (amount !== null) assertMinorAmount(amount)
  if (!payment.stripe_payment_intent_id) throw new HTTPError({ statusCode: 409, statusMessage: 'Payment has no captured provider object' })
  const existing = await queryFirst<{id:string;stripe_refund_id:string|null;amount:number|null;attempted_at:string|null;note:string|null}>(db,'SELECT id,stripe_refund_id,amount,attempted_at,note FROM payment_refunds WHERE payment_id=? AND idempotency_key=?',[payment.id,key])
  if (existing?.stripe_refund_id) return await reconcileRefundState(db,stripe,payment,existing.stripe_refund_id,env)
  if (existing && existing.amount !== amount) throw new HTTPError({statusCode:409,statusMessage:'Refund retry amount differs from durable intent'})
  if (existing?.attempted_at && Date.now() - Date.parse(existing.attempted_at) > REFUND_IDEMPOTENCY_WINDOW_MS) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'An earlier refund request for this payment got no answer and is past Stripe’s idempotency window. Check the payment’s refunds in Stripe before refunding it again.' })
  }
  const now = new Date().toISOString(), id = existing?.id ?? crypto.randomUUID()
  if (!existing) await execute(db, `INSERT INTO payment_refunds(id,payment_id,idempotency_key,amount,reason,note,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,'creating',?,?,?)`, [id,payment.id,key,amount,reason,note,actor,now,now])
  let refund:Stripe.Refund
  try {
    await execute(db,"UPDATE payment_refunds SET status='creating',attempted_at=COALESCE(attempted_at,?),updated_at=? WHERE id=?",[now,now,id])
    const message=existing?.note??note
    refund=await stripe.refunds.create({payment_intent:payment.stripe_payment_intent_id,...(amount===null?{}:{amount}),reason,metadata:{krabiclaw_refund_id:id,...(message?{note:message.slice(0,500)}:{})}},{stripeAccount:payment.stripe_account_id,idempotencyKey:`krabiclaw-refund:${payment.id}:${key}`})
  }catch(error){
    await execute(db,'UPDATE payment_refunds SET error=?,updated_at=? WHERE id=?',[error instanceof Error?error.message:String(error),new Date().toISOString(),id])
    throw error
  }
  if (refund.currency.toUpperCase() !== payment.currency || (amount !== null && refund.amount !== amount)) throw new Error('Stripe refund financial scope mismatch')
  return await reconcileRefundState(db,stripe,payment,refund,env)
}

/** Native refund state is independent of booking and fulfillment state. */
export async function reconcileRefundState(db:DbClient,stripe:Stripe,payment:Payment,source:string|Stripe.Refund,env:CloudflareEnv) {
 const refund=typeof source==='string'?await stripe.refunds.retrieve(source,{}, {stripeAccount:payment.stripe_account_id}):source
 const intentId=typeof refund.payment_intent==='string'?refund.payment_intent:refund.payment_intent?.id
 if((typeof source==='string'&&refund.id!==source)||refund.currency.toUpperCase()!==payment.currency||intentId!==payment.stripe_payment_intent_id)throw new Error('Native refund identity does not match payment')
 assertMinorAmount(refund.amount)
 const kind=refund.status==='pending'||refund.status==='requires_action'?'refund_pending':refund.status==='succeeded'?'refund_succeeded':refund.status==='failed'?'refund_failed':refund.status==='canceled'?'refund_canceled':null
 if(!kind)throw new Error('Native refund status is missing or unsupported')
 const matched=await queryFirst<{id:string;amount:number|null}>(db,'SELECT id,amount FROM payment_refunds WHERE payment_id=? AND (stripe_refund_id=? OR id=?)',[payment.id,refund.id,refund.metadata?.krabiclaw_refund_id??''])
 // A partial refund was approved at one amount; a full-remaining one takes whatever Stripe returned.
 if(matched&&matched.amount!==null&&matched.amount!==refund.amount)throw new Error('Native refund amount changed from authorized intent')
 const id=matched?.id??crypto.randomUUID(),now=new Date().toISOString()
 await executeBatch(db,[
  {query:`INSERT INTO payment_refunds(id,payment_id,idempotency_key,stripe_refund_id,amount,reason,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET stripe_refund_id=excluded.stripe_refund_id,amount=excluded.amount,status=excluded.status,error=NULL,updated_at=excluded.updated_at`,params:[id,payment.id,`provider:${payment.stripe_account_id}:${payment.livemode}:${refund.id}`,refund.id,refund.amount,refund.reason??'provider',refund.status,now,now]},
  {query:"UPDATE payments SET refunded_amount=(SELECT COALESCE(SUM(amount),0) FROM payment_refunds WHERE payment_id=? AND status='succeeded'),updated_at=? WHERE id=?",params:[payment.id,now,payment.id]},
  {query:`UPDATE payment_authorizations SET consumed_at=COALESCE(consumed_at,?) WHERE payment_id=? AND approved_at IS NOT NULL AND action='refund' AND EXISTS(SELECT 1 FROM payment_refunds r WHERE r.id=? AND r.payment_id=payment_authorizations.payment_id AND r.idempotency_key='approved:'||payment_authorizations.id AND (payment_authorizations.amount IS NULL OR r.amount=payment_authorizations.amount) AND r.created_by=payment_authorizations.user_id)`,params:[now,payment.id,id]},
 ])
 await publishPaymentNotification(env,payment,{kind,nativeId:refund.id,status:refund.status!,amount:refund.amount})
 if(refund.status==='succeeded')await recordPaymentRefunded(db,payment,refund,id)
 return {id,stripe_refund_id:refund.id,status:refund.status}
}
