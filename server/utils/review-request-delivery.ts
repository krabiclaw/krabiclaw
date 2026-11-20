import { PLATFORM_MESSAGE_AUTHOR_KIND } from '~/shared/messages-contract'
import { HTTPError } from 'nitro'
import { execute, queryAll, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { filterEntitledRows } from '~/server/utils/billing-access'
import { wantsCategoryEmailSql } from '~/server/domain/notification-preferences'
import { formatCalendarDate, formatTimestamp } from '~/utils/timezone'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import { notifyReviewRequest } from '~/server/utils/notifications'
import { appendMessage } from '~/server/domain/conversations'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import {
  createReviewRequest,
  getReviewBookingContext,
  historicalNoShowSql,
  markReviewRequestSendFailure,
  markReviewRequestSendSuccess,
  reviewInvitationDue,
  REVIEW_PUBLICATION_PENDING,
  REVIEW_REQUEST_DELAY_MS,
  REVIEW_REQUEST_TTL_DAYS,
} from '~/server/utils/review-requests'

async function publishCompletedReviewInvitation(env: CloudflareEnv, db: DbClient, threadId: string, requestId: string): Promise<void> {
  try {
    await publishConversationEvent(env, db, { conversationId: threadId, type: 'MESSAGE_CREATE' })
    await execute(db, 'UPDATE review_requests SET last_error = NULL WHERE id = ? AND last_error = ?', [requestId, REVIEW_PUBLICATION_PENDING])
  } catch (cause) {
    throw new HTTPError({ statusCode: 503, message: 'The review invitation was sent, but open apps could not be updated. Reload to see its saved status.',
      data: { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true, request_id: requestId }, cause })
  }
}

/**
 * Invite the guest of an ended visit to review it, in that visit's own
 * conversation: the invitation is a fact on the thread, and its email is that
 * fact's delivery receipt, so the team sees it was sent and whether it arrived.
 */
export async function sendReviewRequestForBooking(
  env: CloudflareEnv,
  db: DbClient,
  bookingId: string,
): Promise<{ sent: boolean; requestId: string; error?: string }> {
  const context = await getReviewBookingContext(db, bookingId)
  if (!context) throw new Error('Booking not found')
  if (!reviewInvitationDue(context)) throw new Error('This visit is not due a review invitation')
  const recipientEmail = context.guest_email
  if (!recipientEmail) throw new Error('Booking guest has no email address')
  const publicUrl = context.organization_public_url?.replace(/\/$/, '')
  if (!publicUrl) throw new Error('Organization has no active canonical domain')

  const { request, token } = await createReviewRequest(env, db, context)
  const reviewUrl = `${publicUrl}/review-submit?token=${encodeURIComponent(token)}`
  const threadId = context.request_id
  const entry = await appendMessage(db, {
    conversationId: threadId, authorKind: PLATFORM_MESSAGE_AUTHOR_KIND, authorUserId: null,
    eventName: 'review.requested', body: 'Review invitation sent',
    dedupeKey: `review-request:${request.id}`,
  })

  try {
    await notifyReviewRequest(env, db, {
      organizationId: context.organization_id,
      organizationName: context.organization_name,
      locationId: context.location_id,
      requestId: request.id,
      bookingType: context.unit === 'nights' ? 'stay' : 'booking',
      bookingId: threadId,
      guestName: context.guest_name || 'there',
      email: recipientEmail,
      locationName: context.location_title,
      visitAt: context.visit_starts_at.includes('T') ? formatTimestamp(context.visit_starts_at, 'en', context.visit_timezone) : formatCalendarDate(context.visit_starts_at, 'en'),
      partySize: resolveBookingPresentation(context.product_kind, context.organization_vertical).formatCount(context.party_size),
      partyLabel: resolveBookingPresentation(context.product_kind, context.organization_vertical).partyLabel,
      reviewUrl,
      userId: request.user_id,
      productKind: context.product_kind,
      productTitle: context.product_title,
      // One invitation retains its link and receipt across retries. The
      // receipt is never sent twice once Resend accepted it.
      delivery: { conversationId: threadId, messageId: entry.id },
    })
    await markReviewRequestSendSuccess(db, request.id)
  } catch (error) {
    await markReviewRequestSendFailure(db, request.id, error)
    return {
      sent: false,
      requestId: request.id,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  // Delivery publishes before the invitation's success marker is written.
  // Open apps must read again after that write to clear its outstanding card.
  await publishCompletedReviewInvitation(env, db, threadId, request.id)
  return { sent: true, requestId: request.id }
}

/** Send the business's due invitations and return the next booking's exact deadline. */
export async function sendDueReviewInvitations(env: CloudflareEnv, organizationId: string, now: number): Promise<{ next: number | null }> {
  const publications = await queryAll<{ request_id: string; conversation_id: string }>(env.DB, `
    SELECT rr.id AS request_id, c.id AS conversation_id
    FROM review_requests rr JOIN conversations c ON c.organization_id = rr.organization_id AND c.booking_id = rr.booking_id AND c.kind = 'booking'
    WHERE rr.organization_id = ? AND rr.first_sent_at IS NOT NULL AND rr.last_error = ?
  `, [organizationId, REVIEW_PUBLICATION_PENDING])
  for (const publication of publications) {
    await publishCompletedReviewInvitation(env, env.DB, publication.conversation_id, publication.request_id)
  }
  if (!(await filterEntitledRows(env, [{ organization_id: organizationId }], 'review_requests')).length) return { next: null }
  const wantsReview = wantsCategoryEmailSql('r.user_id', 'review_requests')
  const latestDue = new Date(now - REVIEW_REQUEST_DELAY_MS).toISOString()
  const oldest = new Date(now - REVIEW_REQUEST_TTL_DAYS * 86_400_000).toISOString()
  const rows = await queryAll<{ booking_id: string | null; ends_at: string | null }>(env.DB, `
    WITH eligible AS (
      SELECT b.id AS booking_id, b.ends_at
      FROM bookings b JOIN conversations r ON r.booking_id = b.id AND r.organization_id = b.organization_id AND r.kind = 'booking'
      WHERE b.organization_id = ? AND b.channel = 'direct' AND b.status = 'confirmed'
        AND NOT ${historicalNoShowSql('r')} AND length(b.ends_at) > 10 AND b.ends_at > ?
        AND NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv.organization_id = b.organization_id AND rv.booking_id = b.id)
        AND NOT EXISTS (SELECT 1 FROM review_requests rr WHERE rr.booking_id = b.id
          AND COALESCE(rr.first_sent_at, rr.submitted_at, rr.revoked_at) IS NOT NULL)
        AND json_type(r.payload_json, '$.guest.email') = 'text'
        AND (r.user_id IS NULL OR ${wantsReview.sql})
    )
    SELECT booking_id, ends_at FROM eligible WHERE ends_at <= ?
    UNION ALL SELECT NULL, MIN(ends_at) FROM eligible WHERE ends_at > ?
  `, [organizationId, oldest, ...wantsReview.params, latestDue, latestDue])
  const next = rows.find(row => row.booking_id === null)?.ends_at
  const failures: Error[] = []
  for (const row of rows) {
    if (row.booking_id === null) continue
    try {
      const result = await sendReviewRequestForBooking(env, env.DB, row.booking_id)
      if (!result.sent) throw new Error(result.error ?? 'Review invitation delivery failed')
    } catch (cause) {
      failures.push(new Error(`Booking ${row.booking_id}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }))
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('. '))
  return { next: next == null ? null : Date.parse(next) + REVIEW_REQUEST_DELAY_MS }
}
