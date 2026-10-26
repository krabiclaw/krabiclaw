import {defineHandler,HTTPError} from 'nitro'
import {cloudflareEnv,jsonResponse,readRequiredBody} from '~/server/utils/api-response'
import {getAuthSession} from '~/server/utils/auth'
import {requireFinancialBrowserOrigin} from '~/server/utils/financial-browser'
import {createDb} from '~/server/db'
import {respondToBookingChange} from '~/server/domain/guest-threads/booking-changes'
import {publishGuestInboxThreadEvent} from '~/server/cloudflare/guest-inbox-events'
/** The buyer accepts or declines a change on the booking itself, as on Airbnb's reservation; the email link takes the same path. */
export default defineHandler(async event=>{
 const env=cloudflareEnv(event),session=await getAuthSession(event,env)
 if(!session)throw new HTTPError({statusCode:401,statusMessage:'Sign in to answer this change'})
 requireFinancialBrowserOrigin(event)
 const body=await readRequiredBody<{thread_id?:string;request_id?:string;decision?:string}>(event)
 if(typeof body.thread_id!=='string'||!body.thread_id||typeof body.request_id!=='string'||!body.request_id)throw new HTTPError({statusCode:400,statusMessage:'Change request is required'})
 if(body.decision!=='accept'&&body.decision!=='decline')throw new HTTPError({statusCode:400,statusMessage:'Choose accept or decline'})
 const db=createDb(env.DB)
 const result=await respondToBookingChange(db,env,{threadId:body.thread_id,requestId:body.request_id,decision:body.decision,buyerUserId:session.user.id})
 await publishGuestInboxThreadEvent(env,db,{threadId:body.thread_id,type:'thread.changed'})
 return jsonResponse(result)
})
