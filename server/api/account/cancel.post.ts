import {defineHandler,HTTPError} from 'nitro'
import {cloudflareEnv,jsonResponse,readRequiredBody} from '~/server/utils/api-response'
import {getAuthSession} from '~/server/utils/auth'
import {requireFinancialBrowserOrigin} from '~/server/utils/financial-browser'
import {ownedBuyerRequest} from '~/server/domain/payments/buyer'
import {cancelBookingRequest} from '~/server/domain/requests'
import {cancelStayAsGuest} from '~/server/domain/stays'
import {queryFirst} from '~/server/db'
import {notifyGuestCancellation,notifyStayCancelled} from '~/server/utils/notifications'

export default defineHandler(async event=>{
 const env=cloudflareEnv(event),session=await getAuthSession(event,env)
 if(!session)throw new HTTPError({statusCode:401,statusMessage:'Sign in to manage your booking'})
 requireFinancialBrowserOrigin(event)
 const body=await readRequiredBody<{request_id?:string}>(event)
 if(!body||typeof body.request_id!=='string'||!body.request_id)throw new HTTPError({statusCode:400,statusMessage:'Booking request is required'})
 const scope=await ownedBuyerRequest(env.DB,session.user.id,body.request_id)
 if(scope.kind==='stay'){
  // The stay's own policy decides the refund; a retry finishes a refund or notice that did not go.
  const stay=await queryFirst<{id:string}>(env.DB,'SELECT id FROM stays WHERE organization_id=? AND request_id=? AND user_id=?',[scope.organization_id,body.request_id,session.user.id])
  if(!stay)throw new HTTPError({statusCode:404,statusMessage:'Owned stay not found'})
  const cancelled=await cancelStayAsGuest(env.DB,env,scope.organization_id,stay.id,session.user.id)
  await notifyStayCancelled(env,env.DB,scope.organization_id,stay.id,'guest',cancelled.refund_minor)
  return jsonResponse({success:true,kind:'stay',status:'cancelled',refund_minor:cancelled.refund_minor})
 }
 const cancelled=await cancelBookingRequest(env.DB,{id:body.request_id,organizationId:scope.organization_id,kind:scope.kind,buyerUserId:session.user.id,now:new Date().toISOString(),env})
 if(!cancelled)throw new HTTPError({statusCode:409,statusMessage:'This booking can no longer be cancelled'})
 await notifyGuestCancellation(env,env.DB,cancelled)
 return jsonResponse({success:true,kind:cancelled.record.kind,status:'cancelled'})
})
