import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { loadDashboardProduct } from '~/server/utils/dashboard-editor-resources'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const productId = getRouterParam(event, 'productId')
  if (!organizationId || !productId) return jsonResponse({ error: 'Organization and Product IDs are required' }, { status: 400 })
  try {
    return jsonResponse(await loadDashboardProduct(event, organizationId, null, productId))
  } catch (error) {
    rethrowHttpError(error)
    return jsonResponse({ error: 'Failed to load Product' }, { status: 500 })
  }
})
