import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { readStayCalendars, stayAccessFor } from '~/server/domain/stays'

// Every night of [from, to) at every home this caller may see: the multi-calendar.
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  const query = getQuery(event)
  return jsonResponse({ ...await readStayCalendars(db, access, { from: query.from, to: query.to }), manage: access.manage })
})
