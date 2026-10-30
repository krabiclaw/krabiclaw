import { jsonResponse } from '~/server/utils/api-response'
import { updateQa } from '~/server/utils/location-qa'
import { requireOrganizationAccess } from '~/server/utils/location-access'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const qaId = getRouterParam(event, 'qaId')
  if (!organizationId || !qaId) return jsonResponse({ error: 'Missing params' }, { status: 400 })
  const { db, organization, session } = await requireOrganizationAccess(event, organizationId)
  const body = await readBody(event)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse({ error: 'Invalid request body' }, { status: 400 })
  }
  return jsonResponse(await updateQa(db, {
    organizationId: organization.id, locationId: null, pagePath: (body as { page_path?: string | null }).page_path ?? null, }, qaId, Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'page_path')), session.user))
})
import { defineHandler } from 'nitro';
import { getRouterParam, readBody  } from 'nitro/h3';
