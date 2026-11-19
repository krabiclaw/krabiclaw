import type { H3Event } from 'nitro'
import { listAgenda, parseAgendaQuery } from '~/server/utils/dashboard-agenda'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'

function stringQuery(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export async function readDashboardAgenda(event: H3Event, query: Record<string, unknown>, orgSlug?: string) {
  const { env, db, organization } = await getDashboardMemberContext(event, { organizationSlug: orgSlug })
  const payload = await listAgenda(db, { organizationId: organization.id }, {
    ...parseAgendaQuery(query), assignedMemberId:stringQuery(query.assigned_member_id), organizationId: stringQuery(query.organization_id), locationId: stringQuery(query.location_id), organizationSlug: organization.slug, principal: { env, membership: organization }, })
  return finalizeRequestMetrics(event, 'dashboard-agenda', payload)
}
