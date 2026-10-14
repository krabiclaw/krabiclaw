import {defineHandler,HTTPError} from 'nitro'
import {cloudflareEnv,jsonResponse,readRequiredBody} from '~/server/utils/api-response'
import {getAuthSession} from '~/server/utils/auth'
import {requireFinancialBrowserOrigin} from '~/server/utils/financial-browser'
import {ownedBuyerRequest} from '~/server/domain/payments/buyer'
import {cancelBookingRequest} from '~/server/domain/requests'
import {notifyGuestCancellation} from '~/server/utils/notifications'

export default defineHandler(async event=>{
 const env=cloudflareEnv(event),session=await getAuthSession(event,env)
 if(!session)throw new HTTPError({statusCode:401,statusMessage:'Sign in to manage your booking'})
 requireFinancialBrowserOrigin(event)
 const body=await readRequiredBody<{request_id?:string}>(event)
 if(!body||typeof body.request_id!=='string'||!body.request_id)throw new HTTPError({statusCode:400,statusMessage:'Booking request is required'})
 const scope=await ownedBuyerRequest(env.DB,session.user.id,body.request_id)
 const cancelled=await cancelBookingRequest(env.DB,{id:body.request_id,organizationId:scope.organization_id,kind:scope.kind,buyerUserId:session.user.id,now:new Date().toISOString(),env})
 if(!cancelled)throw new HTTPError({statusCode:409,statusMessage:'This booking can no longer be cancelled'})
 await notifyGuestCancellation(env,env.DB,cancelled)
 return jsonResponse({success:true,kind:cancelled.record.kind,status:'cancelled'})
})
