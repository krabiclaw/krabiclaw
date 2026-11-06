import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { listTaskAssignees, listTasks, parseTaskListQuery, taskViewer } from '~/server/domain/tasks'
import { listOpportunities } from '~/server/domain/opportunities'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'

/**
 * Today and Upcoming: the stored tasks the caller may see and, for a manager
 * on Today, the opportunities open now. The web dashboard and the app render
 * this as it comes.
 */
export default defineHandler(async (event) => {
  const { db, env, organization } = await getDashboardMemberContext(event, {})
  const principal = memberAccessPrincipal(organization, { env, event })
  const viewer = await taskViewer(db, principal)
  const query = parseTaskListQuery(getQuery(event), { range: 'today', assignee: 'all' })
  const now = new Date()
  const [list, assignees, opportunities] = await Promise.all([
    listTasks(db, viewer, query, now),
    listTaskAssignees(db, viewer),
    viewer.manage && query.range === 'today' ? listOpportunities(db, principal, { now, locationId: query.locationId }) : null,
  ])
  const today = { tasks: list.sections, opportunities: opportunities?.opportunities ?? [], opportunityIssues: opportunities?.issues ?? [], assignees, resolvedAt: list.resolvedAt }
  return jsonResponse(finalizeRequestMetrics(event, 'dashboard-today', today), { headers: { 'cache-control': 'private, no-store' } })
})
