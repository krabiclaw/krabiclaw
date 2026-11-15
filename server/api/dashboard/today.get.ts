import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { isOrganizationWideRole, memberAccessPrincipal } from '~/server/utils/member-access'
import { listTaskAssignees, listTasks, parseTaskListQuery, taskViewer } from '~/server/domain/tasks'
import { listOpportunities } from '~/server/domain/opportunities'
import { listTodayReservations } from '~/server/utils/dashboard-agenda'
import { todayReservationsTitle } from '~/shared/dashboard-today'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'
import { organizationPublicUrl } from '~/server/utils/domains'
import { createPreviewToken, PREVIEW_TOKEN_QUERY, PREVIEW_TOKEN_TTL_MS, previewSecretOf, PUBLIC_WEBSITE_QUERY } from '~/server/utils/preview-token'
import { isDemoOrganization } from '~/shared/demo'

/**
 * Today and Upcoming: the business's reservations, read from the agenda, with
 * the welcome a booked guest is due at the bottom of its card; the stored tasks
 * the caller may see; and, for a manager on Today, the setup the business has
 * not finished. Every part is a read of stored rows. The web dashboard and the app render this as it comes.
 */
export default defineHandler(async (event) => {
  const { db, env, organization } = await getDashboardMemberContext(event, {})
  const principal = memberAccessPrincipal(organization, { env, event })
  const viewer = await taskViewer(principal)
  const query = parseTaskListQuery(getQuery(event), { range: 'today', assignee: 'all' })
  const now = new Date()
  const [list, assignees, suggested, reservations] = await Promise.all([
    listTasks(db, viewer, query, now),
    listTaskAssignees(db, viewer),
    viewer.manage ? listOpportunities(db, principal, { now, locationId: query.location_id }) : { opportunities: [] },
    // A task filter shows those tasks alone.
    query.kind ? [] : listTodayReservations(db, organization.id, { range: query.range, vertical: organization.vertical, organizationSlug: organization.slug,
      principal: { env, membership: organization }, locationId: query.location_id }, now),
  ])
  // A booking's welcome is on its card; the business's unfinished setup is Today's.
  const welcomes = new Map(suggested.opportunities.flatMap(item => item.conversation_id ? [[item.conversation_id, item] as const] : []))
  const cards = reservations.map(card => ({ ...card, suggestion: card.conversation_id ? welcomes.get(card.conversation_id) ?? null : null }))
  let website = null
  const privateSite = organization.status === 'inactive'
  const hasOpenWork = cards.length > 0 || list.sections.some(section => section.id === 'open' && section.tasks.length > 0)
  if (query.range === 'today' && !query.kind && !query.location_id && isOrganizationWideRole(organization.role)
    && organization.onboarding_status === 'active' && (privateSite || organization.status === 'active' && !hasOpenWork)
    && !isDemoOrganization(organization)) {
    const address = await organizationPublicUrl(env, db, organization.id)
    if (address) {
      const preview = new URL(address)
      const secret = previewSecretOf(env)
      if (!secret) throw new Error('Website preview signing is unavailable')
      // The owner's preview is excluded from customer analytics on draft and live sites.
      preview.searchParams.set(PREVIEW_TOKEN_QUERY, await createPreviewToken(secret, organization.id, now.getTime() + PREVIEW_TOKEN_TTL_MS))
      website = {
        address,
        preview_url: preview.toString(),
        preview_label: 'Website preview',
        status_label: privateSite ? 'Private' : 'Live',
        action: privateSite
          ? { label: 'Publish website', to: `/dashboard/${encodeURIComponent(organization.slug)}/website?publish=1`, type: 'publish' as const }
          : { label: 'View website', to: address + PUBLIC_WEBSITE_QUERY, type: 'visit' as const },
      }
    }
  }
  const today = {
    website,
    reservations: { title: todayReservationsTitle(cards.length, query.range, organization.vertical), cards },
    tasks: list.sections,
    opportunities: query.range === 'today' ? suggested.opportunities.filter(item => !item.conversation_id).slice(0, privateSite ? 3 : undefined) : [],
    assignees, resolved_at: list.resolved_at,
  }
  return jsonResponse(finalizeRequestMetrics(event, 'dashboard-today', today), { headers: { 'cache-control': 'private, no-store' } })
})
