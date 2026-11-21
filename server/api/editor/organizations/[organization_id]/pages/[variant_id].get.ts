import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { readTenantPageEditor } from '~/server/utils/tenant-pages-api'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const variantId = getRouterParam(event, 'variant_id')
  if (!organizationId || !variantId) return jsonResponse({ error: 'Organization and page IDs are required' }, { status: 400 })
  return jsonResponse(await readTenantPageEditor(event, organizationId, variantId), { headers: { 'cache-control': 'private, no-store' } })
})
