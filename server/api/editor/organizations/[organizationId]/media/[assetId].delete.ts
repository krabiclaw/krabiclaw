// DELETE /api/editor/organizations/[organizationId]/media/[assetId]
// Soft-deletes in DB and hard-deletes from Cloudflare Images or R2.
import { cloudflareEnv, jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { deleteMediaAsset } from '~/server/utils/media-asset-manager'
import { anonymizeId } from '~/server/utils/platform-telemetry'
import { assertResourceAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { loadMemberOrganizationRow } from '~/server/utils/location-access'
import { queryFirst } from '~/server/db'

interface MediaAssetOrganizationRow {
  id: string
  organization_id: string
}

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const assetId = getRouterParam(event, 'assetId')
  if (!organizationId || !assetId) return jsonResponse({ error: 'Missing params' }, { status: 400 })

  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })

  const organization = await loadMemberOrganizationRow(event, db, env, organizationId, session.user.id)
  if (!organization) return jsonResponse({ error: 'Organization not found or access denied' }, { status: 404 })

  // Another organization's asset is not found here, rather than refused, so its existence stays private.
  const asset = await queryFirst<MediaAssetOrganizationRow>(db, `SELECT id, organization_id FROM media_assets WHERE id = ? AND organization_id = ? LIMIT 1`, [assetId, organizationId])
  if (!asset) return jsonResponse({ error: 'Asset not found' }, { status: 404 })

  try {
    await assertResourceAccess(db, { ...memberAccessPrincipal(organization.membership, { env, event }), resourceLocationId: null })

    await deleteMediaAsset(db, env, assetId, organizationId, session.user.id)
    return jsonResponse({ deleted: true })
  } catch (error) {
    rethrowHttpError(error)
    const normalizedError = error instanceof Error ? error : new Error('Unknown error')
    const hashedUserId = anonymizeId(session.user.id, env)
    console.error('media_delete_failed', {
      organizationId, assetId, hashedUserId, error: normalizedError.message
    })
    throw error
  }
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
