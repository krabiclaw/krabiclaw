import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

import { requireOrganizationAccess } from '~/server/utils/location-access'
import { getProductCatalogLocalization } from '~/server/utils/localization'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const locale = getRouterParam(event, 'locale')
  if (!organizationId || !locale) throw createError({ statusCode: 400, statusMessage: 'Organization and locale are required' })
  const { env, db, organization } = await requireOrganizationAccess(event, organizationId)
  return await getProductCatalogLocalization(env, db, organization.id, locale)
})
