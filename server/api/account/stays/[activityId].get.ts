import {defineHandler,HTTPError} from 'nitro'
import {getRouterParam} from 'nitro/h3'
import {cloudflareEnv,jsonResponse} from '~/server/utils/api-response'
import {getAuthSession} from '~/server/utils/auth'
import {readGuestStay} from '~/server/domain/stays'

/** The account's own stay by its activity ID, with what cancelling it returns now. */
export default defineHandler(async event=>{
 const env=cloudflareEnv(event),session=await getAuthSession(event,env)
 if(!session)throw new HTTPError({statusCode:401,statusMessage:'Sign in to view your stay'})
 const activityId=getRouterParam(event,'activityId')
 if(!activityId)throw new HTTPError({statusCode:400,statusMessage:'Stay ID is required'})
 return jsonResponse(await readGuestStay(env.DB,session.user.id,activityId),{headers:{'cache-control':'private, no-store'}})
})
