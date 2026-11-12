import { memberAccessPrincipal } from '~/server/utils/member-access'
import { jsonResponse, readRequiredBody, rethrowHttpError } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { parseMediaPlacementKey, setSingleMediaPlacement } from '~/server/utils/media-placement'
import { isSingleMediaPlacement } from '~/shared/media-placement-contract'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

// Single-value placements only (logo, cover, hero, featured, thumbnail, ...).
// Ordered collections (galleries, compliance documents) use the dedicated
// attach/remove/reorder routes in this same directory instead — a full
// replace is the wrong operation for anything with more than one member.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })

  try {
    const { env, db, organization } = await requireOrganizationAccess(event, organizationId)
    const body = await readRequiredBody<{ placement?: unknown; asset_id?: unknown }>(event)
    if (body.asset_id !== null && (typeof body.asset_id !== 'string' || !body.asset_id.trim())) {
      return jsonResponse({ error: 'asset_id must be a non-empty string or null' }, { status: 400 })
    }
    const placement = parseMediaPlacementKey(body.placement)
    if (!isSingleMediaPlacement(placement)) {
      return jsonResponse({ error: 'This placement is an ordered collection; use attach/remove/reorder instead' }, { status: 400 })
    }
    const result = await setSingleMediaPlacement(db, {
      env,
      organizationId: organization.id,
      principal: memberAccessPrincipal(organization.membership, { env, event }),
      placement,
      assetId: typeof body.asset_id === 'string' ? body.asset_id.trim() : null,
    })
    return jsonResponse(result)
  } catch (error) {
    rethrowHttpError(error)
    console.error('media_placement_update_failed', { organizationId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to update media placement' }, { status: 500 })
  }
})
