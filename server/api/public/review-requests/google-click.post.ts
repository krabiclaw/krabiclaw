import { defineHandler } from 'nitro'
import { getQuery, readBody } from 'nitro/h3'
import { cleanString, cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { appendMessage } from '~/server/domain/conversations'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import { getReviewRequestByToken, resolveGoogleReviewUrl } from '~/server/utils/review-requests'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  let token = cleanString(getQuery(event).token, 300)
  if (!token) {
    const body = await readBody<unknown>(event)
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      token = cleanString((body as { token?: unknown }).token, 300)
    }
  }
  if (!token) return jsonResponse({ error: 'Token required' }, { status: 400 })

  const result = await getReviewRequestByToken(db, token, { allowSubmitted: true })
  if (!result) return jsonResponse({ error: 'Review request not found or expired' }, { status: 404 })

  const { request, context } = result
  const googleReviewUrl = context.location_id ? resolveGoogleReviewUrl(context) : null

  await appendMessage(db, {
    conversationId: context.request_id,
    authorKind: 'guest',
    authorUserId: request.user_id ?? null,
    eventName: 'review.google_clicked',
    body: 'Opened Google Maps to review',
    dedupeKey: `review-google:${request.id}`,
  })

  await publishConversationEvent(env, db, {
    conversationId: context.request_id,
    type: 'MESSAGE_CREATE',
  })

  return jsonResponse({ recorded: true, google_review_url: googleReviewUrl })
})
