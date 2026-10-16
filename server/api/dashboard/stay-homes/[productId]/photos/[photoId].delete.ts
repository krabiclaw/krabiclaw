import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { removeStayHomePhoto, stayAccessFor } from '~/server/domain/stays'

// Take a photo off a place to stay; the file stays in the media library.
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const principal = memberAccessPrincipal(organization, { env, event })
  const access = await stayAccessFor(principal)
  return jsonResponse({ home: await removeStayHomePhoto(db, env, access, principal, getRouterParam(event, 'productId') ?? '', getRouterParam(event, 'photoId') ?? '') })
})
