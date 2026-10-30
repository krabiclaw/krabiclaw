import { jsonResponse } from '~/server/utils/api-response'
import { reorderQa } from '~/server/utils/location-qa'
import { requireOrganizationAccess } from '~/server/utils/location-access'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
  const { db, organization, session } = await requireOrganizationAccess(event, organizationId)
  const body = await readBody<{ page_path?: string | null; updates?: Array<{ id?: unknown; sort_order?: unknown }> }>(event)
  const pagePath = body?.page_path ?? null
  const updates = body?.updates as Array<{ id: string; sort_order: number }>
  return jsonResponse(await reorderQa(db, {
    organizationId: organization.id, locationId: null, pagePath, }, updates, session.user))
})
import { defineHandler } from 'nitro';
import { getRouterParam, readBody  } from 'nitro/h3';
