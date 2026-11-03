import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { setPlaceDates } from '~/server/domain/places'

// Open or block a place's days: a location's closures, or an offering's unclaimed sessions.
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const body = await readRequiredBody<Record<string, unknown>>(event)
  return jsonResponse(await setPlaceDates(db, memberAccessPrincipal(organization, { env, event }), { kind: String(getRouterParam(event, 'kind')), id: String(getRouterParam(event, 'id')), body }))
})
