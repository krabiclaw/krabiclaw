import {defineHandler,HTTPError} from 'nitro'
import {getRouterParam} from 'nitro/h3'
import {cloudflareEnv,jsonResponse} from '~/server/utils/api-response'
import {getAuthSession} from '~/server/utils/auth'
import {isDashboardRecordType,loadBuyerBookingDetails} from '~/server/utils/dashboard-booking-details'
/** The account's own booking, in the shape the business's booking screen already reads. */
export default defineHandler(async event=>{
 const env=cloudflareEnv(event),session=await getAuthSession(event,env)
 if(!session)throw new HTTPError({statusCode:401,statusMessage:'Sign in to view your booking'})
 const bookingType=getRouterParam(event,'booking_type'),bookingId=getRouterParam(event,'record_id')
 if(!isDashboardRecordType(bookingType)||!bookingId)throw new HTTPError({statusCode:400,statusMessage:'Valid record type and ID are required'})
 const booking=await loadBuyerBookingDetails(env.DB,env,session.user.id,bookingType,bookingId)
 return jsonResponse({booking},{headers:{'cache-control':'private, no-store'}})
})
