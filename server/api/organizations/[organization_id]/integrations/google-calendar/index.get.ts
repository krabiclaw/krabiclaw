import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { readCalendarConnection } from '~/server/utils/google-calendar'
import { memberCalendarCoverage } from '~/server/domain/member-scheduling'
import { requireOrganizationAccess } from '~/server/utils/location-access'
export default defineHandler(async event => {
 const id = getRouterParam(event, 'organization_id')
 if (!id) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
 const { db, organization } = await requireOrganizationAccess(event, id)
 const connection = await readCalendarConnection(db, organization.id)
 if (getQuery(event).coverage !== '1') return jsonResponse(connection)
 const coverage = connection.calendar && connection.calendar.status !== 'disabled'
  ? await memberCalendarCoverage(db, organization.membership) : null
 return jsonResponse({ ...connection, coverage })
})
