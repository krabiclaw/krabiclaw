import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cleanString, cloudflareEnv, jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { execute, queryFirst } from '~/server/db'
import { deleteMediaAsset } from '~/server/utils/media-asset-manager'
import { getReviewRequestByToken } from '~/server/utils/review-requests'

export default defineHandler(async (event) => {
  const requestId = getRouterParam(event, 'request_id')
  const assetId = getRouterParam(event, 'asset_id')
  if (!requestId || !assetId) return jsonResponse({ error: 'Missing params' }, { status: 400 })
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })
  const token = cleanString((await readRequiredBody<ApiRecord>(event)).token, 300)
  if (!token) return jsonResponse({ error: 'Token required' }, { status: 400 })
  const result = await getReviewRequestByToken(db, token)
  if (!result || result.request.id !== requestId) return jsonResponse({ error: 'Review request not found or expired' }, { status: 404 })
  // The token was minted for the booking's user; the deletion is theirs.
  const userId = result.request.user_id
  const placement = await queryFirst<{ id: string; asset_status: string }>(db, `
    SELECT mp.id, ma.status AS asset_status
      FROM media_placements mp JOIN media_assets ma ON ma.id = mp.asset_id
     WHERE mp.owner_type = 'review_request' AND mp.owner_id = ? AND mp.asset_id = ?
       AND mp.organization_id = ? LIMIT 1
  `, [requestId, assetId, result.context.organization_id])
  if (!placement) return jsonResponse({ error: 'Review media not found' }, { status: 404 })
  const claim = await execute(db, 'DELETE FROM media_placements WHERE id = ? AND owner_type = ? AND owner_id = ? AND asset_id = ?', [placement.id, 'review_request', requestId, assetId])
  if (Number(claim?.meta?.changes ?? 0) !== 1) {
    return jsonResponse({ deleted: true, asset_id: assetId })
  }
  if (placement.asset_status !== 'deleted') {
    await deleteMediaAsset(db, env, assetId, result.context.organization_id, userId)
  }
  return jsonResponse({ deleted: true, asset_id: assetId })
})
