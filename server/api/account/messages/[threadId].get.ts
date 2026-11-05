import {defineHandler,HTTPError} from 'nitro'
import {getRouterParam} from 'nitro/h3'
import {cloudflareEnv,jsonResponse} from '~/server/utils/api-response'
import {getAuthSession} from '~/server/utils/auth'
import {getGuestRequest} from '~/server/domain/requests'
import {getInboxThread} from '~/server/domain/guest-threads/inbox'

export default defineHandler(async event=>{
 const env=cloudflareEnv(event),session=await getAuthSession(event,env)
 if(!session)throw new HTTPError({statusCode:401,statusMessage:'Sign in to view your messages'})
 const id=getRouterParam(event,'threadId')
 const request=id?await getGuestRequest(env.DB,id):null
 const thread=request?await getInboxThread(env.DB,request.id,request.organization_id,{audience:'buyer',userId:session.user.id}):null
 if(!thread)throw new HTTPError({statusCode:404,statusMessage:'Conversation not found'})
 return jsonResponse({thread},{headers:{'cache-control':'private, no-store'}})
})
