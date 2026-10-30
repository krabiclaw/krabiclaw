import { cleanString, cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { executeBatch, queryAll, type BatchQuery } from '~/server/db'
import { getClientIp, hashClientIp, incrementHourlyRateLimit } from '~/server/utils/hourly-rate-limit'
import { getReviewRequestByToken, hashReviewRequestToken } from '~/server/utils/review-requests'
import { notifyReviewReceived } from '~/server/utils/notifications'
import { REVIEW_CATEGORIES } from '~/shared/review-questions'

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
  const rating = Number(bodyRecord.rating)
  if (!token) return jsonResponse({ error: 'Token required' }, { status: 400 })
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return jsonResponse({ error: 'Rating must be between 1 and 5.' }, { status: 400 })
  // Publishing is the guest's own consent; without it there is no public part at all.
  if (typeof bodyRecord.publish !== 'boolean') return jsonResponse({ error: 'Say whether to share a public review.' }, { status: 400 })
  const publish = bodyRecord.publish
  const title = cleanString(bodyRecord.title, 120) || null
  const content = cleanString(bodyRecord.content, 2000)
  const privateFeedback = cleanString(bodyRecord.privateFeedback, 2000) || null
  if (publish && content.length < 10) return jsonResponse({ error: 'Review text must be at least 10 characters.' }, { status: 400 })
  if (!publish && (title || content)) return jsonResponse({ error: 'A review that is not shared publicly has no public text.' }, { status: 400 })
  const categoryInput = bodyRecord.categories ?? {}
  if (!categoryInput || typeof categoryInput !== 'object' || Array.isArray(categoryInput)) return jsonResponse({ error: 'Category ratings must be an object.' }, { status: 400 })

  const tokenHash = await hashReviewRequestToken(token)
  const clientIp = getClientIp(event)
  const ipHash = await hashClientIp(clientIp)
  const hourWindow = Math.floor(Date.now() / 3_600_000)
  const rateOk = await incrementHourlyRateLimit(db, `rate:review-submit:${tokenHash}:${ipHash}:${hourWindow}`, 5, 3_600_000)
  if (!rateOk) return jsonResponse({ error: 'Too many attempts. Please try again later.' }, { status: 429 })

  const result = await getReviewRequestByToken(db, token)
  if (!result) return jsonResponse({ error: 'Review request not found or expired' }, { status: 404 })
  // Only the visit's own questions, each answered 1-5; one the guest skipped stays unanswered.
  const questions = new Set<string>(REVIEW_CATEGORIES[result.context.subject].map(question => question.key))
  const categories = Object.entries(categoryInput as Record<string, unknown>)
  for (const [key, value] of categories) {
    if (!questions.has(key)) return jsonResponse({ error: `"${key}" is not a question about this visit.` }, { status: 400 })
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 5) return jsonResponse({ error: 'Each category rating must be between 1 and 5.' }, { status: 400 })
  }

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
  if (!publish && mediaRows.length) return jsonResponse({ error: 'Photos and videos are part of a public review. Remove them, or share your review publicly.' }, { status: 409 })
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
  const guestName = result.context.guest_name?.trim()
  if (!guestName) throw new HTTPError({ statusCode: 500, message: 'The review request has no guest name', data: { code: 'INVALID_REVIEW_REQUEST', field: 'guest_name' } })
  // A public review shows the name the guest chose: their first name, or their name as booked.
  const displayNames = [guestName.split(/\s+/)[0]!, guestName]
  const displayName = cleanString(bodyRecord.displayName, 200)
  if (publish && !displayNames.includes(displayName)) return jsonResponse({ error: 'Choose how your name appears on your review.' }, { status: 400 })
  const authorName = publish ? displayName : guestName
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
        id, organization_id, location_id, product_id, booking_id, booking_type, review_request_id, user_id, author_name, rating, title, content, private_feedback, publication_authorized, status, source, ip_hash, user_agent, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'direct', ?, ?, ?, ?
      WHERE ${requestIsSubmittable}`, params: [
        reviewId, result.context.organization_id, result.context.location_id, result.context.product_id, result.request.booking_id, result.request.booking_type, result.request.id, reviewUserId, authorName, rating,
        publish ? title : null, publish ? content : null, privateFeedback, publish ? 1 : 0,
        // A private review is never moderated or published; a public one waits for the owner.
        publish ? 'pending' : 'private',
        ipHash, userAgent, now, now, ...requestGuardParams, ], }, batchAssertion('changes() = 1', [], 'review insert lost its request-state guard'),
    ...categories.map(([category, score]) => ({
      query: 'INSERT INTO review_category_ratings (review_id, category, rating) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM reviews WHERE id = ?)',
      params: [reviewId, category, score, reviewId],
    })), {
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
        SET review_id = ?, updated_at = ?
        WHERE id = ? AND kind = ?
          AND organization_id = ?
          AND user_id IS ?
          AND review_id IS NULL`, params: [
        reviewId, now, result.request.booking_id, result.request.booking_type, result.context.organization_id, reviewUserId, ], }, batchAssertion('changes() = 1', [], 'review booking submission compare-and-set failed'), )

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
    organizationId: result.context.organization_id, organizationName: result.context.organization_name, locationId: result.context.location_id, reviewId, authorName, rating,
    content: publish ? content : null, hasPrivateFeedback: privateFeedback !== null, visitRequestId: result.request.booking_id, })

  return jsonResponse({ success: true, reviewId, status: publish ? 'pending' : 'private' }, { status: 201 })
})
import { defineHandler, HTTPError } from 'nitro';
import { getHeader } from 'nitro/h3';
import { readBody } from 'nitro/h3';
