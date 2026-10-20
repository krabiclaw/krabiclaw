import { jsonResponse, readStrictBody, rethrowHttpError } from '~/server/utils/api-response'
import { requireProductAccess } from '~/server/utils/location-access'
import { requireOrganizationProduct } from '~/server/utils/product-management'
import { updateSession } from '~/server/utils/availability'
import { PRODUCT_SESSION_STATUSES, type ProductSessionStatus } from '~/shared/bookings'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

/**
 * Edit one occurrence: reschedule it, change its seats, or cancel it.
 *
 * This is what replaced the per-date override map. The session is the
 * schedule, so this writes the row bookings already point at, and
 * regeneration will not undo it.
 */
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const productId = getRouterParam(event, 'productId')
  const sessionId = getRouterParam(event, 'sessionId')
  if (!organizationId || !productId || !sessionId) return jsonResponse({ error: 'Organization, product and session IDs are required' }, { status: 400 })
  try {
    const { db, session: auth, organization } = await requireProductAccess(event, organizationId, productId)
    // A product id in the path is not authorized by the site in the path.
    await requireOrganizationProduct(db, { organizationId: organization.id, productId })
    const body = await readStrictBody<{ starts_at?: unknown; ends_at?: unknown; capacity?: unknown; status?: unknown; expected_updated_at: string }>(event, {
      starts_at: 'unknown', ends_at: 'unknown', capacity: 'unknown', status: 'unknown', expected_updated_at: 'string',
    })
    if (!body.expected_updated_at || (body.starts_at !== undefined && typeof body.starts_at !== 'string') || (body.ends_at !== undefined && typeof body.ends_at !== 'string')) return jsonResponse({ error: 'Current updated_at and valid time strings are required' }, { status: 400 })
    if (body.status !== undefined && !(PRODUCT_SESSION_STATUSES as readonly unknown[]).includes(body.status)) {
      return jsonResponse({ error: `status must be one of: ${PRODUCT_SESSION_STATUSES.join(', ')}` }, { status: 400 })
    }
    // Seats, like status, are checked here rather than cast: a capacity of
    // "12" or -1 reached the writer as a number it then wrote.
    if (body.capacity !== undefined && body.capacity !== null
      && (!Number.isSafeInteger(body.capacity) || (body.capacity as number) < 0)) {
      return jsonResponse({ error: 'capacity must be a non-negative integer or null' }, { status: 400 })
    }
    const session = await updateSession(db, {
      organizationId: organization.id, productId, sessionId, actorId: auth.user.id,
      expectedUpdatedAt: body.expected_updated_at,
      startsAt: typeof body.starts_at === 'string' ? body.starts_at : undefined,
      endsAt: typeof body.ends_at === 'string' ? body.ends_at : undefined,
      capacity: body.capacity === undefined ? undefined : (body.capacity as number | null),
      status: body.status as ProductSessionStatus | undefined,
    })
    return jsonResponse({ success: true, session })
  } catch (error) {
    rethrowHttpError(error)
    console.error('session_update_failed', { organizationId, sessionId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to update session' }, { status: 500 })
  }
})
