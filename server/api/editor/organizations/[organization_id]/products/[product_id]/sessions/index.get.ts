import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { requireProductAccess } from '~/server/utils/location-access'
import { requireOrganizationProduct } from '~/server/utils/product-management'
import { listScheduleSessions } from '~/server/utils/availability'
import { PRODUCT_SESSION_STATUSES, type ProductSessionStatus } from '~/shared/bookings'
import { defineHandler, HTTPError } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const productId = getRouterParam(event, 'product_id')
  if (!organizationId || !productId) return jsonResponse({ error: 'Organization ID and product ID are required' }, { status: 400 })
  try {
    const { db, env, organization } = await requireProductAccess(event, organizationId, productId)
    // A product id in the path is not authorized by the site in the path.
    await requireOrganizationProduct(db, { organizationId: organization.id, productId })
    const query = getQuery(event)
    const from = typeof query.from === 'string' ? query.from : new Date().toISOString()
    const to = typeof query.to === 'string' ? query.to : new Date(Date.now() + 90 * 86_400_000).toISOString()
    const fromTime = Date.parse(from), toTime = Date.parse(to)
    if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || toTime <= fromTime || toTime - fromTime > 93 * 86_400_000) {
      throw new HTTPError({ statusCode: 400, statusMessage: 'Choose a valid availability range of at most 93 days' })
    }
    const statuses = typeof query.status === 'string'
      ? String(query.status).split(',').filter((value): value is ProductSessionStatus => (PRODUCT_SESSION_STATUSES as readonly string[]).includes(value))
      : [...PRODUCT_SESSION_STATUSES]
    const sessions = await listScheduleSessions(db, { env, organizationId: organization.id, productId, fromInstant: new Date(fromTime).toISOString(), toInstant: new Date(toTime).toISOString(), statuses })
    return jsonResponse({ success: true, sessions })
  } catch (error) {
    rethrowHttpError(error)
    console.error('sessions_list_failed', { organizationId, productId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to list sessions' }, { status: 500 })
  }
})
