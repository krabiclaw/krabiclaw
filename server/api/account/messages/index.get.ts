import {defineHandler,HTTPError} from 'nitro'
import {getQuery} from 'nitro/h3'
import {cloudflareEnv,jsonResponse} from '~/server/utils/api-response'
import {getAuthSession} from '~/server/utils/auth'
import {listGuestThreads} from '~/server/domain/guest-threads/repository'
import {guestThreadListPage,parseGuestThreadListQuery} from '~/server/utils/dashboard-guest-threads'

export default defineHandler(async event=>{
 const env=cloudflareEnv(event),session=await getAuthSession(event,env)
 if(!session)throw new HTTPError({statusCode:401,statusMessage:'Sign in to view your messages'})
 const supplied=getQuery(event)
 for(const field of ['conversation_state','location_id'])if(supplied[field]!==undefined)throw new HTTPError({statusCode:400,message:`Personal messages cannot use the merchant filter ${field}`,data:{code:'INVALID_GUEST_THREAD_FILTER',field}})
 const query=parseGuestThreadListQuery(supplied)
 const threads=await listGuestThreads(env.DB,null,{...query,limit:(query.limit??100)+1,userId:session.user.id,buyerAudience:true})
 return jsonResponse(guestThreadListPage(threads,query),{headers:{'cache-control':'private, no-store'}})
})
