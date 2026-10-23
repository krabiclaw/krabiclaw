import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { airbnbUnsynced, stayAccessFor, updateStayHomePhoto } from '~/server/domain/stays'

// Describe one of a place to stay's photos (its alt text).
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  const body = await readRequiredBody<Record<string, unknown>>(event)
  const home = await updateStayHomePhoto(db, env, access, getRouterParam(event, 'productId') ?? '', getRouterParam(event, 'photoId') ?? '', body)
  // Photos are Airbnb's to hold: a home syncing with Airbnb names where to change them there too.
  return jsonResponse({ home, airbnb_unsynced: airbnbUnsynced(home, ['photos']) })
})
