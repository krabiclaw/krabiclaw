import { HTTPError } from 'nitro'
import type { H3Event } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { requireSchedulingAccess } from '~/server/domain/member-scheduling'
export async function memberSchedulingContext(event: H3Event) {
 const env=cloudflareEnv(event), organizationId=getRouterParam(event,'organization_id'), memberId=getRouterParam(event,'member_id')
 const session=await getAuthSession(event,env)
 if(!session?.user.id)throw new HTTPError({statusCode:401,message:'Sign in to manage your schedule'})
 if(!organizationId||!memberId)throw new HTTPError({statusCode:400,message:'Organization and member required'})
 const actor={env,organizationId,userId:session.user.id}
 await requireSchedulingAccess(actor,memberId)
 return {actor,memberId}
}
