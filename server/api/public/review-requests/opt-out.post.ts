import { defineHandler } from 'nitro'
import { getQuery, readBody } from 'nitro/h3'
import { cleanString, cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { execute } from '~/server/db'
import { disableCategoryEmail } from '~/server/domain/notification-preferences'
import { getReviewRequestByToken, revokeReviewRequestQuery } from '~/server/utils/review-requests'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  // The footer and RFC 8058 link promise to end only this invitation even if
  // the booking was linked to an account after the invitation was sent.
  const invitationToken = cleanString(getQuery(event).token, 300)
  let token = invitationToken
  if (!token) {
    const body = await readBody<unknown>(event)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse({ error: 'Invalid request body' }, { status: 400 })
    }
    token = cleanString((body as { token?: unknown }).token, 300)
  }
  if (!token) return jsonResponse({ error: 'Token required' }, { status: 400 })

  const result = await getReviewRequestByToken(db, token)
  if (!result) return jsonResponse({ error: 'Review request not found or expired' }, { status: 404 })

  if (!invitationToken && result.request.user_id) {
    await disableCategoryEmail(db, result.request.user_id, 'review_requests', { origin: 'user', env })
  } else {
    const now = new Date().toISOString()
    const revoke = revokeReviewRequestQuery({ query: 'id = ? AND expires_at > ?', params: [result.request.id, now] }, now)
    const write = await execute(db, revoke.query, revoke.params)
    if (!write?.meta?.changes) return jsonResponse({ error: 'Review request not found or expired' }, { status: 404 })
  }
  return jsonResponse({ opted_out: true })
})
