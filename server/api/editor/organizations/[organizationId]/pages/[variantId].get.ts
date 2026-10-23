import { jsonResponse } from '~/server/utils/api-response'
import { requireTenantPageWriteAccess } from '~/server/utils/tenant-pages-api'
import { getTenantPageById, resolvePublishedTenantPageIdentity } from '~/server/utils/content/pages'
import { resolvePublicTenantOrigin } from '~/server/utils/public-base'
import { listPublicLocaleRepresentations, resolvePublicDocumentSourcePath } from '~/server/utils/public-locale-representations'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const variantId = getRouterParam(event, 'variantId')
  if (!organizationId || !variantId) return jsonResponse({ error: 'Organization and page IDs are required' }, { status: 400 })
  const { db, env } = await requireTenantPageWriteAccess(event, organizationId)
  const page = await getTenantPageById(db, variantId, { organizationId })
  const [origin, published] = await Promise.all([
    resolvePublicTenantOrigin(db, env, organizationId),
    resolvePublishedTenantPageIdentity(db, organizationId, page.path, page.locale),
  ])
  const sourcePath = await resolvePublicDocumentSourcePath(db, organizationId, page.page_id)
  const representations = origin && published?.id === page.id
    ? await listPublicLocaleRepresentations(env, db, { organizationId, sourcePath, documentId: page.page_id }) : []
  const representation = representations.find(item => item.locale === page.locale)
  return jsonResponse({ page, public_url: origin && representation ? new URL(representation.route_path, origin).toString() : null })
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
