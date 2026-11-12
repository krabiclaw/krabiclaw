import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { OrganizationLinksValidationError, upsertLinksPage, type LinkItemUpdateInput, type LinksPageUpdateInput } from '~/server/utils/links-page'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })

  const { db, organization, session } = await requireOrganizationAccess(event, organizationId)

  try {
    const body = await readBody<{ page?: LinksPageUpdateInput; items?: LinkItemUpdateInput[] }>(event)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse({ error: 'Invalid links page payload' }, { status: 400 })
    }
    if (!Array.isArray(body.items)) {
      return jsonResponse({ error: 'Invalid links page payload' }, { status: 400 })
    }
    const result = await upsertLinksPage(db, {
      organizationId: organization.id, page: body.page ?? {}, items: body.items, updatedBy: session.user.id, })
    return jsonResponse(result)
  } catch (error) {
    rethrowHttpError(error)
    if (error instanceof OrganizationLinksValidationError) {
      return jsonResponse({ error: error.message }, { status: 400 })
    }
    console.error('Links page save failed:', error)
    return jsonResponse({ error: 'Unable to save links page' }, { status: 500 })
  }
})
import { defineHandler } from 'nitro';
import { getRouterParam, readBody  } from 'nitro/h3';
