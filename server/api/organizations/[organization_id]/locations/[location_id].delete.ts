import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { assertRoleAllows } from '~/server/utils/member-access'
import { deleteLocation } from '~/server/utils/location-management'
import { purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const locationId = getRouterParam(event, 'location_id')
  if (!organizationId || !locationId) {
    return jsonResponse({ error: 'Organization ID and location ID are required' }, { status: 400 })
  }

  const { env, db, organization } = await requireOrganizationAccess(event, organizationId)
  await assertRoleAllows({ organizationId: organization.id, role: organization.member_role, permissions: { locations: ['delete'] } })
  const result = await deleteLocation(env, db, organization.id, locationId)
  if (result.status >= 400) {
    return jsonResponse(result.data, { status: result.status })
  }
  await purgePublicResourceCacheNow(env, organizationId)

  return jsonResponse({
    success: true, message: 'Location deleted successfully', organization_id: organizationId, location_id: locationId, }, { status: result.status })
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
