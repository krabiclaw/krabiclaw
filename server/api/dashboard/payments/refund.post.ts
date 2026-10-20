import {requireFinancialBrowserOrigin} from '~/server/utils/financial-browser'
import {defineHandler,HTTPError} from 'nitro'
import {getDashboardContext} from '~/server/utils/dashboard-context'
import {jsonResponse,readRequiredBody} from '~/server/utils/api-response'
import {requestRefundAuthorization,approveRefundAuthorization,refundPayment,executeRefund,requirePayment} from '~/server/domain/payments'
import {queryFirst} from '~/server/db'
import {executeGuestThreadOperation} from '~/server/domain/guest-threads/operations'
import {paymentsStripe} from '~/server/utils/stripe-connect'
import {visitRefundKey,type VisitRefundAction} from '~/server/domain/payments/visit-refund'
import {cancelStay,stayAccessFor} from '~/server/domain/stays'
import {memberAccessPrincipal} from '~/server/utils/member-access'
import {notifyStayCancelled} from '~/server/utils/notifications'
export default defineHandler(async event=>{
 requireFinancialBrowserOrigin(event)
 const {env,db,organization,userId}=await getDashboardContext(event,{})
 const principal={organizationId:organization.id,userId,role:organization.role}
 const body=await readRequiredBody<{payment_id?:string;amount?:number;authorization_id?:string;action?:string;note?:string}>(event)
 if(body.action==='prepare' && body.payment_id && typeof body.amount==='number') return jsonResponse(await requestRefundAuthorization(db,principal,body.payment_id,body.amount,'refund',typeof body.note==='string'?body.note:undefined))
 if(body.action!=='approve' || !body.authorization_id) throw new HTTPError({statusCode:400,statusMessage:'Explicit refund approval required'})
 await approveRefundAuthorization(db,principal,body.authorization_id)
 const authorization=await queryFirst<{action:string;payment_id:string;amount:number|null;note:string|null}>(db,'SELECT action,payment_id,amount,note FROM payment_authorizations WHERE id=? AND organization_id=? AND user_id=?',[body.authorization_id,organization.id,userId])
 if(!authorization) throw new HTTPError({statusCode:404,statusMessage:'Refund authorization is unavailable'})
 const stripe=paymentsStripe(env,Boolean((await requirePayment(db,organization.id,authorization.payment_id)).livemode))
 if(authorization.action==='cancel_stay'){
  const payment=await requirePayment(db,organization.id,authorization.payment_id)
  if(payment.subject_type!=='stay'||!payment.subject_id) throw new HTTPError({statusCode:409,statusMessage:'Authorization is not for a stay payment'})
  // An approved retry repairs the cancellation's channel and publication, too.
  const stay=await queryFirst<{status:string;version:number}>(db,'SELECT status,version FROM stays WHERE id=? AND organization_id=?',[payment.subject_id,organization.id])
  if(!stay) throw new HTTPError({statusCode:409,statusMessage:'Paid stay is unavailable'})
  const key=visitRefundKey('cancel','stay',payment.subject_id)
  const earlierRefund=await queryFirst(db,'SELECT id FROM payment_refunds WHERE payment_id=? AND idempotency_key=?',[payment.id,key])
  const access=await stayAccessFor(memberAccessPrincipal(organization,{env,event}))
  const failures:unknown[]=[]
  try {
   await cancelStay(db,env,access,payment.subject_id,{expected_version:stay.version,reason:authorization.note,authorization_id:body.authorization_id})
  } catch(error) {
   // A first cancellation must commit before money moves. An already approved
   // durable refund still completes when its cancelled stay's repair fails.
   if(!(error instanceof HTTPError&&error.data?.committed===true)&&!(stay.status==='cancelled'&&earlierRefund))throw error
   failures.push(error)
  }
  const [refunded]=await Promise.allSettled([queryFirst(db,'SELECT id FROM payment_refunds WHERE payment_id=? AND idempotency_key=?',[payment.id,key]).then(refund=>{
   if(!refund)throw new HTTPError({statusCode:409,statusMessage:'The stay was cancelled without its refund. Send a refund from the stay.'})
   return executeRefund(db,stripe,payment,null,key,'requested_by_customer',userId,env,authorization.note)
  })])
  if(refunded.status==='rejected')failures.push(refunded.reason)
  try {
   const refund=await queryFirst<{amount:number|null;status:string;stripe_refund_id:string|null}>(db,'SELECT amount,status,stripe_refund_id FROM payment_refunds WHERE payment_id=? AND idempotency_key=?',[payment.id,key])
   if(!refund?.stripe_refund_id||refund.amount===null||!Number.isSafeInteger(refund.amount)||refund.amount<0)throw new Error('The stay refund has no confirmed native amount; retry this approval to finish its notice')
   if(refunded.status==='fulfilled'&&(refund.status!==refunded.value.status||refund.stripe_refund_id!==refunded.value.stripe_refund_id))throw new Error('The cancelled stay refund could not be verified')
   await notifyStayCancelled(env,db,organization.id,payment.subject_id,'host',refund.amount)
  } catch(error) {
   failures.push(error)
  }
  if(failures.length===1&&failures[0] instanceof HTTPError&&failures[0].data?.committed===true)throw failures[0]
  if(failures.length||refunded.status==='rejected'){
   const reason=failures.map(error=>error instanceof Error?error.message:String(error)).join(' ')
   throw new HTTPError({statusCode:503,message:`The stay was cancelled, but its completion failed. ${reason}`,data:{code:'POST_WRITE_COMPLETION_FAILED',field:'completion',committed:true,stay_id:payment.subject_id,payment_id:payment.id,reason,failures:failures.map(error=>error instanceof HTTPError&&error.data?error.data:{reason:error instanceof Error?error.message:String(error)})},cause:new AggregateError(failures,reason)})
  }
  const submitted=refunded.value
  return jsonResponse(submitted)
 }
 if(authorization.action==='reject_booking'||authorization.action==='cancel_booking'||authorization.action==='cancel_reservation'){
  const action:VisitRefundAction=authorization.action==='reject_booking'?'reject':'cancel'
  const payment=await requirePayment(db,organization.id,authorization.payment_id)
  if((payment.subject_type!=='booking'&&payment.subject_type!=='reservation')||!payment.subject_id || (authorization.action==='cancel_reservation')!==(payment.subject_type==='reservation')) throw new HTTPError({statusCode:409,statusMessage:'Authorization is not for a booking payment'})
  const booking=await queryFirst<{request_id:string|null}>(db,`SELECT request_id FROM ${payment.subject_type==='booking'?'bookings':'reservations'} WHERE id=? AND organization_id=?`,[payment.subject_id,organization.id])
  if(!booking?.request_id) throw new HTTPError({statusCode:409,statusMessage:'Paid booking request is unavailable'})
  const outcome=await executeGuestThreadOperation(db,{threadId:booking.request_id,organizationId:organization.id,action,actorUserId:userId,idempotencyKey:`paid-${action}:${body.authorization_id}`,financialAuthorizationId:body.authorization_id,...(authorization.note?{body:authorization.note}:{}),env})
  const key=visitRefundKey(action,payment.subject_type,payment.subject_id)
  const refund=await queryFirst(db,'SELECT id FROM payment_refunds WHERE payment_id=? AND idempotency_key=?',[payment.id,key])
  if(!refund) throw new HTTPError({statusCode:409,statusMessage:outcome.ok?'Refund intent missing':`Booking ${action==='reject'?'rejection':'cancellation'} could not be committed`})
  const submitted=await executeRefund(db,stripe,payment,null,key,'requested_by_customer',userId,env,authorization.note)
  if(!outcome.ok)throw new HTTPError({statusCode:outcome.status,statusMessage:`Refund submitted, but the booking ${action==='reject'?'rejection':'cancellation'} notification did not complete. Retry this approval to finish it.`,data:{refund:submitted,operation:outcome}})
  return jsonResponse(submitted)
 }
 return jsonResponse(await refundPayment(db,stripe,principal,body.authorization_id,env))
})
