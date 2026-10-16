import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

import { requireOrganizationAccess } from '~/server/utils/location-access'
import { deleteLocalization } from '~/server/utils/localization'
import { isDemoOrganization } from '~/shared/demo'
import { hasPlatformEventPermission } from '~/server/utils/platform-admin-users'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const resourceType = getRouterParam(event, 'resourceType')
  const resourceId = getRouterParam(event, 'resourceId')
  const locale = getRouterParam(event, 'locale')
  if (!organizationId || !resourceType || !resourceId || !locale) throw createError({ statusCode: 400, statusMessage: 'Organization, resource, and locale route parameters are required' })
  const { env, db, organization } = await requireOrganizationAccess(event, organizationId)
  if (isDemoOrganization(organization) && !(await hasPlatformEventPermission(event, env, { platform: ['access'] }))) {
    throw createError({ statusCode: 403, statusMessage: 'Demo organization is read-only' })
  }
  return await deleteLocalization(env, db, { organizationId: organization.id, resourceType, resourceId, locale })
})
