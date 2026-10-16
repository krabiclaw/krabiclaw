import {HTTPError} from 'nitro'
import {queryFirst,type BatchQuery,type DbClient} from '~/server/db'
import {authorizePayments,requestRefundAuthorization,type Payment} from './index'
import { isRecord } from '~/server/utils/type-guards'

/** Declining or cancelling a paid visit or stay returns the whole payment, as Airbnb's host cancellation does. */
export type VisitRefundAction='reject'|'cancel'
export type VisitRefundSubject='booking'|'reservation'|'stay'
export const visitRefundKey=(action:VisitRefundAction,subjectType:VisitRefundSubject,subjectId:string)=>`${action==='reject'?'rejected':subjectType==='reservation'?'cancelled-reservation':subjectType==='stay'?'cancelled-stay':'cancelled'}:${subjectId}`
const authorizationActionFor=(action:VisitRefundAction,subjectType:VisitRefundSubject)=>subjectType==='stay'?'cancel_stay':subjectType==='reservation'?'cancel_reservation':action==='reject'?'reject_booking':'cancel_booking'

/** Extends the canonical visit operation's batch, never a second booking writer. */
/** `committed` is the caller's own write in the same batch: the refund is queued only where it took effect. */
export async function visitRefundQueries(db:DbClient,input:{action:VisitRefundAction;organizationId:string;actorUserId:string;subjectType:VisitRefundSubject;subjectId:string;authorizationId?:string;financialWritesAllowed?:boolean;note?:string;committed:BatchQuery;now:string}):Promise<{queries:BatchQuery[];guard:BatchQuery|null}> {
 const payment=await queryFirst<Payment>(db,'SELECT * FROM payments WHERE organization_id=? AND subject_type=? AND subject_id=? AND captured_amount>refunded_amount',[input.organizationId,input.subjectType,input.subjectId])
 if(!payment)return {queries:[],guard:null}
 if(input.financialWritesAllowed===false&&input.subjectType==='stay'){
  const org=await queryFirst<{slug:string}>(db,'SELECT slug FROM organization WHERE id=?',[input.organizationId])
  if(!org?.slug)throw new HTTPError({statusCode:409,statusMessage:'Paid stay dashboard destination is unavailable'})
  throw new HTTPError({statusCode:409,statusMessage:'This paid stay requires a refund before cancellation can complete. Open it in the dashboard to review and approve the financial action. The stay has not changed.',data:{code:'financial_action_required',dashboard_url:`/dashboard/${encodeURIComponent(org.slug)}/bookings/stay/${encodeURIComponent(input.subjectId)}`}})
 }
 if(input.financialWritesAllowed===false){
  const destination=await queryFirst<{slug:string;request_id:string|null}>(db,`SELECT o.slug,b.request_id FROM organization o JOIN ${input.subjectType==='booking'?'bookings':'reservations'} b ON b.organization_id=o.id WHERE o.id=? AND b.id=?`,[input.organizationId,input.subjectId])
  if(!destination?.slug||!destination.request_id)throw new HTTPError({statusCode:409,statusMessage:'Paid booking dashboard destination is unavailable'})
  throw new HTTPError({statusCode:409,statusMessage:`This paid visit requires a refund before ${input.action==='reject'?'rejection':'cancellation'} can complete. Open its dashboard details to review and approve the financial action. The booking has not changed.`,data:{code:'financial_action_required',dashboard_url:`/dashboard/${encodeURIComponent(destination.slug)}/bookings/${input.subjectType}/${encodeURIComponent(destination.request_id)}`}})
 }
 const member=await queryFirst<{role:string}>(db,'SELECT role FROM member WHERE organizationId=? AND userId=?',[input.organizationId,input.actorUserId])
 if(!member)throw new HTTPError({statusCode:403,statusMessage:'Financial organization membership required'})
 const principal={organizationId:input.organizationId,userId:input.actorUserId,role:member.role}
 await authorizePayments(principal,'refund')
 const authorizationAction=authorizationActionFor(input.action,input.subjectType)
 const approval=input.authorizationId?await queryFirst(db,"SELECT id FROM payment_authorizations WHERE id=? AND organization_id=? AND user_id=? AND payment_id=? AND action=? AND amount IS NULL AND approved_at IS NOT NULL AND consumed_at IS NULL AND expires_at>?",[input.authorizationId,input.organizationId,input.actorUserId,payment.id,authorizationAction,input.now]):null
 if(!approval){
  const org=await queryFirst<{slug:string}>(db,'SELECT slug FROM organization WHERE id=?',[input.organizationId])
  if(!org?.slug)throw new HTTPError({statusCode:409,statusMessage:'Refund approval dashboard destination is unavailable'})
  const prepared=await requestRefundAuthorization(db,principal,payment.id,null,authorizationAction,input.note)
  throw new HTTPError({statusCode:409,statusMessage:`Paid ${input.action==='reject'?'rejection':'cancellation'} requires explicit approval of the full refund`,data:{code:'financial_approval_required',financial_approval_url:`/dashboard/${encodeURIComponent(org.slug)}/earnings/refunds/approve?id=${prepared.authorization_id}`}})
 }
 const pending=await queryFirst(db,"SELECT id FROM payment_refunds WHERE payment_id=? AND status IN ('queued','creating','pending','requires_action')",[payment.id])
 if(pending)throw new HTTPError({statusCode:409,statusMessage:'A refund is already in progress; reconcile it before changing this booking'})
 const id=crypto.randomUUID(),key=visitRefundKey(input.action,input.subjectType,input.subjectId)
 // The approval and the booking write are one batch: the payment still holds money and the approval is the one given for it.
 const guard={query:`EXISTS(SELECT 1 FROM payments p JOIN payment_authorizations a ON a.payment_id=p.id WHERE p.id=? AND p.organization_id=? AND p.captured_amount>p.refunded_amount AND a.id=? AND a.user_id=? AND a.action=? AND a.amount IS NULL AND a.approved_at IS NOT NULL AND a.consumed_at IS NULL AND a.expires_at>?)`,params:[payment.id,input.organizationId,input.authorizationId!,input.actorUserId,authorizationAction,input.now]}
 return {guard,queries:[
  {query:`INSERT INTO payment_refunds(id,payment_id,idempotency_key,amount,reason,note,status,created_by,created_at,updated_at) SELECT ?,?,?,NULL,'requested_by_customer',(SELECT note FROM payment_authorizations WHERE id=?),'queued',?,?,? WHERE ${input.committed.query} ON CONFLICT(idempotency_key) DO NOTHING`,params:[id,payment.id,key,input.authorizationId!,input.actorUserId,input.now,input.now,...(input.committed.params ?? [])]},
  {query:'UPDATE payment_authorizations SET consumed_at=? WHERE id=? AND EXISTS(SELECT 1 FROM payment_refunds WHERE idempotency_key=?)',params:[input.now,input.authorizationId!,key]},
 ]}
}

