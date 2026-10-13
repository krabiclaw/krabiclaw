import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { requireProductAccess } from '~/server/utils/location-access'
import { createSession } from '~/server/utils/availability'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const productId = getRouterParam(event, 'productId')
  if (!organizationId || !productId) throw new HTTPError({ statusCode: 400, statusMessage: 'Organization and product are required' })
  const body = await readStrictBody<{ location_id: string; starts_at: string; ends_at: string; capacity?: number | null; idempotency_key: string }>(event, { location_id: 'unknown', starts_at: 'string', ends_at: 'string', capacity: 'unknown', idempotency_key: 'string' })
  if (typeof body.location_id !== 'string' || !body.location_id) throw new HTTPError({ statusCode: 400, statusMessage: 'Choose a location; online sessions come from the provider\'s working hours' })
  const { db, session, organization } = await requireProductAccess(event, organizationId, productId)
  const created = await createSession(db, { organizationId: organization.id, productId, locationId: body.location_id, actorId: session.user.id, startsAt: body.starts_at, endsAt: body.ends_at, capacity: body.capacity, idempotencyKey: body.idempotency_key })
  return jsonResponse({ success: true, sessions: created }, { status: 201 })
})
