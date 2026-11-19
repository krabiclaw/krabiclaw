import type { H3Event } from 'nitro'
import { agendaStaff, listAgenda, parseAgendaQuery, prepareAgenda, type AgendaPayload } from '~/server/utils/dashboard-agenda'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'
import { BATCH_VIEWER } from '~/server/utils/member-access'
import type { BatchQuery, DbClient } from '~/server/db'

function stringQuery(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export async function readDashboardAgenda(event: H3Event, query: Record<string, unknown>, orgSlug?: string) {
  const { env, db, organization } = await getDashboardMemberContext(event, { organizationSlug: orgSlug })
  const parsed = agendaQuery(query, organization.slug)
  const prepared = event.context.dashboardAgenda as { query: ReturnType<typeof agendaQuery>; payload: AgendaPayload } | undefined
  const payload = prepared && prepared.query.organizationSlug === organization.slug
    && prepared.query.from <= parsed.from && prepared.query.to >= parsed.to
    && prepared.query.locationId === parsed.locationId && prepared.query.assignedMemberId === parsed.assignedMemberId
    && prepared.query.organizationId === parsed.organizationId && String(prepared.query.kinds) === String(parsed.kinds)
    ? { ...prepared.payload, items: prepared.payload.items.filter(item => item.day_key >= parsed.from && item.day_key <= parsed.to) }
    : await listAgenda(db, { organizationId: organization.id }, { ...parsed, principal: { env, membership: organization } })
  return finalizeRequestMetrics(event, 'dashboard-agenda', payload)
}

function agendaQuery(query: Record<string, unknown>, slug: string) {
  return { ...parseAgendaQuery(query), assignedMemberId: stringQuery(query.assigned_member_id),
    organizationId: stringQuery(query.organization_id), locationId: stringQuery(query.location_id), organizationSlug: slug }
}

export function prepareDashboardAgendaDocument(db: DbClient, membership: BatchQuery, userId: string, slug: string, request: Record<string, unknown>) {
  const query = agendaQuery(request, slug)
  const plan = prepareAgenda(db, { organizationId: { sql: BATCH_VIEWER.organization } }, query, null, { membership, userId })
  return {
    queries: plan.queries,
    async apply(event: H3Event, results: D1Result[], context: Pick<Awaited<ReturnType<typeof getDashboardMemberContext>>, 'env' | 'organization'>) {
      const staff = await agendaStaff({ env: context.env, membership: context.organization })
      event.context.dashboardAgenda = { query, payload: await plan.read(results, Boolean(staff)) }
    },
  }
}
