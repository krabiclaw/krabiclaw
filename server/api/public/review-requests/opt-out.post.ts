import { cleanString, cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { disableCategoryEmail } from '~/server/domain/notification-preferences'
import { getReviewRequestByToken } from '~/server/utils/review-requests'

// The review link's own opt-out. The token identifies the Better Auth user the
// request was minted for, and the opt-out is that person's review_requests
// email preference — the same row the signed footer unsubscribe writes.
export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const body = await readBody<unknown>(event)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse({ error: 'Invalid request body' }, { status: 400 })
  }
  const token = cleanString((body as { token?: unknown }).token, 300)
  if (!token) return jsonResponse({ error: 'Token required' }, { status: 400 })

  const result = await getReviewRequestByToken(db, token)
  if (!result) return jsonResponse({ error: 'Review request not found or expired' }, { status: 404 })
  if (!result.request.user_id) return jsonResponse({ error: 'This review request is not linked to a guest' }, { status: 409 })

  await disableCategoryEmail(db, result.request.user_id, 'review_requests', { origin: 'user', env })
  return jsonResponse({ opted_out: true })
})
import { defineHandler } from 'nitro';
import { readBody } from 'nitro/h3';
