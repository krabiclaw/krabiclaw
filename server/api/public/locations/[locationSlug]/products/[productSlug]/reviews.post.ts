import { execute, queryFirst } from '~/server/db'
import { cleanString, cloudflareEnv, jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { getClientIp, hashClientIp, HOUR_MS, incrementHourlyRateLimit } from '~/server/utils/hourly-rate-limit'
import { loadPublicProductApiDetail } from '~/server/utils/public-products'
import { notifyReviewReceived } from '~/server/utils/notifications'
import { ensureInteractionUser } from '~/server/utils/auth'
import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'

type ReviewStatus = 'pending'

export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined
  const locationSlug = getRouterParam(event, 'locationSlug')
  const productSlug = getRouterParam(event, 'productSlug')
  if (!organizationId || !locationSlug || !productSlug) return jsonResponse({ error: 'Organization, location, and Product slugs are required' }, { status: 400 })
  try {
    const env = cloudflareEnv(event)
    const db = env.DB
    if (!db) return jsonResponse({ error: 'Database unavailable' }, { status: 503 })
    const resolved = await loadPublicProductApiDetail(env, db, organizationId, false, locationSlug, productSlug)
    if (!resolved) return jsonResponse({ error: 'Product not found' }, { status: 404 })
    const body = await readBody(event) as ApiRecord
    const author = cleanString(body.author, 80)
    const title = cleanString(body.title, 120)
    const content = cleanString(body.content, 1200)
    const rating = Number(body.rating)
    if (!author) return jsonResponse({ error: 'Please enter your name.' }, { status: 400 })
    if (!title) return jsonResponse({ error: 'Please add a short review title.' }, { status: 400 })
    if (content.length < 10) return jsonResponse({ error: 'Review text must be at least 10 characters.' }, { status: 400 })
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return jsonResponse({ error: 'Rating must be between 1 and 5.' }, { status: 400 })
    const ipHash = await hashClientIp(getClientIp(event))
    const hourWindow = Math.floor(Date.now() / HOUR_MS)
    const rateOk = await incrementHourlyRateLimit(db, `rate:product-review:${resolved.product.id}:${ipHash}:${hourWindow}`, 5, HOUR_MS)
    if (!rateOk) return jsonResponse({ error: 'Too many attempts. Please try again later.' }, { status: 429 })
    const status: ReviewStatus = 'pending'
    const userAgent = cleanString(event.req.headers.get('User-Agent'), 300)
    // The owner alert follows the insert, so a failed alert answers 500 with
    // the review already stored. The guest's identical retry is the same
    // review: it is found again and its alert re-sent, not stored twice.
    const resubmitted = await queryFirst<{ id: string }>(db, `
      SELECT id FROM reviews
      WHERE organization_id = ? AND location_id = ? AND product_id = ? AND ip_hash = ?
        AND author_name = ? AND rating = ? AND title = ? AND content = ?
        AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')
      LIMIT 1
    `, [organizationId, resolved.location.id, resolved.product.id, ipHash, author, rating, title, content])
    const id = resubmitted?.id ?? crypto.randomUUID()
    if (!resubmitted) {
      const userId = await ensureInteractionUser(event, env)
      await execute(db, `
        INSERT INTO reviews (id, organization_id, location_id, product_id, user_id, author_name, rating, title, content, status, ip_hash, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, organizationId, resolved.location.id, resolved.product.id, userId, author, rating, title, content, status, ipHash, userAgent])
    }
    const organization = await queryFirst<{ name: string }>(db, 'SELECT name FROM organization WHERE id = ?', [organizationId])
    await notifyReviewReceived(env, db, {
      organizationId, organizationName: organization?.name, locationId: resolved.location.id, reviewId: id, authorName: author, rating, content,
    })
    return jsonResponse({ review: { id, product_id: resolved.product.id, author, rating, title, content, status }, message: 'Thanks. Your review is pending moderation.' }, { status: 201 })
  } catch (error) {
    rethrowHttpError(error)
    console.error('public_product_review_create_failed', { organizationId, locationSlug, productSlug, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to create Product review' }, { status: 500 })
  }
})
