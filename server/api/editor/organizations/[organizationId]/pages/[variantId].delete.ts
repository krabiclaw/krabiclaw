import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'
import { requireTenantPageWriteAccess } from '~/server/utils/tenant-pages-api'
import { deleteTenantPage } from '~/server/utils/content/pages'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const variantId = getRouterParam(event, 'variantId')
  if (!organizationId || !variantId) return jsonResponse({ error: 'Organization and page IDs are required' }, { status: 400 })
  const { env, db } = await requireTenantPageWriteAccess(event, organizationId)
  const body = await readStrictBody<{ updated_at: string }>(event, { updated_at: 'string' })
  if (typeof body.updated_at !== 'string' || !body.updated_at) {
    return jsonResponse({ error: 'updated_at is required' }, { status: 400 })
  }
  const payload = await deleteTenantPage(db, variantId, {
    scope: { organizationId }, expectedUpdatedAt: body.updated_at, env,
  })
  return jsonResponse(finalizeRequestMetrics(event, 'editor-tenant-page-delete', payload))
})
