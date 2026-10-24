import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { defaultLinksPage, getLinksPage, getPublicLinksPage } from '~/server/utils/links-page'
import { resolvePublicTenantOrigin } from '~/server/utils/public-base'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })

  const { env, db, organization } = await requireOrganizationAccess(event, organizationId)
  const [result, publicPage, publicOrigin] = await Promise.all([
    getLinksPage(db, organizationId),
    getPublicLinksPage(env, db, organizationId),
    resolvePublicTenantOrigin(db, env, organizationId),
  ])

  return jsonResponse({
    page: result.page ?? defaultLinksPage({
      organizationId: organization.id, name: organization.name, }), items: result.items,
    public_url: publicPage && publicOrigin ? new URL(publicPage.page.path, publicOrigin).toString() : null,
  })
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
