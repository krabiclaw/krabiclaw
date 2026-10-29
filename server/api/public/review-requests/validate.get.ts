import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { cleanString, cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getReviewRequestByToken, resolveGoogleReviewUrl } from '~/server/utils/review-requests'
import { REVIEW_CATEGORIES } from '~/shared/review-questions'
import { formatTimestamp } from '~/utils/timezone'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const query = getQuery(event)
  const token = cleanString(query.token as string, 300)
  if (!token) return jsonResponse({ error: 'Token required' }, { status: 400 })

  const result = await getReviewRequestByToken(db, token, { markClicked: true })
  if (!result) return jsonResponse({ error: 'Review request not found or expired' }, { status: 404 })
  const { context } = result
  const guestName = context.guest_name?.trim()
  if (!guestName) return jsonResponse({ error: 'The review request has no guest name' }, { status: 500 })
  const firstName = guestName.split(/\s+/)[0]!

  return jsonResponse({
    request: { id: result.request.id, bookingType: result.request.booking_type, expiresAt: result.request.expires_at },
    organization: { id: context.organization_id, name: context.organization_name },
    visit: {
      subject: context.subject,
      title: context.product_title ?? context.location_title,
      at: formatTimestamp(context.visit_starts_at, 'en', context.visit_timezone, { dateStyle: 'medium' }),
      locationTitle: context.location_title,
    },
    questions: REVIEW_CATEGORIES[context.subject],
    location: { googleReviewUrl: context.location_id ? resolveGoogleReviewUrl(context) : null },
    // The two ways the guest may be named on a public review; they choose one.
    displayNames: firstName === guestName ? [guestName] : [firstName, guestName],
  })
})
