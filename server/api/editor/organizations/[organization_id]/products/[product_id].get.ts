import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { loadDashboardProduct } from '~/server/utils/dashboard-editor-resources'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const productId = getRouterParam(event, 'product_id')
  if (!organizationId || !productId) return jsonResponse({ error: 'Organization and Product IDs are required' }, { status: 400 })
  try {
    return jsonResponse(await loadDashboardProduct(event, organizationId, null, productId), { headers: { 'cache-control': 'private, no-store' } })
  } catch (error) {
    rethrowHttpError(error)
    return jsonResponse({ error: 'Failed to load Product' }, { status: 500 })
  }
})
