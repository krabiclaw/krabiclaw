import { cleanString, cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { executeBatch, queryAll, type BatchQuery } from '~/server/db'
import { getClientIp, hashClientIp, incrementHourlyRateLimit } from '~/server/utils/hourly-rate-limit'
import { getReviewRequestByToken, hashReviewRequestToken } from '~/server/utils/review-requests'
import { notifyReviewReceived } from '~/server/utils/notifications'

function batchAssertion(condition: string, params: unknown[], message: string): BatchQuery {
  return {
    query: `SELECT CASE WHEN (${condition}) THEN NULL ELSE json(?) END`, params: [...params, message], }
}

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const body = await readBody<unknown>(event)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse({ error: 'Invalid request body' }, { status: 400 })
  }
  const bodyRecord = body as Record<string, unknown>
  const token = cleanString(bodyRecord.token, 300)
  const title = cleanString(bodyRecord.title, 120) || null
  const content = cleanString(bodyRecord.content, 2000)
  const rating = Number(bodyRecord.rating)
  if (!token) return jsonResponse({ error: 'Token required' }, { status: 400 })
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return jsonResponse({ error: 'Rating must be between 1 and 5.' }, { status: 400 })
  if (content.length < 10) return jsonResponse({ error: 'Review text must be at least 10 characters.' }, { status: 400 })

  const tokenHash = await hashReviewRequestToken(token)
  const clientIp = getClientIp(event)
  const ipHash = await hashClientIp(clientIp)
  const hourWindow = Math.floor(Date.now() / 3_600_000)
  const rateOk = await incrementHourlyRateLimit(db, `rate:review-submit:${tokenHash}:${ipHash}:${hourWindow}`, 5, 3_600_000)
  if (!rateOk) return jsonResponse({ error: 'Too many attempts. Please try again later.' }, { status: 429 })

  const result = await getReviewRequestByToken(db, token)
  if (!result) return jsonResponse({ error: 'Review request not found or expired' }, { status: 404 })

  // The emailed token is the proof of who is writing: it was minted for the
  // booking's Better Auth user, and the review belongs to that user whatever
  // browser the link is opened in.
  const reviewUserId = result.request.user_id
  const mediaRows = await queryAll<{ asset_id: string; kind: string; asset_status: string }>(db, `
    SELECT mp.asset_id, ma.kind, ma.status AS asset_status
    FROM media_placements mp JOIN media_assets ma ON ma.id = mp.asset_id
    WHERE mp.owner_type = 'review_request' AND mp.owner_id = ? AND mp.status = 'pending'
    ORDER BY mp.sort_order
  `, [result.request.id])
  if (mediaRows.some(row => row.asset_status !== 'active')) {
    return jsonResponse({ error: 'Wait for all media uploads to finish before submitting.' }, { status: 409 })
  }
  const imageCount = mediaRows.filter(row => row.kind === 'image').length
  const videoCount = mediaRows.filter(row => row.kind === 'video').length
  if (imageCount > 5 || videoCount > 2 || mediaRows.length !== imageCount + videoCount) {
    return jsonResponse({ error: 'You can attach up to 5 photos and 2 videos.' }, { status: 400 })
  }
  const mediaCount = mediaRows.length
  const reviewId = crypto.randomUUID()
  const now = new Date().toISOString()
  // The request's conversation carries the guest's name (requests_guest_payload_check).
  const authorName = result.context.guest_name?.trim()
  if (!authorName) throw new HTTPError({ statusCode: 500, message: 'The review request has no guest name', data: { code: 'INVALID_REVIEW_REQUEST', field: 'guest_name' } })
  const userAgent = cleanString((event.req.headers.get('User-Agent')), 300)

  const requestIsSubmittable = `EXISTS (
    SELECT 1
    FROM review_requests rr
    WHERE rr.id = ?
      AND rr.token_hash = ?
      AND rr.organization_id = ?
      AND rr.user_id IS ?
      AND rr.booking_type = ?
      AND rr.booking_id = ?
      AND rr.revoked_at IS NULL
      AND rr.submitted_at IS NULL
      AND rr.expires_at > ?
      AND NOT EXISTS (
        SELECT 1 FROM reviews existing_review WHERE existing_review.review_request_id = rr.id
      )
  )`
  const requestGuardParams = [
    result.request.id, tokenHash, result.context.organization_id, reviewUserId, result.request.booking_type, result.request.booking_id, now, ]
  const batch: BatchQuery[] = [
    batchAssertion(
      requestIsSubmittable, requestGuardParams, 'review request state changed during submission', ), batchAssertion(
      `EXISTS (
        SELECT 1 FROM requests
        WHERE id = ? AND kind = ?
          AND organization_id = ?
          AND user_id IS ?
          AND json_extract(payload_json, '$.review.submitted_at') IS NULL
          AND review_id IS NULL
      )`, [
        result.request.booking_id, result.request.booking_type, result.context.organization_id, reviewUserId, ], 'review booking state changed during submission', ), ]

  if (mediaCount) {
    batch.push(batchAssertion(
      `(
        SELECT COUNT(*) = ?
          AND SUM(CASE WHEN ma.status = 'active' THEN 1 ELSE 0 END) = ?
          AND SUM(CASE WHEN ma.kind = 'image' THEN 1 ELSE 0 END) <= 5
          AND SUM(CASE WHEN ma.kind = 'video' THEN 1 ELSE 0 END) <= 2
        FROM media_placements mp JOIN media_assets ma ON ma.id = mp.asset_id
        WHERE mp.owner_type = 'review_request' AND mp.owner_id = ?
          AND mp.status = 'pending'
      )`, [mediaCount, mediaCount, result.request.id], 'review media state changed during submission', ))
  }

  batch.push(
    {
      query: `INSERT INTO reviews (
        id, organization_id, location_id, product_id, booking_id, booking_type, review_request_id, user_id, author_name, rating, title, content, status, source, ip_hash, user_agent, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'direct', ?, ?, ?, ?
      WHERE ${requestIsSubmittable}`, params: [
        reviewId, result.context.organization_id, result.context.location_id, result.context.product_id, result.request.booking_id, result.request.booking_type, result.request.id, reviewUserId, authorName, rating, title, content, ipHash, userAgent, now, now, ...requestGuardParams, ], }, batchAssertion('changes() = 1', [], 'review insert lost its request-state guard'), {
      query: `UPDATE review_requests
        SET submitted_at = ?, updated_at = ?
        WHERE id = ?
          AND token_hash = ?
          AND organization_id = ?
          AND user_id IS ?
          AND booking_type = ?
          AND booking_id = ?
          AND submitted_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > ?`, params: [
        now, now, ...requestGuardParams, ], }, batchAssertion('changes() = 1', [], 'review request submission compare-and-set failed'), {
      query: `UPDATE requests
        SET payload_json = json_set(payload_json, '$.review.submitted_at', ?), review_id = ?, updated_at = ?
        WHERE id = ? AND kind = ?
          AND organization_id = ?
          AND user_id IS ?
          AND json_extract(payload_json, '$.review.submitted_at') IS NULL
          AND review_id IS NULL`, params: [
        now, reviewId, now, result.request.booking_id, result.request.booking_type, result.context.organization_id, reviewUserId, ], }, batchAssertion('changes() = 1', [], 'review booking submission compare-and-set failed'), )

  if (mediaCount) {
    batch.push(
      {
        query: `UPDATE media_placements
          SET owner_type = 'review', owner_id = ?, updated_at = ?
          WHERE owner_type = 'review_request' AND owner_id = ?
            AND status = 'pending'`, params: [reviewId, now, result.request.id], }, batchAssertion(
        'changes() = ?', [mediaCount], 'review media attachment compare-and-set failed', ), )
  }

  await executeBatch(db, batch)

  await notifyReviewReceived(env, db, {
    organizationId: result.context.organization_id, organizationName: result.context.organization_name, locationId: result.context.location_id, reviewId, authorName, rating, content, })

  return jsonResponse({ success: true, reviewId, status: 'pending' }, { status: 201 })
})
import { defineHandler, HTTPError } from 'nitro';
import { getHeader } from 'nitro/h3';
import { readBody } from 'nitro/h3';
