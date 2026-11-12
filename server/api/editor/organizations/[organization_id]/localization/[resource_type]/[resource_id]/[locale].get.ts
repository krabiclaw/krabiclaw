import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

import { requireOrganizationAccess } from '~/server/utils/location-access'
import { getLocalizationForAuthoring } from '~/server/utils/localization'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const resourceType = getRouterParam(event, 'resource_type')
  const resourceId = getRouterParam(event, 'resource_id')
  const locale = getRouterParam(event, 'locale')
  if (!organizationId || !resourceType || !resourceId || !locale) throw createError({ statusCode: 400, statusMessage: 'Organization, resource, and locale route parameters are required' })
  const { env, db, organization } = await requireOrganizationAccess(event, organizationId)
  return { localization: await getLocalizationForAuthoring(env, db, organization.id, resourceType, resourceId, locale) }
})
