import { memberAccessPrincipal } from '~/server/utils/member-access'
import { jsonResponse, readRequiredBody, rethrowHttpError } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { attachMediaPlacement, parseMediaPlacementKey } from '~/server/utils/media-placement'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })

  try {
    const { env, db, organization } = await requireOrganizationAccess(event, organizationId)
    const body = await readRequiredBody<{ placement?: unknown; asset_id?: unknown }>(event)
    if (typeof body.asset_id !== 'string' || !body.asset_id.trim()) {
      return jsonResponse({ error: 'asset_id is required' }, { status: 400 })
    }
    const result = await attachMediaPlacement(db, {
      env,
      organizationId: organization.id,
      principal: memberAccessPrincipal(organization.membership, { env, event }),
      placement: parseMediaPlacementKey(body.placement),
      assetId: body.asset_id,
    })
    return jsonResponse(result)
  } catch (error) {
    rethrowHttpError(error)
    console.error('media_placement_attach_failed', { organizationId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to attach media' }, { status: 500 })
  }
})
