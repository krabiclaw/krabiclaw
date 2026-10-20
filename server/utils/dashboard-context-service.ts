import type { H3Event } from 'nitro'
import { cloudflareEnv } from '~/server/utils/api-response'
import {
  dashboardOrgQueryParam,
  getDashboardMemberContext,
  listDashboardLocations,
  loadDashboardOrganizationCard,
} from '~/server/utils/dashboard-context'
import { recordRequestPhase } from '~/server/utils/request-metrics'

// The scope is the route's `org` query param. No organization is a 400 and one
// this session cannot see is a 404 (getDashboardContext). Neither is a payload
// with nulls in it: the dashboard rendered that payload as "not found" on the
// client while the server had logged a 200.
//
// There is no second `site` scope beside the organization any more, so there is
// no switcher to draw and no list to load: the organization is the tenant.
export async function loadDashboardContext(
  event: H3Event,
  scope: { orgSlug: string | null } = { orgSlug: dashboardOrgQueryParam(event) },
) {
  const contextStartedAt = performance.now()
  const env = cloudflareEnv(event)
  const { db, organization } = await getDashboardMemberContext(event, {
    organizationSlug: scope.orgSlug,
  })
  recordRequestPhase(event, 'context', contextStartedAt)

  const resourcesStartedAt = performance.now()
  const [card, locations] = await Promise.all([
    loadDashboardOrganizationCard(env, db, organization.id),
    listDashboardLocations(db, organization.id),
  ])
  recordRequestPhase(event, 'resources', resourcesStartedAt)

  return {
    success: true as const,
    organization: { ...organization, ...card },
    locations,
  }
}
