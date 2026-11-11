import {defineHandler,HTTPError} from 'nitro'
import {cloudflareEnv,jsonResponse} from '~/server/utils/api-response'
import {getAuthSession} from '~/server/utils/auth'
import {countUnreadAsGuest} from '~/server/domain/guest-threads/repository'

/** The person's own unread conversations as a guest, for their account's Messages count: the count their list's rows show. */
export default defineHandler(async event=>{
 const env=cloudflareEnv(event),session=await getAuthSession(event,env)
 if(!session)throw new HTTPError({statusCode:401,statusMessage:'Sign in to view your messages'})
 return jsonResponse({count:await countUnreadAsGuest(env.DB,session.user.id)},{headers:{'cache-control':'private, no-store'}})
})
