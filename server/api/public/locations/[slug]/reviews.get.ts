// GET /api/public/locations/[slug]/reviews
import { queryFirst } from '~/server/db'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { readPublicLocationReviews } from '~/server/utils/organization-reviews'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined
  const slug = getRouterParam(event, 'slug')
  if (!organizationId || !slug) return jsonResponse({ error: 'Missing params' }, { status: 400 })

  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const location = await queryFirst<{ id: string; rating: number | null; review_count: number | null; last_synced_at: string | null }>(
    db, `SELECT id, rating, review_count, last_synced_at FROM business_locations
     WHERE organization_id = ? AND slug = ? AND status = 'active' LIMIT 1`, [organizationId, slug], )
  if (!location) return jsonResponse({ error: 'Location not found' }, { status: 404 })
  return jsonResponse(await readPublicLocationReviews(db, organizationId, location))
})
