import { defineHandler, HTTPError } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext, listDashboardLocations } from '~/server/utils/dashboard-context'
import { roleAllows, assertRoleAllows } from '~/server/utils/member-access'
import { listDashboardLocationsResource } from '~/server/utils/dashboard-locations-resource'

export default defineHandler(async (event) => {
  const query = getQuery(event)
  const organizationScoped = query.organization === 'true'

  if (organizationScoped) {
    const { db, organization } = await getDashboardMemberContext(event, {
            requireOrganization: true,
    })
    if (!organization) {
      throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
    }

    const managesCatalog = await roleAllows({ ...organization, permissions: { products: ['read'] } })
    if (!managesCatalog) await assertRoleAllows({ ...organization, permissions: { products: ['assigned'] } })
    const locations = await listDashboardLocations(db, organization.id, managesCatalog ? undefined : organization.userId, query.status === 'all')
    return jsonResponse({ success: true as const, locations })
  }

  return jsonResponse(await listDashboardLocationsResource(event))
})
