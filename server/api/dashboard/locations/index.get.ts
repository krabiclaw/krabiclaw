import { prepareDashboardLocationOverview } from '~/server/utils/dashboard-editor-resources'
import { dashboardOrgQueryParam, prepareDashboardLocations, readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { defineHandler, HTTPError } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { BATCH_VIEWER, roleAllows, assertRoleAllows } from '~/server/utils/member-access'
import { roleMatchesSql, rolesAllowing } from '~/utils/organization-access'
import { listDashboardLocationsResource } from '~/server/utils/dashboard-locations-resource'

export default defineHandler(async (event) => {
  const query = getQuery(event)
  if (query.view === 'editor') {
    const slug = query.location_slug
    const organizationSlug = dashboardOrgQueryParam(event)
    if (typeof slug !== 'string' || !slug.trim() || !organizationSlug) throw new HTTPError({ statusCode: 400, message: 'A workspace and location slug are required' })
    const plan = prepareDashboardLocationOverview({ slug })
    const { rows, organization } = await readDashboardMemberResources(event, { slug: organizationSlug }, plan.queries)
    return jsonResponse(plan.read(rows, organization))
  }
  const organizationScoped = query.organization === 'true'

  if (organizationScoped) {
    const organizationSlug = dashboardOrgQueryParam(event)
    if (!organizationSlug) throw new HTTPError({ statusCode: 400, message: 'A workspace slug is required' })
    const plan = prepareDashboardLocations({ sql: BATCH_VIEWER.organization }, {
      user: BATCH_VIEWER.user, unrestricted: roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ products: ['read'] })),
    }, query.status === 'all')
    const { rows, organization } = await readDashboardMemberResources(event, { slug: organizationSlug }, plan.queries)
    const managesCatalog = await roleAllows({ ...organization, permissions: { products: ['read'] } })
    if (!managesCatalog) await assertRoleAllows({ ...organization, permissions: { products: ['assigned'] } })
    const { locations } = plan.read(rows, organization.id)
    return jsonResponse({ success: true as const, locations })
  }

  return jsonResponse(await listDashboardLocationsResource(event))
})
