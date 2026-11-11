import { execute, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { wantsNotification } from '~/server/domain/notification-preferences'
import { reviewSubject, type ReviewSubject } from '~/shared/review-questions'
import type { ProductKind } from '~/shared/product-details'

/** A submitted request and its review share the booking's ID. */
export function submittedReviewRequestSql(review: string): string {
  return `(SELECT rr.id FROM review_requests rr WHERE rr.organization_id = ${review}.organization_id
    AND rr.booking_id = ${review}.booking_id AND rr.submitted_at IS NOT NULL AND ${review}.source = 'direct')`
}

export interface ReviewRequestRow {
  id: string
  organization_id: string
  location_id: string | null
  user_id: string | null
  /** The booking the guest is asked to review. */
  booking_id: string
  token_hash: string
  token: string | null
  expires_at: string
  first_sent_at: string | null
  reminder_sent_at: string | null
  submitted_at: string | null
  clicked_at: string | null
  revoked_at: string | null
  send_count: number
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface ReviewBookingContext {
  booking_id: string
  /** The booking's conversation, where its invitation is a fact and its review is recorded. */
  request_id: string
  /** What the booking holds: a session's seats or a home's nights. */
  unit: 'slot' | 'nights'
  organization_id: string
  location_id: string | null
  /** The product a booking or stay was for. */
  product_id: string | null
  product_kind: ProductKind
  product_title: string | null
  user_id: string | null
  guest_name: string | null
  guest_email: string | null
  status: string
  no_show_at: string | null
  /** When the visit ended: its booking's end instant; null for a stay whose home had no checkout time. */
  completed_at: string | null
  review_request_sent_at: string | null
  review_submitted_at: string | null
  review_id: string | null
  organization_name: string | null
  organization_vertical?: string | null
  organization_public_url: string | null
  location_title: string | null
  google_place_id: string | null
  google_review_url: string | null
  visit_starts_at: string
  visit_timezone: string
  party_size: number
  subject: ReviewSubject
}

/** How long an invitation's link works, and how long after a visit one is still sent. */
export const REVIEW_REQUEST_TTL_DAYS = 30
/** An invitation goes out this long after the visit ends. */
export const REVIEW_REQUEST_DELAY_HOURS = 24

export function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 86_400_000).toISOString()
}

/**
 * Whether a visit's invitation is due now: it was not cancelled or a no-show,
 * it ended a day ago, no more than the request window ago, and nothing has
 * been sent or submitted for it.
 */
export function reviewInvitationDue(context: ReviewBookingContext, now = new Date()): boolean {
  if (context.completed_at === null) return false
  const ended = Date.parse(context.completed_at)
  return context.status === 'confirmed' && context.no_show_at === null
    && !context.review_request_sent_at && !context.review_submitted_at && !context.review_id
    && ended + REVIEW_REQUEST_DELAY_HOURS * 3_600_000 <= now.getTime()
    && ended + REVIEW_REQUEST_TTL_DAYS * 86_400_000 > now.getTime()
}

export function createReviewRequestToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export async function hashReviewRequestToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function resolveGoogleReviewUrl(location: Pick<ReviewBookingContext, 'google_review_url' | 'google_place_id'>): string | null {
  const manualUrl = location.google_review_url?.trim()
  if (manualUrl) return manualUrl
  const placeId = location.google_place_id?.trim()
  return placeId ? `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}` : null
}

type ReviewBookingContextRow = Omit<ReviewBookingContext, 'completed_at' | 'subject'> & { ends_at: string }

/**
 * The visit a review is about, read from its booking: a session booking (a
 * table, a class, a consultation) or a stay booked directly. A stay from a
 * channel is reviewed on that channel, so it has no context here.
 */
