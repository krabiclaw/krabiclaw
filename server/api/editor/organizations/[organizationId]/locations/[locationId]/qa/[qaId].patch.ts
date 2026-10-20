// PATCH /api/editor/organizations/[organizationId]/locations/[locationId]/qa/[qaId]
import { jsonResponse } from '~/server/utils/api-response'
import { updateQa } from '~/server/utils/location-qa'
import { requireLocationAccess } from '~/server/utils/location-access'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const locationId = getRouterParam(event, 'locationId')
  const qaId = getRouterParam(event, 'qaId')
  if (!organizationId || !locationId || !qaId) return jsonResponse({ error: 'Missing params' }, { status: 400 })

  const { db, organization } = await requireLocationAccess(event, organizationId, locationId)

  const rawBody = await readBody(event)
  if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) {
    return jsonResponse({ error: 'Invalid request body' }, { status: 400 })
  }
  const body = rawBody as {
    question?: unknown
    answer?: unknown
    question_author?: unknown
    is_owner_answer?: unknown
    status?: unknown
    sort_order?: unknown
  }

  const result = await updateQa(db, { organizationId: organization.id, locationId }, qaId, body)
  return jsonResponse(result)
})
import { defineHandler } from 'nitro';
import { getRouterParam, readBody  } from 'nitro/h3';
