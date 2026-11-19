import { jsonResponse } from '~/server/utils/api-response'
import { requireTenantPageWriteAccess } from '~/server/utils/tenant-pages-api'
import { getTenantPageById, resolvePublishedTenantPageIdentity } from '~/server/utils/content/pages'
import { resolvePublicTenantOrigin } from '~/server/utils/public-base'
import { listPublicLocaleRepresentations, resolvePublicDocumentSourcePath } from '~/server/utils/public-locale-representations'
import { createPreviewToken, PREVIEW_TOKEN_TTL_MS, previewSecretOf } from '~/server/utils/preview-token'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const variantId = getRouterParam(event, 'variant_id')
  if (!organizationId || !variantId) return jsonResponse({ error: 'Organization and page IDs are required' }, { status: 400 })
  const { db, env } = await requireTenantPageWriteAccess(event, organizationId)
  const page = await getTenantPageById(db, variantId, { organizationId })
  const [origin, published] = await Promise.all([
    resolvePublicTenantOrigin(db, env, organizationId),
    resolvePublishedTenantPageIdentity(db, organizationId, page.path, page.locale),
  ])
  let public_url: string | null = null
  if (origin && published?.id === page.id) {
    if (page.id === page.page_id) public_url = new URL(page.path, origin).toString()
    else {
      const sourcePath = await resolvePublicDocumentSourcePath(db, organizationId, page.page_id)
      const representations = await listPublicLocaleRepresentations(env, db, { organizationId, sourcePath, documentId: page.page_id })
      const representation = representations.find(item => item.locale === page.locale)
      if (representation) public_url = new URL(representation.route_path, origin).toString()
    }
  }
  const secret = previewSecretOf(env)
  return jsonResponse({ page, public_url, preview_token: secret ? await createPreviewToken(secret, organizationId, Date.now() + PREVIEW_TOKEN_TTL_MS) : null })
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