export async function getReviewBookingContext(
  db: DbClient,
  bookingId: string,
): Promise<ReviewBookingContext | null> {
  const row = await queryFirst<ReviewBookingContextRow>(db, `SELECT b.id AS booking_id, r.id AS request_id, CASE WHEN b.product_session_id IS NULL THEN 'nights' ELSE 'slot' END AS unit,
    r.organization_id, r.location_id, r.user_id,
    json_extract(r.payload_json, '$.guest.name') AS guest_name, json_extract(r.payload_json, '$.guest.email') AS guest_email,
    b.status, b.no_show_at, b.ends_at,
    -- Whether the visit was invited and answered is the review_requests record's, not the thread's.
    (SELECT MIN(rr.first_sent_at) FROM review_requests rr WHERE rr.booking_id = b.id) AS review_request_sent_at,
    (SELECT MIN(rr.submitted_at) FROM review_requests rr WHERE rr.booking_id = b.id) AS review_submitted_at,
    (SELECT rv.id FROM reviews rv WHERE rv.organization_id = b.organization_id AND rv.booking_id = b.id ORDER BY rv.created_at LIMIT 1) AS review_id,
    s.name AS organization_name, s.vertical AS organization_vertical, (SELECT 'https://' || domain FROM organization_domains WHERE organization_id = s.id AND role = 'canonical' AND status = 'active') AS organization_public_url,
    bl.title AS location_title, bl.google_place_id, bl.google_review_url,
    b.starts_at AS visit_starts_at, b.timezone AS visit_timezone, b.party_size, b.product_id, p.kind AS product_kind, p.name AS product_title
    FROM bookings b JOIN conversations r ON r.booking_id = b.id AND r.organization_id = b.organization_id AND r.kind = 'booking'
    JOIN organization s ON s.id = b.organization_id LEFT JOIN business_locations bl ON bl.id = r.location_id
    JOIN products p ON p.organization_id = b.organization_id AND p.id = b.product_id
    WHERE b.id = ? AND b.channel = 'direct'`, [bookingId])
  if (!row) return null
  const { ends_at, ...context } = row
  // A stay whose home had no checkout time ends on a day, not at a moment; it is not invited.
  const completedAt = ends_at.length === 10 ? null : ends_at
  return { ...context, completed_at: completedAt, subject: reviewSubject(row.unit === 'nights' ? 'stay' : 'booking', row.product_kind) }
}

export async function getReviewRequestByToken(
  db: DbClient,
  token: string,
  opts: { markClicked?: boolean } = {},
): Promise<{ request: ReviewRequestRow; context: ReviewBookingContext } | null> {
  const tokenHash = await hashReviewRequestToken(token)
  const request = await queryFirst<ReviewRequestRow>(db, `
    SELECT *
    FROM review_requests
    WHERE token_hash = ?
      AND revoked_at IS NULL
      AND submitted_at IS NULL
      AND expires_at > ?
    LIMIT 1
  `, [tokenHash, new Date().toISOString()])

  if (!request) return null
  const context = await getReviewBookingContext(db, request.booking_id)
  if (!context || context.user_id !== request.user_id) return null

  if (opts.markClicked && !request.clicked_at) {
    const now = new Date().toISOString()
    await execute(db, `
      UPDATE review_requests
      SET clicked_at = COALESCE(clicked_at, ?), updated_at = ?
      WHERE id = ?
    `, [now, now, request.id])
    request.clicked_at = now
    request.updated_at = now
  }

  return { request, context }
}

