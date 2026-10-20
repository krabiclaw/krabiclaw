// POST /api/editor/organizations/[organizationId]/locations/[locationId]/qa/reorder
import { jsonResponse } from '~/server/utils/api-response'
import { reorderQa } from '~/server/utils/location-qa'
import { requireLocationAccess } from '~/server/utils/location-access'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const locationId = getRouterParam(event, 'locationId')
  if (!organizationId || !locationId) return jsonResponse({ error: 'Missing params' }, { status: 400 })

  const { db, organization } = await requireLocationAccess(event, organizationId, locationId)

  const body = await readBody(event)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonResponse({ error: 'Invalid request body' }, { status: 400 })
  }

  const updates = (body as { updates?: Array<{ id: string; sort_order: number }> }).updates
  const result = await reorderQa(db, { organizationId: organization.id, locationId }, updates as Array<{ id: string; sort_order: number }>)
  return jsonResponse(result)
})
import { defineHandler } from 'nitro';
import { getRouterParam, readBody  } from 'nitro/h3';
