import { HTTPError } from 'nitro'
import type { DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { formatCalendarDate, formatTimestamp } from '~/utils/timezone'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import { notifyReviewRequest } from '~/server/utils/notifications'
import { appendEntry } from '~/server/domain/guest-threads/entries'
import { publishGuestInboxThreadEvent } from '~/server/cloudflare/guest-inbox-events'
import {
  createReviewRequest,
  getReviewBookingContext,
  markReviewRequestSendFailure,
  markReviewRequestSendSuccess,
  reviewInvitationDue,
} from '~/server/utils/review-requests'

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
  if (!request.user_id) throw new Error('Review request is not linked to a guest identity')
  const reviewUrl = `${publicUrl}/review-submit?token=${encodeURIComponent(token)}`
  const threadId = context.request_id
  const entry = await appendEntry(db, {
    threadId, kind: 'operation', actorKind: 'system',
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
      // One invitation retains its link and receipt across retries. The
      // receipt is never sent twice once Resend accepted it.
      delivery: { guestThreadId: threadId, sourceEntryId: entry.id },
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
  try {
    await publishGuestInboxThreadEvent(env, db, { threadId, type: 'thread.changed' })
  } catch (cause) {
    throw new HTTPError({ statusCode: 503, message: 'The review invitation was sent, but open apps could not be updated. Reload to see its saved status.',
      data: { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true, request_id: request.id }, cause })
  }
  return { sent: true, requestId: request.id }
}
