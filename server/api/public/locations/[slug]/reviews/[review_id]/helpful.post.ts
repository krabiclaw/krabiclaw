import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { execute, queryFirst } from '~/server/db'
import { getClientIp, hashClientIp, incrementHourlyRateLimit } from '~/server/utils/hourly-rate-limit'

export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined
  const slug = getRouterParam(event, 'slug')
  const reviewId = getRouterParam(event, 'review_id')
  if (!organizationId || !slug || !reviewId) return jsonResponse({ error: 'Missing params' }, { status: 400 })

  const env = cloudflareEnv(event)
  const db = env.db
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const review = await queryFirst<{ id: string; helpful_count: number | null }>(db, `
    SELECT r.id, r.helpful_count
    FROM reviews r
    JOIN business_locations bl ON bl.id = r.location_id
    WHERE r.id = ? AND r.organization_id = ? AND bl.slug = ? AND r.status = 'approved'
    LIMIT 1
  `, [reviewId, organizationId, slug])
  if (!review) return jsonResponse({ error: 'Review not found' }, { status: 404 })

  const ipHash = await hashClientIp(getClientIp(event))
  const allowed = await incrementHourlyRateLimit(db, `rate:review-helpful:${reviewId}:${ipHash}`, 1, 10 * 365 * 86_400_000)
  if (!allowed) return jsonResponse({ helpful: false, helpful_count: review.helpful_count ?? 0 })

  const updated = await queryFirst<{ helpful_count: number }>(db, `
    UPDATE reviews
    SET helpful_count = COALESCE(helpful_count, 0) + 1, updated_at = ?
    WHERE id = ?
    RETURNING helpful_count
  `, [new Date().toISOString(), reviewId])

  return jsonResponse({ helpful: true, helpful_count: updated?.helpful_count ?? (review.helpful_count ?? 0) + 1 })
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
