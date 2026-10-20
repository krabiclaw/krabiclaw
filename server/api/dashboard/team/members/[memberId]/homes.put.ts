import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { setMemberHomes, stayAccessFor } from '~/server/domain/stays'

// The homes one member looks after, replaced as a whole. Which homes a member
// has is read from GET /api/dashboard/stay-homes (assigned_member_id).
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  const body = await readStrictBody<{ productIds?: unknown }>(event, { productIds: 'unknown' })
  return jsonResponse(await setMemberHomes(env, db, access, getRouterParam(event, 'memberId') ?? '', body.productIds))
})