/** A guest's own cancellation inside the quoted deposit terms returns the deposit; cancellation always releases the table. */
export async function guestReservationRefundQueries(db: DbClient, input: {
 organizationId: string; reservationId: string; requestId: string; startsAt: string; now: string; buyerUserId?: string
}): Promise<{ queries: BatchQuery[]; guard: BatchQuery | null }> {
 const payment = await queryFirst<Payment>(db, "SELECT * FROM payments WHERE organization_id = ? AND subject_type = 'reservation' AND subject_id = ? AND captured_amount > refunded_amount", [input.organizationId, input.reservationId])
 if (!payment) return { queries: [], guard: null }
 const reservation = await queryFirst<{ policy_json: string | null }>(db, 'SELECT policy_json FROM reservations WHERE organization_id = ? AND id = ?', [input.organizationId, input.reservationId])
 const terms: unknown = reservation?.policy_json ? JSON.parse(reservation.policy_json) : null
 if (!isRecord(terms)) throw new Error('Paid reservation has no accepted cancellation terms')
 const cutoff = terms.free_cancellation_until_minutes
 if (cutoff !== null && (!Number.isSafeInteger(cutoff) || Number(cutoff) < 0)) throw new Error('Paid reservation cancellation cutoff is invalid')
 if (cutoff !== null && Date.parse(input.now) > Date.parse(input.startsAt) - Number(cutoff) * 60_000) return { queries: [], guard: null }
 const key = `guest-cancelled-reservation:${input.reservationId}`
 // One refund per cancellation: the batch refuses while an earlier one is still with Stripe.
 const guard: BatchQuery = {
  query: `EXISTS (SELECT 1 FROM payments p WHERE p.id = ? AND p.organization_id = ? AND p.captured_amount > p.refunded_amount
    AND NOT EXISTS (SELECT 1 FROM payment_refunds WHERE payment_id = p.id AND status IN ('queued','creating','pending','requires_action')))`,
  params: [payment.id, input.organizationId],
 }
 return { guard, queries: [{
  query: `INSERT INTO payment_refunds(id,payment_id,idempotency_key,amount,reason,status,created_by,created_at,updated_at)
    SELECT ?,?,?,NULL,'requested_by_customer','queued',?,?,? WHERE EXISTS (SELECT 1 FROM activity_entries WHERE request_id = ? AND dedupe_key = ?)
    ON CONFLICT(idempotency_key) DO NOTHING`,
  params: [crypto.randomUUID(), payment.id, key, input.buyerUserId ?? null, input.now, input.now, input.requestId, `reservation:${input.reservationId}:guest-cancel`],
 }] }
}

/** The caller authorizes the request through its buyer identity or emailed capability. */
export async function canRetryGuestReservationRefund(db: DbClient, input: {
 organizationId: string; reservationId: string; requestId: string; buyerUserId?: string
}): Promise<boolean> {
 return Boolean(await queryFirst(db, `SELECT f.id FROM payment_refunds f JOIN payments p ON p.id = f.payment_id
  JOIN reservations v ON v.id = p.subject_id AND v.organization_id = p.organization_id
  JOIN requests r ON r.id = v.request_id AND r.organization_id = v.organization_id AND r.kind = 'reservation'
  WHERE p.organization_id = ? AND p.subject_type = 'reservation' AND p.subject_id = ? AND r.id = ?
    AND v.status = 'cancelled' AND json_extract(r.payload_json, '$.cancellation.used_at') IS NOT NULL
    AND f.idempotency_key = 'guest-cancelled-reservation:' || v.id AND f.status IN ('queued', 'creating')
    AND EXISTS (SELECT 1 FROM activity_entries WHERE request_id = r.id AND dedupe_key = 'reservation:' || v.id || ':guest-cancel')
    ${input.buyerUserId ? 'AND r.user_id = ? AND v.user_id = ? AND p.buyer_user_id = ?' : ''}`,
 [input.organizationId, input.reservationId, input.requestId, ...(input.buyerUserId ? [input.buyerUserId, input.buyerUserId, input.buyerUserId] : [])]))
}
