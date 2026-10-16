import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

import { requireOrganizationAccess } from '~/server/utils/location-access'
import { addOrganizationLanguage } from '~/server/utils/organization-languages'
import { isDemoOrganization } from '~/shared/demo'
import { hasPlatformEventPermission } from '~/server/utils/platform-admin-users'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const locale = getRouterParam(event, 'locale')
  if (!organizationId || !locale) throw createError({ statusCode: 400, statusMessage: 'Organization ID and locale are required' })
  const { env, db, organization } = await requireOrganizationAccess(event, organizationId)
  if (isDemoOrganization(organization) && !(await hasPlatformEventPermission(event, env, { platform: ['access'] }))) {
    throw createError({ statusCode: 403, statusMessage: 'Demo organization is read-only' })
  }
  return { language: await addOrganizationLanguage(db, env, { organizationId: organization.id, locale }) }
})
