import type { H3Event } from 'nitro'
import {
  dashboardOrgQueryParam,
  getDashboardMemberContext,
  readDashboardLocations,
} from '~/server/utils/dashboard-context'
import { getOrganizationPlan } from '~/server/utils/billing-access'
import { loadOrganizationFeatures } from '~/server/utils/cms-capabilities'
import { recordRequestPhase } from '~/server/utils/request-metrics'
import { oncePerRequest } from '~/server/utils/request-scope'

export function readDashboardWorkspaceAccess(
  event: H3Event,
  { db, env, organization }: Pick<Awaited<ReturnType<typeof getDashboardMemberContext>>, 'db' | 'env' | 'organization'>,
) {
  return oncePerRequest(event, `dashboard-workspace-access:${organization.id}`, () => Promise.all([
    getOrganizationPlan(env, organization.id),
    loadOrganizationFeatures(db, organization.id),
  ]))
}

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
  const context = await getDashboardMemberContext(event, {
    organizationSlug: scope.orgSlug,
  })
  const { db, organization } = context
  recordRequestPhase(event, 'context', contextStartedAt)

  const resourcesStartedAt = performance.now()
  const [[effective_plan, features], { locations, media }] = await Promise.all([
    readDashboardWorkspaceAccess(event, context),
    readDashboardLocations(db, organization.id, undefined, false, true),
  ])
  recordRequestPhase(event, 'resources', resourcesStartedAt)

  const { memberId, ...business } = organization
  return {
    success: true as const,
    organization: { ...business, effective_plan, media, features, member_id: memberId },
    locations,
  }
}
