import { readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { getAuthSession } from '~/server/utils/auth'
import { defineHandler, HTTPError } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { memberSchedulingList, prepareMemberSchedulingList } from '~/server/domain/member-scheduling'
import { BATCH_VIEWER } from '~/server/utils/member-access'


export default defineHandler(async event => {
 const organizationId = getRouterParam(event, 'organization_id')
 if (!organizationId) throw new HTTPError({ statusCode: 400, message: 'Organization ID required' })
 const view = getQuery(event).view
 if (view === undefined) {
  const env = cloudflareEnv(event)
  const session = await getAuthSession(event, env)
  if (!session?.user.id) throw new HTTPError({ statusCode: 401, message: 'Sign in required' })
  return jsonResponse(await memberSchedulingList({ env, organizationId, userId: session.user.id }))
 }
 if (view !== 'assignment') throw new HTTPError({ statusCode: 400, message: 'Unknown member scheduling view' })
 const plan = prepareMemberSchedulingList({ sql: BATCH_VIEWER.organization }, BATCH_VIEWER)
 const { rows } = await readDashboardMemberResources(event, organizationId, plan.queries)
 return jsonResponse(plan.read(rows))
})
