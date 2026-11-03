import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { readPlacesCalendar } from '~/server/domain/places'

// Every day of [from, to) at every restaurant location, experience and consultation this caller may see: the places grid.
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const query = getQuery(event)
  return jsonResponse(await readPlacesCalendar(db, memberAccessPrincipal(organization, { env, event }), { from: query.from, to: query.to }))
})
