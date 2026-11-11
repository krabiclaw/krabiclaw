import {defineHandler,HTTPError} from 'nitro'
import {getRouterParam} from 'nitro/h3'
import {cloudflareEnv,jsonResponse,readStrictBody} from '~/server/utils/api-response'
import {getAuthSession} from '~/server/utils/auth'
import {requireFinancialBrowserOrigin} from '~/server/utils/financial-browser'
import {getGuestRequest} from '~/server/domain/requests'
import {markConversationRead} from '~/server/domain/conversations'

/** The guest opened their conversation: it is read through `message_id`, the newest message they were shown. */
export default defineHandler(async event=>{
 const env=cloudflareEnv(event),session=await getAuthSession(event,env)
 if(!session)throw new HTTPError({statusCode:401,statusMessage:'Sign in to view your messages'})
 requireFinancialBrowserOrigin(event)
 const id=getRouterParam(event,'threadId')
 const request=id?await getGuestRequest(env.DB,id,undefined,undefined,session.user.id):null
 if(!request)throw new HTTPError({statusCode:404,statusMessage:'Conversation not found'})
 const body=await readStrictBody<{message_id?:string|null}>(event,{message_id:'nullable-string'})
 const read=await markConversationRead(env.DB,{organizationId:request.organization_id,conversationId:request.id,userId:session.user.id,throughMessageId:body.message_id??null})
 return jsonResponse(read,{headers:{'cache-control':'private, no-store'}})
})
