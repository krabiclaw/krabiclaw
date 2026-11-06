import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { assertOrganizationLanguage } from '~/server/utils/localization'
import { getOrganizationLocalizationProgress } from '~/server/utils/organization-localization-opportunities'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const locale = getRouterParam(event, 'locale')
  if (!organizationId || !locale) throw createError({ statusCode: 400, statusMessage: 'Organization ID and locale are required' })
  const { db, organization } = await requireOrganizationAccess(event, organizationId)
  const language = await assertOrganizationLanguage(db, organization.id, locale)
  if (language.source) throw createError({ statusCode: 422, statusMessage: 'Choose an additional language' })
  return await getOrganizationLocalizationProgress(db, { organizationId: organization.id, organizationSlug: organization.slug, locale: language.locale })
})
