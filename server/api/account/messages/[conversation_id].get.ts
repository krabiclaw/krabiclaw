import {defineHandler,HTTPError} from 'nitro'
import {getRouterParam} from 'nitro/h3'
import {cloudflareEnv,jsonResponse} from '~/server/utils/api-response'
import {getAuthSession} from '~/server/utils/auth'
import {readGuestConversation,parseTranscriptWindow} from '~/server/domain/conversations'
import {getInboxThread} from '~/server/domain/guest-threads/inbox'

export default defineHandler(async event=>{
 const env=cloudflareEnv(event),session=await getAuthSession(event,env)
 if(!session)throw new HTTPError({statusCode:401,statusMessage:'Sign in to view your messages'})
 const id=getRouterParam(event,'conversation_id')
 const window = parseTranscriptWindow(event.url.searchParams)
 const conversation = id ? await readGuestConversation(env.DB, session.user.id, id) : null
 const thread = conversation ? await getInboxThread(env.DB, conversation.id, conversation.organization_id, { audience: 'buyer', userId: session.user.id, conversation }, new Date(), window) : null
 if(!thread)throw new HTTPError({statusCode:404,statusMessage:'Conversation not found'})
 return jsonResponse({thread},{headers:{'cache-control':'private, no-store'}})
})
