import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { listTaskAssignees, listTasks, parseTaskListQuery, taskViewer } from '~/server/domain/tasks'
import { listOpportunities } from '~/server/domain/opportunities'
import { listTodayReservations } from '~/server/utils/dashboard-agenda'
import { todayReservationsTitle } from '~/shared/dashboard-today'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'

/**
 * Today and Upcoming: the business's reservations, read from the agenda, with
 * the suggestion for each at the bottom of its card; the stored tasks the
 * caller may see; and, for a manager on Today, the other opportunities open
 * now. The web dashboard and the app render this as it comes.
 */
export default defineHandler(async (event) => {
  const { db, env, organization } = await getDashboardMemberContext(event, {})
  const principal = memberAccessPrincipal(organization, { env, event })
  const viewer = await taskViewer(db, principal)
  const query = parseTaskListQuery(getQuery(event), { range: 'today', assignee: 'all' })
  const now = new Date()
  const [list, assignees, opportunities, reservations] = await Promise.all([
    listTasks(db, viewer, query, now),
    listTaskAssignees(db, viewer),
    viewer.manage ? listOpportunities(db, principal, { now, locationId: query.location_id }) : null,
    // A task filter shows those tasks alone.
    query.kind ? [] : listTodayReservations(db, organization.id, { range: query.range, vertical: organization.vertical, organizationSlug: organization.slug,
      principal: { env, membership: organization }, locationId: query.location_id }, now),
  ])
  const suggestions = new Map((opportunities?.opportunities ?? []).flatMap(opportunity => opportunity.conversation_id ? [[opportunity.conversation_id, opportunity]] : []))
  const cards = reservations.map(card => ({ ...card, suggestion: card.conversation_id ? suggestions.get(card.conversation_id) ?? null : null }))
  // A guest's reply about a stay on a card here is drawn once, by the card.
  const carded = new Set(cards.flatMap(card => card.kind === 'stay' && card.booking_id ? [card.booking_id] : []))
  const tasks = list.sections.map(section => ({ ...section, tasks: section.tasks.map(task => {
    if (!task.reservation || !task.booking_id || !carded.has(task.booking_id)) return task
    const { reservation: _drawnByCard, ...compact } = task
    return compact
  }) }))
  const today = {
    reservations: { title: todayReservationsTitle(cards.length, query.range, organization.vertical), cards },
    tasks,
    // A booking's suggestion is on its card; the rest are Today's.
    opportunities: query.range === 'today' ? (opportunities?.opportunities ?? []).filter(opportunity => opportunity.conversation_id === null) : [],
    opportunity_issues: query.range === 'today' ? opportunities?.issues ?? [] : [],
    assignees, resolved_at: list.resolved_at,
  }
  return jsonResponse(finalizeRequestMetrics(event, 'dashboard-today', today), { headers: { 'cache-control': 'private, no-store' } })
})
