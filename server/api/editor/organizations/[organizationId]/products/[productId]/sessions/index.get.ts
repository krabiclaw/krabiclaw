import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { requireProductAccess } from '~/server/utils/location-access'
import { requireOrganizationProduct } from '~/server/utils/product-management'
import { listSessions } from '~/server/utils/availability'
import { PRODUCT_SESSION_STATUSES, type ProductSessionStatus } from '~/shared/bookings'
import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const productId = getRouterParam(event, 'productId')
  if (!organizationId || !productId) return jsonResponse({ error: 'Organization ID and product ID are required' }, { status: 400 })
  try {
    const { db, organization } = await requireProductAccess(event, organizationId, productId)
    // A product id in the path is not authorized by the site in the path.
    await requireOrganizationProduct(db, { organizationId: organization.id, productId })
    const query = getQuery(event)
    const from = typeof query.from === 'string' ? query.from : new Date().toISOString()
    const to = typeof query.to === 'string' ? query.to : new Date(Date.now() + 90 * 86_400_000).toISOString()
    // The editor sees cancelled and completed sessions too: hiding them would
    // make a cancelled class look like one that was never scheduled.
    const statuses = typeof query.status === 'string'
      ? String(query.status).split(',').filter((value): value is ProductSessionStatus => (PRODUCT_SESSION_STATUSES as readonly string[]).includes(value))
      : [...PRODUCT_SESSION_STATUSES]
    const sessions = await listSessions(db, { organizationId: organization.id, productId, fromInstant: from, toInstant: to, statuses })
    return jsonResponse({ success: true, sessions })
  } catch (error) {
    rethrowHttpError(error)
    console.error('sessions_list_failed', { organizationId, productId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to list sessions' }, { status: 500 })
  }
})
