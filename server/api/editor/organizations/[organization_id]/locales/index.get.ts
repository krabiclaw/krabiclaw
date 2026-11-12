import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

import { requireOrganizationAccess } from '~/server/utils/location-access'
import { getOrganizationLanguageSettings } from '~/server/utils/organization-languages'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) throw createError({ statusCode: 400, statusMessage: 'Organization ID required' })
  const { env, db, organization } = await requireOrganizationAccess(event, organizationId)
  return await getOrganizationLanguageSettings(db, env, { organizationId: organization.id })
})
