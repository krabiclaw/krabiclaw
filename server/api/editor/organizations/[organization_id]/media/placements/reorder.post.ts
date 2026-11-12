import { memberAccessPrincipal } from '~/server/utils/member-access'
import { jsonResponse, readRequiredBody, rethrowHttpError } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { parseMediaPlacementKey, parseMediaPlacementMoves, reorderMediaPlacements } from '~/server/utils/media-placement'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })

  try {
    const { env, db, organization } = await requireOrganizationAccess(event, organizationId)
    const body = await readRequiredBody<{ placement?: unknown; moves?: unknown }>(event)
    const result = await reorderMediaPlacements(db, {
      env,
      organizationId: organization.id,
      principal: memberAccessPrincipal(organization.membership, { env, event }),
      placement: parseMediaPlacementKey(body.placement),
      moves: parseMediaPlacementMoves(body.moves),
    })
    return jsonResponse(result)
  } catch (error) {
    rethrowHttpError(error)
    console.error('media_placement_reorder_failed', { organizationId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to reorder media' }, { status: 500 })
  }
})
