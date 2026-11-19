import type { H3Event } from 'nitro'
import {
  dashboardOrgQueryParam,
  getDashboardMemberContext,
  prepareDashboardLocations,
  type DashboardOrganizationRow,
} from '~/server/utils/dashboard-context'
import { executeBatch } from '~/server/db'
import { prepareOrganizationPlan } from '~/server/utils/billing-access'
import { organizationFeaturesFromRow, organizationFeaturesQuery } from '~/server/utils/cms-capabilities'
import { recordRequestPhase } from '~/server/utils/request-metrics'
import { oncePerRequest } from '~/server/utils/request-scope'
import { hasUnreadQuery, presentHasUnread } from '~/server/domain/guest-threads/repository'
import type { DashboardWorkspaceLink } from '~/composables/useDashboardOrganization'

export function readDashboardWorkspaceAccess(
  event: H3Event,
  { db, organization }: Pick<Awaited<ReturnType<typeof getDashboardMemberContext>>, 'db' | 'env' | 'organization'>,
  includeLocations = Boolean(event.context.dashboardDocumentProvider),
  preloaded?: Awaited<ReturnType<ReturnType<typeof prepareDashboardWorkspaceAccess>['read']>>,
) {
  return oncePerRequest(event, `dashboard-workspace-access:${organization.id}:${includeLocations}`, async () => {
    if (preloaded) return preloaded
    const plan = prepareDashboardWorkspaceAccess(organization.id, organization.userId, includeLocations)
    return plan.read(await executeBatch(db, plan.queries, { operation: 'Read dashboard workspace access' }), organization.id)
  })
}

export function prepareDashboardWorkspaceAccess(organizationId: string | { sql: string }, userId: string | { sql: string }, includeLocations: boolean) {
  const plan = prepareOrganizationPlan(organizationId)
  const user = typeof userId === 'string' ? '?' : userId.sql
  const locations = includeLocations ? prepareDashboardLocations(organizationId, undefined, false, true) : null
  return {
    queries: [
      plan.query,
      organizationFeaturesQuery(organizationId),
      ...(locations ? [
        hasUnreadQuery(organizationId, userId, new Date()),
        { query: `SELECT o.id, o.name, o.slug FROM member m JOIN organization o ON o.id = m.organizationId
          WHERE m.userId = ${user} ORDER BY o.name, o.id`, params: typeof userId === 'string' ? [userId] : [] },
        ...locations.queries,
      ] : []),
    ],
    read([subscription, featureRows, unread, workspaces, ...locationRows]: D1Result[], resolvedId: string) {
      return {
        effective_plan: plan.read(subscription!, resolvedId),
        features: organizationFeaturesFromRow(featureRows!.results[0] as Parameters<typeof organizationFeaturesFromRow>[0]),
        locationData: locations?.read(locationRows, resolvedId),
        has_unread: locations ? presentHasUnread(unread) : undefined,
        workspaces: workspaces?.results as DashboardWorkspaceLink[] | undefined,
      }
    },
  }
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
  const access = await readDashboardWorkspaceAccess(event, context, true)
  recordRequestPhase(event, 'resources', resourcesStartedAt)
  return presentDashboardContext(organization, access)
}

export function presentDashboardContext(
  organization: DashboardOrganizationRow,
  { effective_plan, features, locationData, has_unread, workspaces }: Awaited<ReturnType<typeof readDashboardWorkspaceAccess>>,
) {
  const { locations, media } = locationData!
  const { memberId, ...business } = organization
  return {
    success: true as const,
    organization: { ...business, effective_plan, media, features, member_id: memberId },
    locations,
    has_unread,
    workspaces,
  }
}
