import {requireFinancialBrowserOrigin} from '~/server/utils/financial-browser'
import {defineHandler,HTTPError} from 'nitro'
import {getDashboardContext} from '~/server/utils/dashboard-context'
import {jsonResponse,readRequiredBody} from '~/server/utils/api-response'
import {requestRefundAuthorization,approveRefundAuthorization,refundPayment,executeRefund,requirePayment} from '~/server/domain/payments'
import {queryFirst} from '~/server/db'
import {executeGuestThreadOperation} from '~/server/domain/guest-threads/operations'
import {createStripeClient} from '~/server/utils/stripe-client'
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
 if(!env.STRIPE_SECRET_KEY) throw new HTTPError({statusCode:503,statusMessage:'Stripe is not configured'})
 await approveRefundAuthorization(db,principal,body.authorization_id)
 const authorization=await queryFirst<{action:string;payment_id:string;amount:number|null;note:string|null}>(db,'SELECT action,payment_id,amount,note FROM payment_authorizations WHERE id=? AND organization_id=? AND user_id=?',[body.authorization_id,organization.id,userId])
 if(authorization?.action==='cancel_stay'){
  const payment=await requirePayment(db,organization.id,authorization.payment_id)
  if(payment.subject_type!=='stay'||!payment.subject_id) throw new HTTPError({statusCode:409,statusMessage:'Authorization is not for a stay payment'})
  // A retry after the stay was cancelled only sends the refund that cancellation queued.
  const stay=await queryFirst<{status:string;version:number}>(db,'SELECT status,version FROM stays WHERE id=? AND organization_id=?',[payment.subject_id,organization.id])
  if(!stay) throw new HTTPError({statusCode:409,statusMessage:'Paid stay is unavailable'})
  if(stay.status!=='cancelled') await cancelStay(db,env,await stayAccessFor(memberAccessPrincipal(organization,{env,event})),payment.subject_id,{expected_version:stay.version,reason:authorization.note,authorization_id:body.authorization_id})
  const key=visitRefundKey('cancel','stay',payment.subject_id)
  if(!await queryFirst(db,'SELECT id FROM payment_refunds WHERE payment_id=? AND idempotency_key=?',[payment.id,key])) throw new HTTPError({statusCode:409,statusMessage:'The stay was cancelled without its refund. Send a refund from the stay.'})
  const submitted=await executeRefund(db,createStripeClient(env.STRIPE_SECRET_KEY,'payments'),payment,null,key,'requested_by_customer',userId,env,authorization.note)
  await notifyStayCancelled(env,db,organization.id,payment.subject_id,'host',payment.captured_amount-payment.refunded_amount)
  return jsonResponse(submitted)
 }
 if(authorization?.action==='reject_booking'||authorization?.action==='cancel_booking'||authorization?.action==='cancel_reservation'){
  const action:VisitRefundAction=authorization.action==='reject_booking'?'reject':'cancel'
  const payment=await requirePayment(db,organization.id,authorization.payment_id)
  if((payment.subject_type!=='booking'&&payment.subject_type!=='reservation')||!payment.subject_id || (authorization.action==='cancel_reservation')!==(payment.subject_type==='reservation')) throw new HTTPError({statusCode:409,statusMessage:'Authorization is not for a booking payment'})
  const booking=await queryFirst<{request_id:string|null}>(db,`SELECT request_id FROM ${payment.subject_type==='booking'?'bookings':'reservations'} WHERE id=? AND organization_id=?`,[payment.subject_id,organization.id])
  if(!booking?.request_id) throw new HTTPError({statusCode:409,statusMessage:'Paid booking request is unavailable'})
  const outcome=await executeGuestThreadOperation(db,{threadId:booking.request_id,organizationId:organization.id,action,actorUserId:userId,idempotencyKey:`paid-${action}:${body.authorization_id}`,financialAuthorizationId:body.authorization_id,...(authorization.note?{body:authorization.note}:{}),env})
  const key=visitRefundKey(action,payment.subject_type,payment.subject_id)
  const refund=await queryFirst(db,'SELECT id FROM payment_refunds WHERE payment_id=? AND idempotency_key=?',[payment.id,key])
  if(!refund) throw new HTTPError({statusCode:409,statusMessage:outcome.ok?'Refund intent missing':`Booking ${action==='reject'?'rejection':'cancellation'} could not be committed`})
  const submitted=await executeRefund(db,createStripeClient(env.STRIPE_SECRET_KEY, 'payments'),payment,null,key,'requested_by_customer',userId,env,authorization.note)
  if(!outcome.ok)throw new HTTPError({statusCode:outcome.status,statusMessage:`Refund submitted, but the booking ${action==='reject'?'rejection':'cancellation'} notification did not complete. Retry this approval to finish it.`,data:{refund:submitted,operation:outcome}})
  return jsonResponse(submitted)
 }
 return jsonResponse(await refundPayment(db,createStripeClient(env.STRIPE_SECRET_KEY, 'payments'),principal,body.authorization_id,env))
})
