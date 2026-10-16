import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { reorderStayHomePhotos, stayAccessFor } from '~/server/domain/stays'

// Put a place to stay's photos in order; the first is its cover.
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const principal = memberAccessPrincipal(organization, { env, event })
  const access = await stayAccessFor(principal)
  const body = await readRequiredBody<Record<string, unknown>>(event)
  return jsonResponse({ home: await reorderStayHomePhotos(db, env, access, principal, getRouterParam(event, 'productId') ?? '', body) })
})
