import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { listAgenda, parseAgendaQuery } from '~/server/utils/dashboard-agenda'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'

function stringQuery(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const query = getQuery(event)
  const payload = await listAgenda(db, { organizationId: organization.id }, {
    ...parseAgendaQuery(query), assignedMemberId:stringQuery(query.assigned_member_id), organizationId: stringQuery(query.organizationId), locationId: stringQuery(query.locationId), organizationSlug: organization.slug, principal: { env, membership: organization }, })
  return jsonResponse(finalizeRequestMetrics(event, 'dashboard-agenda', payload))
})