export async function createReviewRequest(
  env: CloudflareEnv,
  db: DbClient,
  context: ReviewBookingContext,
  now = new Date().toISOString(),
): Promise<{ request: ReviewRequestRow; token: string }> {
  if (!context.user_id) throw new Error('Booking is not linked to a guest identity')
  if (!reviewInvitationDue(context, new Date(now))) throw new Error('This visit is not due a review invitation')
  if (!await wantsNotification(db, context.user_id, 'review_requests', 'email')) throw new Error('Guest has opted out of review requests')

  const entitled = await hasOrganizationEntitlement(env, context.organization_id, 'review_requests')
  if (!entitled) throw new Error('Review requests are not enabled for this organization')

  const token = createReviewRequestToken()
  const tokenHash = await hashReviewRequestToken(token)
  const expiresAt = addDays(now, REVIEW_REQUEST_TTL_DAYS)
  const id = crypto.randomUUID()

  await execute(db, `
    INSERT OR IGNORE INTO review_requests (
      id, organization_id, location_id, user_id, booking_id,
      token_hash, token, expires_at, send_count, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `, [
    id,
    context.organization_id,
    context.location_id,
    context.user_id,
    context.booking_id,
    tokenHash,
    token,
    expiresAt,
    now,
    now,
  ])

  let request = await queryFirst<ReviewRequestRow>(db, `
    SELECT * FROM review_requests
    WHERE organization_id = ? AND booking_id = ?
      AND submitted_at IS NULL AND revoked_at IS NULL
  `, [context.organization_id, context.booking_id])

  // Existing invitations keep their link. Recover older rows only from their
  // actual recorded email, checking the hash before adopting its token.
  if (request && request.token === null) {
    const receipts = await queryAll<{ email_json: string | null }>(db, `
      SELECT d.email_json FROM guest_thread_deliveries d
      JOIN messages e ON e.id = d.message_id
      WHERE e.dedupe_key = ? AND d.channel = 'email' AND d.purpose = 'status_update'
    `, [`review-request:${request.id}`])
    let recovered: string | null = null
    for (const receipt of receipts) {
      if (!receipt.email_json) continue
      const html: unknown = JSON.parse(receipt.email_json).message?.html
      if (typeof html !== 'string') throw new Error('Review invitation has an invalid recorded email')
      for (const match of html.matchAll(/\/review-submit\?token=([A-Za-z0-9_-]+)/g)) {
        if (await hashReviewRequestToken(match[1]!) === request.token_hash) recovered = match[1]!
      }
    }
    if (receipts.length && !recovered) throw new Error('Review invitation token cannot be recovered from its recorded email')
    const retained = recovered ?? token
    await execute(db, `UPDATE review_requests SET token = ?, token_hash = ? WHERE id = ? AND token IS NULL`,
      [retained, await hashReviewRequestToken(retained), request.id])
    request = await queryFirst<ReviewRequestRow>(db, 'SELECT * FROM review_requests WHERE id = ?', [request.id])
  }

  if (!request) throw new Error('Failed to create review request')
  if (!request.token || await hashReviewRequestToken(request.token) !== request.token_hash) throw new Error('Review invitation token does not match its recorded hash')
  if (request.user_id !== context.user_id) throw new Error('Review invitation belongs to a different guest identity')
  return { request, token: request.token }
}

export async function markReviewRequestSendSuccess(
  db: DbClient,
  requestId: string,
  sentAt = new Date().toISOString(),
): Promise<void> {
  await execute(db, `
    UPDATE review_requests
    SET first_sent_at = COALESCE(first_sent_at, ?),
        send_count = CASE WHEN first_sent_at IS NULL THEN send_count + 1 ELSE send_count END,
        last_error = NULL,
        updated_at = ?
    WHERE id = ?
  `, [sentAt, sentAt, requestId])
}

export async function markReviewRequestSendFailure(
  db: DbClient,
  requestId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  await execute(db, `
    UPDATE review_requests
    SET last_error = ?, updated_at = ?
    WHERE id = ?
  `, [message.slice(0, 1000), new Date().toISOString(), requestId])
}

/**
 * A no-show or a cancellation ends the visit's invitation: an unsent one is
 * never sent (the record no longer qualifies), and a sent link stops working.
 * Runs in the batch that records the change, after its ledger entry.
 */
export function revokeReviewRequestQuery(bookingId: string, entryId: string, now: string): BatchQuery {
  return {
    query: `
      UPDATE review_requests
      SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
      WHERE booking_id = ? AND submitted_at IS NULL AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM messages WHERE id = ?)
    `,
    params: [now, now, bookingId, entryId],
  }
}
