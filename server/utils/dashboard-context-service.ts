import type { H3Event } from 'nitro'
import {
  dashboardOrgQueryParam,
  getDashboardMemberContext,
  prepareDashboardLocations,
} from '~/server/utils/dashboard-context'
import { executeBatch } from '~/server/db'
import { prepareOrganizationPlan } from '~/server/utils/billing-access'
import { organizationFeaturesFromRow, organizationFeaturesQuery } from '~/server/utils/cms-capabilities'
import { recordRequestPhase } from '~/server/utils/request-metrics'
import { oncePerRequest } from '~/server/utils/request-scope'
import { hasUnreadQuery, presentHasUnread } from '~/server/domain/guest-threads/repository'

export function readDashboardWorkspaceAccess(
  event: H3Event,
  { db, organization }: Pick<Awaited<ReturnType<typeof getDashboardMemberContext>>, 'db' | 'env' | 'organization'>,
  includeLocations = Boolean(event.context.dashboardDocumentProvider),
) {
  return oncePerRequest(event, `dashboard-workspace-access:${organization.id}:${includeLocations}`, async () => {
    const plan = prepareOrganizationPlan(organization.id)
    const locations = includeLocations ? prepareDashboardLocations(organization.id, undefined, false, true) : null
    const [subscription, featureRows, unread, ...locationRows] = await executeBatch(db, [
      plan.query,
      organizationFeaturesQuery(organization.id),
      ...(locations ? [hasUnreadQuery(organization.id, { userId: organization.userId }, new Date()), ...locations.queries] : []),
    ], { operation: 'Read dashboard workspace access' })
    return {
      effective_plan: plan.read(subscription!),
      features: organizationFeaturesFromRow(featureRows!.results[0] as Parameters<typeof organizationFeaturesFromRow>[0]),
      locationData: locations?.read(locationRows),
      has_unread: locations ? presentHasUnread(unread) : undefined,
    }
  })
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
  const { organization } = context
  recordRequestPhase(event, 'context', contextStartedAt)

  const resourcesStartedAt = performance.now()
  const { effective_plan, features, locationData, has_unread } = await readDashboardWorkspaceAccess(event, context, true)
  const { locations, media } = locationData!
  recordRequestPhase(event, 'resources', resourcesStartedAt)

  const { memberId, ...business } = organization
  return {
    success: true as const,
    organization: { ...business, effective_plan, media, features, member_id: memberId },
    locations,
    has_unread,
  }
}
