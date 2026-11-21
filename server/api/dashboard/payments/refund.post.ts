import {requireFinancialBrowserOrAppRequest} from '~/server/utils/financial-browser'
import {defineHandler,HTTPError} from 'nitro'
import {getDashboardContext} from '~/server/utils/dashboard-context'
import {jsonResponse,readRequiredBody} from '~/server/utils/api-response'
import {requestRefundAuthorization,approveRefundAuthorization,refundPayment,executeRefund,requirePayment} from '~/server/domain/payments'
import {queryAll,queryFirst,type DbClient} from '~/server/db'
import {executeBookingStatus} from '~/server/domain/guest-threads/operations'
import {paymentsStripe} from '~/server/utils/stripe-connect'
import {visitRefundKey,type VisitRefundAction} from '~/server/domain/payments/visit-refund'
import type Stripe from 'stripe'
import type {CloudflareEnv} from '~/server/utils/auth'

/** The refunds a booking's approved cancellation or decline queued, one per payment that held money. */
function bookingRefunds(db:DbClient,organizationId:string,bookingId:string,action:VisitRefundAction){
 return queryAll<{payment_id:string;idempotency_key:string}>(db,`SELECT f.payment_id,f.idempotency_key FROM payment_refunds f JOIN payments p ON p.id=f.payment_id
   WHERE p.organization_id=? AND p.subject_type='booking' AND p.subject_id=? AND f.idempotency_key=?||':'||p.id ORDER BY p.created_at,p.id`,[organizationId,bookingId,visitRefundKey(action,bookingId)])
}

/** Every queued refund sent to Stripe; the first failure is reported after the rest were tried. */
async function executeBookingRefunds(db:DbClient,stripe:Stripe,env:CloudflareEnv,organizationId:string,rows:{payment_id:string;idempotency_key:string}[],userId:string,note:string|null){
 const settled=await Promise.allSettled(rows.map(async row=>executeRefund(db,stripe,await requirePayment(db,organizationId,row.payment_id),null,row.idempotency_key,'requested_by_customer',userId,env,note??undefined)))
 const failed=settled.find(result=>result.status==='rejected')
 if(failed)throw failed.reason
 return settled.map(result=>(result as PromiseFulfilledResult<Awaited<ReturnType<typeof executeRefund>>>).value)
}
import {stayAccessFor} from '~/server/domain/stays'
import {memberAccessPrincipal} from '~/server/utils/member-access'
import {notifyStayCancelled} from '~/server/utils/notifications'
/** The first refund's fields, as a single payment's refund answers, and every refund the booking's action sent. */
function bookingRefundAnswer(refunds:Awaited<ReturnType<typeof executeRefund>>[]){
 if(!refunds[0])throw new Error('A booking refund sent nothing')
 return {...refunds[0],refunds}
}

