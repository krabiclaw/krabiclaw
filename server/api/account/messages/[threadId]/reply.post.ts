import {defineHandler,HTTPError} from 'nitro'
import {getRouterParam,readBody} from 'nitro/h3'
import {cloudflareEnv,jsonResponse} from '~/server/utils/api-response'
import {getAuthSession} from '~/server/utils/auth'
import {requireFinancialBrowserOrigin} from '~/server/utils/financial-browser'
import {getGuestRequest} from '~/server/domain/requests'
import {getGuestThreadDetail} from '~/server/domain/guest-threads/detail'
import {receiveGuestWebReply} from '~/server/domain/guest-threads/inbound-email'
import {MAX_IMAGE_BYTES} from '~/server/utils/media-mime'
import {MAX_MESSAGE_PHOTOS,MessagePhotoRejection} from '~/server/domain/guest-threads/attachments'

export default defineHandler(async event=>{
 const env=cloudflareEnv(event),session=await getAuthSession(event,env)
 if(!session)throw new HTTPError({statusCode:401,statusMessage:'Sign in to reply'})
 requireFinancialBrowserOrigin(event)
 const threadId=getRouterParam(event,'threadId')
 if(!threadId)throw new HTTPError({statusCode:400,statusMessage:'Conversation ID is required'})
 // The conversation is the account's before anything it sent is read.
 const request=await getGuestRequest(env.DB,threadId)
 if(!request||!await getGuestThreadDetail(env.DB,threadId,request.organization_id,{buyerUserId:session.user.id}))throw new HTTPError({statusCode:404,statusMessage:'Conversation not found'})
 const multipart=event.req.headers.get('content-type')?.startsWith('multipart/form-data')??false
 const declared=Number(event.req.headers.get('content-length')??'0')
 if(multipart&&(!Number.isFinite(declared)||declared>MAX_MESSAGE_PHOTOS*MAX_IMAGE_BYTES+64*1024))throw new HTTPError({statusCode:413,statusMessage:`A message can carry at most ${MAX_MESSAGE_PHOTOS} photos of 10 MB.`})
 const form=multipart?await event.req.formData():null,body=form?null:await readBody<unknown>(event)
 const field=(name:string)=>{
  const value=form?form.get(name):body&&typeof body==='object'&&name in body?Reflect.get(body,name):undefined
  return typeof value==='string'?value:undefined
 }
 const parts=form?.getAll('photos')??[]
 if(parts.some(part=>!(part instanceof File)))throw new HTTPError({statusCode:400,statusMessage:'Message photos must be files'})
 if(parts.length>MAX_MESSAGE_PHOTOS)throw new HTTPError({statusCode:400,statusMessage:`A message can carry at most ${MAX_MESSAGE_PHOTOS} photos.`})
 if(parts.some(part=>part instanceof File&&part.size>MAX_IMAGE_BYTES))throw new HTTPError({statusCode:400,statusMessage:'Message photos must be no larger than 10 MB.'})
 const photos=await Promise.all(parts.filter((part):part is File=>part instanceof File).map(async part=>({bytes:new Uint8Array(await part.arrayBuffer()),filename:part.name||'photo'})))
 try {
  await receiveGuestWebReply(env,{threadId,userId:session.user.id,body:field('body')??'',photos,idempotencyKey:field('idempotencyKey')??''})
 }catch(error){
  if(error instanceof MessagePhotoRejection)throw new HTTPError({statusCode:400,statusMessage:error.message})
  throw error
 }
 const thread=await getGuestThreadDetail(env.DB,threadId,request.organization_id,{buyerUserId:session.user.id})
 if(!thread)throw new HTTPError({statusCode:404,statusMessage:'Conversation not found'})
 return jsonResponse({thread},{headers:{'cache-control':'private, no-store'}})
})
