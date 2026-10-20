import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { memberSchedulingList } from '~/server/domain/member-scheduling'
export default defineHandler(async event=>{const env=cloudflareEnv(event),session=await getAuthSession(event,env),organizationId=getRouterParam(event,'organizationId');if(!session?.user.id||!organizationId)throw new HTTPError({statusCode:401,message:'Sign in required'});return jsonResponse(await memberSchedulingList({env,userId:session.user.id,organizationId}))})