export default defineHandler(async event=>{
 requireFinancialBrowserOrAppRequest(event)
 const {env,db,organization,userId}=await getDashboardContext(event,{})
 const principal={organizationId:organization.id,userId,role:organization.role}
 const body=await readRequiredBody<{payment_id?:string;amount?:number;authorization_id?:string;action?:string;note?:string}>(event)
 if(body.action==='prepare' && body.payment_id && typeof body.amount==='number') return jsonResponse(await requestRefundAuthorization(db,principal,body.payment_id,body.amount,'refund',typeof body.note==='string'?body.note:undefined))
 if(body.action!=='approve' || !body.authorization_id) throw new HTTPError({statusCode:400,statusMessage:'Explicit refund approval required'})
 await approveRefundAuthorization(db,principal,body.authorization_id)
 const authorization=await queryFirst<{action:string;payment_id:string;amount:number|null;note:string|null}>(db,'SELECT action,payment_id,amount,note FROM payment_authorizations WHERE id=? AND organization_id=? AND user_id=?',[body.authorization_id,organization.id,userId])
 if(!authorization) throw new HTTPError({statusCode:404,statusMessage:'Refund authorization is unavailable'})
 const stripe=paymentsStripe(env,Boolean((await requirePayment(db,organization.id,authorization.payment_id)).livemode))
 const paid=authorization.action==='reject_booking'||authorization.action==='cancel_booking'?await requirePayment(db,organization.id,authorization.payment_id):null
 if(paid&&(paid.subject_type!=='booking'||!paid.subject_id)) throw new HTTPError({statusCode:409,statusMessage:'Authorization is not for a booking payment'})
 const booked=paid?await queryFirst<{conversation_id:string|null;status:string;version:number;nights:number}>(db,"SELECT (SELECT c.id FROM conversations c WHERE c.booking_id=b.id AND c.kind='booking') AS conversation_id,b.status,b.version,b.product_session_id IS NULL AS nights FROM bookings b WHERE b.id=? AND b.organization_id=?",[paid.subject_id,organization.id]):null
 if(paid&&!booked) throw new HTTPError({statusCode:409,statusMessage:'Paid booking is unavailable'})
 // A stay has channel publication and sends its cancellation receipt with the refunded amount.
 if(paid&&booked&&authorization.action==='cancel_booking'&&booked.nights===1){
  const payment=paid,stay=booked
  const earlierRefund=(await bookingRefunds(db,organization.id,payment.subject_id!,'cancel')).length>0
  const access=await stayAccessFor(memberAccessPrincipal(organization,{env,event}))
  const failures:unknown[]=[]
  try {
   await executeBookingStatus(db, {
    env, organizationId: organization.id, actorUserId: userId, actorRole: principal.role, bookingId: payment.subject_id!, threadId: stay.conversation_id,
    action: 'cancel', version: stay.version, reason: authorization.note ?? undefined, financialAuthorizationId: body.authorization_id, stayAccess: access,
   })
  } catch(error) {
   // A first cancellation must commit before money moves. An already approved
   // durable refund still completes when its cancelled stay's repair fails.
   if(!(error instanceof HTTPError&&error.data?.committed===true)&&!(stay.status==='cancelled'&&earlierRefund))throw error
   failures.push(error)
  }
  const rows=await bookingRefunds(db,organization.id,payment.subject_id!,'cancel')
  const [refunded]=await Promise.allSettled([(async()=>{
   if(!rows.length)throw new HTTPError({statusCode:409,statusMessage:'The stay was cancelled without its refund. Send a refund from the stay.'})
   return executeBookingRefunds(db,stripe,env,organization.id,rows,userId,authorization.note)
  })()])
  if(refunded.status==='rejected')failures.push(refunded.reason)
  try {
   // The guest is told the whole amount returned, across every month they paid.
   let total=0
   for(const row of rows){
    const refund=await queryFirst<{amount:number|null;status:string;stripe_refund_id:string|null}>(db,'SELECT amount,status,stripe_refund_id FROM payment_refunds WHERE payment_id=? AND idempotency_key=?',[row.payment_id,row.idempotency_key])
    if(!refund?.stripe_refund_id||refund.amount===null||!Number.isSafeInteger(refund.amount)||refund.amount<0)throw new Error('The stay refund has no confirmed native amount; retry this approval to finish its notice')
    total+=refund.amount
   }
   await notifyStayCancelled(env,db,organization.id,payment.subject_id!,'host',total)
  } catch(error) {
   failures.push(error)
  }
  if(failures.length===1&&failures[0] instanceof HTTPError&&failures[0].data?.committed===true)throw failures[0]
  if(failures.length||refunded.status==='rejected'){
   const reason=failures.map(error=>error instanceof Error?error.message:String(error)).join(' ')
   throw new HTTPError({statusCode:503,message:`The stay was cancelled, but its completion failed. ${reason}`,data:{code:'POST_WRITE_COMPLETION_FAILED',field:'completion',committed:true,booking_id:payment.subject_id,payment_id:payment.id,reason,failures:failures.map(error=>error instanceof HTTPError&&error.data?error.data:{reason:error instanceof Error?error.message:String(error)})},cause:new AggregateError(failures,reason)})
  }
  return jsonResponse(bookingRefundAnswer(refunded.value))
 }
 if(paid&&booked){
  const action:VisitRefundAction=authorization.action==='reject_booking'?'reject':'cancel'
  const payment=paid,booking=booked
  if(!booking.conversation_id) throw new HTTPError({statusCode:409,statusMessage:'Paid booking request is unavailable'})
  const status=await executeBookingStatus(db,{threadId:booking.conversation_id,organizationId:organization.id,bookingId:payment.subject_id!,version:booking.version,action,actorUserId:userId,actorRole:principal.role,idempotencyKey:`paid-${action}:${body.authorization_id}`,financialAuthorizationId:body.authorization_id,...(authorization.note?{body:authorization.note}:{}),env})
  if(status.kind!=='booking') throw new Error('Timed booking refund changed its inventory unit')
  const {outcome}=status
  const rows=await bookingRefunds(db,organization.id,payment.subject_id!,action)
  if(!rows.length) throw new HTTPError({statusCode:409,statusMessage:outcome.ok?'Refund intent missing':`Booking ${action==='reject'?'rejection':'cancellation'} could not be committed`})
  const refunds=await executeBookingRefunds(db,stripe,env,organization.id,rows,userId,authorization.note)
  const submitted=bookingRefundAnswer(refunds)
  if(!outcome.ok)throw new HTTPError({statusCode:outcome.status,statusMessage:`Refund submitted, but the booking ${action==='reject'?'rejection':'cancellation'} notification did not complete. Retry this approval to finish it.`,data:{refund:submitted,operation:outcome}})
  return jsonResponse(submitted)
 }
 return jsonResponse(await refundPayment(db,stripe,principal,body.authorization_id,env))
})
