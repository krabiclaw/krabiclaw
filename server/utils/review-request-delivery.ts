import type { DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { formatTimestamp } from '~/utils/timezone'
import { notifyReviewRequest } from '~/server/utils/notifications'
import { appendEntry } from '~/server/domain/guest-threads/entries'
import {
  createOrRotateReviewRequest,
  getReviewBookingContext,
  markReviewRequestSendFailure,
  markReviewRequestSendSuccess,
  reviewInvitationDue,
  type ReviewBookingType,
} from '~/server/utils/review-requests'

/**
 * Invite the guest of an ended visit to review it, in that visit's own
 * conversation: the invitation is a fact on the thread, and its email is that
 * fact's delivery receipt, so the team sees it was sent and whether it arrived.
 */
export async function sendReviewRequestForBooking(
  env: CloudflareEnv,
  db: DbClient,
  bookingType: ReviewBookingType,
  bookingId: string,
): Promise<{ sent: boolean; requestId: string; error?: string }> {
  const context = await getReviewBookingContext(db, bookingType, bookingId)
  if (!context) throw new Error('Booking not found')
  if (!reviewInvitationDue(context)) throw new Error('This visit is not due a review invitation')
  const recipientEmail = context.guest_email
  if (!recipientEmail) throw new Error('Booking guest has no email address')
  const publicUrl = context.organization_public_url?.replace(/\/$/, '')
  if (!publicUrl) throw new Error('Organization has no active canonical domain')

  const { request, token } = await createOrRotateReviewRequest(env, db, context)
  if (!request.user_id) throw new Error('Review request is not linked to a guest identity')
  const reviewUrl = `${publicUrl}/review-submit?token=${encodeURIComponent(token)}`
  const entry = await appendEntry(db, {
    threadId: bookingId, kind: 'operation', actorKind: 'system',
    eventName: 'review.requested', body: 'Review invitation sent',
    dedupeKey: `review-request:${request.id}`,
  })

  try {
    await notifyReviewRequest(env, db, {
      organizationId: context.organization_id,
      organizationName: context.organization_name,
      locationId: context.location_id,
      requestId: request.id,
      bookingType,
      bookingId,
      guestName: context.guest_name || 'there',
      email: recipientEmail,
      locationName: context.location_title,
      visitAt: formatTimestamp(context.visit_starts_at, 'en', context.visit_timezone),
      partySize: context.party_size === 1 ? '1 guest' : `${context.party_size} guests`,
      reviewUrl,
      userId: request.user_id,
      // Each minted link is its own email: a retry after a failure sends the
      // new link rather than replaying the one it replaced.
      delivery: { guestThreadId: bookingId, sourceEntryId: entry.id, eventKey: `review-request:${request.token_hash}` },
    })
    await markReviewRequestSendSuccess(db, request.id)
    return { sent: true, requestId: request.id }
  } catch (error) {
    await markReviewRequestSendFailure(db, request.id, error)
    return {
      sent: false,
      requestId: request.id,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
