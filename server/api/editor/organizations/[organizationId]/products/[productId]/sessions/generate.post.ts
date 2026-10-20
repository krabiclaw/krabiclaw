import { jsonResponse, readStrictBody, rethrowHttpError } from '~/server/utils/api-response'
import { requireProductAccess } from '~/server/utils/location-access'
import { requireOrganizationProduct } from '~/server/utils/product-management'
import { materializeSessions } from '~/server/utils/availability'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

/**
 * Materialize sessions from the product's rules, up to a date.
 *
 * Safe to run repeatedly: generation is idempotent, and the response reports
 * occurrences it skipped because their local wall time does not exist, or
 * happens twice, on a daylight-saving boundary.
 */
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const productId = getRouterParam(event, 'productId')
  if (!organizationId || !productId) return jsonResponse({ error: 'Organization ID and product ID are required' }, { status: 400 })
  try {
    const { db, session, organization } = await requireProductAccess(event, organizationId, productId)
    // A product id in the path is not authorized by the site in the path.
    await requireOrganizationProduct(db, { organizationId: organization.id, productId })
    const body = await readStrictBody<{ through: unknown; from?: unknown }>(event, { through: 'unknown', from: 'unknown' })
    if (typeof body.through !== 'string') return jsonResponse({ error: 'through must be a YYYY-MM-DD date' }, { status: 400 })
    const result = await materializeSessions(db, {
      organizationId: organization.id, productId,
      fromDate: typeof body.from === 'string' ? body.from : undefined,
      throughDate: body.through, actorId: session.user.id,
    })
    return jsonResponse({ success: true, ...result })
  } catch (error) {
    rethrowHttpError(error)
    console.error('sessions_generate_failed', { organizationId, productId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to generate sessions' }, { status: 500 })
  }
})
