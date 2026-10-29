import { execute, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { wantsNotification } from '~/server/domain/notification-preferences'
import { localDateTimeToInstant } from '~/utils/timezone'
import { reviewSubject, type ReviewSubject } from '~/shared/review-questions'

export type ReviewBookingType = 'reservation' | 'booking' | 'stay'

export interface ReviewRequestRow {
  id: string
  organization_id: string
  location_id: string | null
  user_id: string | null
  booking_type: ReviewBookingType
  booking_id: string
  token_hash: string
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
  booking_type: ReviewBookingType
  booking_id: string
  organization_id: string
  location_id: string | null
  /** The product a booking or stay was for; a reservation has none. */
  product_id: string | null
  product_kind: string | null
  product_title: string | null
  user_id: string | null
  guest_name: string | null
  guest_email: string | null
  status: string
  no_show_at: string | null
  /** When the visit ended: a reservation's or session's end, a stay's checkout in its home's zone. */
  completed_at: string
  review_request_sent_at: string | null
  review_submitted_at: string | null
  review_id: string | null
  organization_name: string | null
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

type ReviewBookingContextRow = Omit<ReviewBookingContext, 'completed_at' | 'subject'> & {
  ends_at: string | null
  check_out_date: string | null
  check_out_time: string | null
}

/**
 * The visit a review is about, read from the operational record that holds
 * it: a reservation, a session booking, or a stay booked on the site. A stay
 * from a channel is reviewed on that channel, so it has no context here.
 */
export async function getReviewBookingContext(
  db: DbClient,
  bookingType: ReviewBookingType,
  bookingId: string,
): Promise<ReviewBookingContext | null> {
  const row = await queryFirst<ReviewBookingContextRow>(db, `SELECT r.kind AS booking_type, r.id AS booking_id, r.organization_id, r.location_id, r.user_id,
    json_extract(r.payload_json, '$.guest.name') AS guest_name, COALESCE(record.guest_email, json_extract(r.payload_json, '$.guest.email')) AS guest_email,
    record.status, record.no_show_at, record.ends_at, record.check_out_date, record.check_out_time,
    -- Whether the visit was invited and answered is the review_requests record's, not the thread's.
    (SELECT MIN(rr.first_sent_at) FROM review_requests rr WHERE rr.booking_type = r.kind AND rr.booking_id = r.id) AS review_request_sent_at,
    (SELECT MIN(rr.submitted_at) FROM review_requests rr WHERE rr.booking_type = r.kind AND rr.booking_id = r.id) AS review_submitted_at, r.review_id,
    s.name AS organization_name, (SELECT 'https://' || domain FROM organization_domains WHERE organization_id = s.id AND role = 'canonical' AND status = 'active') AS organization_public_url,
    bl.title AS location_title, bl.google_place_id, bl.google_review_url,
    record.starts_at AS visit_starts_at, record.timezone AS visit_timezone, record.party_size, record.product_id, p.kind AS product_kind, p.name AS product_title
    FROM requests r JOIN organization s ON s.id = r.organization_id LEFT JOIN business_locations bl ON bl.id = r.location_id
    -- The visit itself lives on the operational record, never on the thread.
    JOIN (
      SELECT b.request_id, b.status, b.no_show_at, ps.timezone, ps.starts_at, ps.ends_at, NULL AS check_out_date, NULL AS check_out_time, b.party_size, ps.product_id, NULL AS guest_email
        FROM bookings b JOIN product_sessions ps ON ps.id = b.product_session_id
      UNION ALL
      SELECT res.request_id, res.status, res.no_show_at, res.timezone, res.starts_at, res.ends_at, NULL, NULL, res.party_size, NULL, NULL FROM reservations res
      UNION ALL
      SELECT st.request_id, st.status, st.no_show_at, l.timezone, st.check_in_date || 'T' || c.check_in_time, NULL, st.check_out_date, c.check_out_time, st.adults + st.children, st.product_id, st.guest_email
        FROM stays st JOIN product_stay_configs c ON c.organization_id = st.organization_id AND c.product_id = st.product_id
        JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
       WHERE st.channel = 'direct'
    ) record ON record.request_id = r.id
    LEFT JOIN products p ON p.organization_id = r.organization_id AND p.id = record.product_id
    WHERE r.id = ? AND r.kind = ?`, [bookingId, bookingType])
  if (!row) return null
  const { ends_at, check_out_date, check_out_time, ...context } = row
  // A stay ends at its home's checkout time on its checkout date, in the home's own zone.
  const completedAt = bookingType === 'stay'
    ? localDateTimeToInstant(check_out_date!, check_out_time!, row.visit_timezone, 'compatible').toISOString()
    : ends_at!
  const visitStartsAt = bookingType === 'stay'
    ? localDateTimeToInstant(row.visit_starts_at.slice(0, 10), row.visit_starts_at.slice(11), row.visit_timezone, 'compatible').toISOString()
    : row.visit_starts_at
  return { ...context, visit_starts_at: visitStartsAt, completed_at: completedAt, subject: reviewSubject(bookingType, row.product_kind) }
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
  const context = await getReviewBookingContext(db, request.booking_type, request.booking_id)
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

export async function createOrRotateReviewRequest(
  env: CloudflareEnv,
  db: DbClient,
  context: ReviewBookingContext,
  now = new Date().toISOString(),
): Promise<{ request: ReviewRequestRow; token: string; created: boolean }> {
  if (!context.user_id) throw new Error('Booking is not linked to a guest identity')
  if (!reviewInvitationDue(context, new Date(now))) throw new Error('This visit is not due a review invitation')
  if (!await wantsNotification(db, context.user_id, 'review_requests', 'email')) throw new Error('Guest has opted out of review requests')

  const entitled = await hasOrganizationEntitlement(env, context.organization_id, 'review_requests')
  if (!entitled) throw new Error('Review requests are not enabled for this organization')

  const token = createReviewRequestToken()
  const tokenHash = await hashReviewRequestToken(token)
  const expiresAt = addDays(now, REVIEW_REQUEST_TTL_DAYS)
  const id = crypto.randomUUID()

  const insertResult = await execute(db, `
    INSERT OR IGNORE INTO review_requests (
      id, organization_id, location_id, user_id, booking_type, booking_id,
      token_hash, expires_at, send_count, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `, [
    id,
    context.organization_id,
    context.location_id,
    context.user_id,
    context.booking_type,
    context.booking_id,
    tokenHash,
    expiresAt,
    now,
    now,
  ])

  const created = Number(insertResult.meta.changes ?? 0) > 0
  if (!created) {
    await execute(db, `
      UPDATE review_requests
      SET token_hash = ?,
          expires_at = ?,
          last_error = NULL,
          updated_at = ?
      WHERE organization_id = ?
        AND booking_type = ?
        AND booking_id = ?
        AND submitted_at IS NULL
        AND revoked_at IS NULL
    `, [tokenHash, expiresAt, now, context.organization_id, context.booking_type, context.booking_id])
  }

  const request = await queryFirst<ReviewRequestRow>(db, `
    SELECT *
    FROM review_requests
    WHERE token_hash = ?
    LIMIT 1
  `, [tokenHash])

  if (!request) throw new Error('Failed to create review request')
  return { request, token, created }
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
export function revokeReviewRequestQuery(bookingType: ReviewBookingType, requestId: string, entryId: string, now: string): BatchQuery {
  return {
    query: `
      UPDATE review_requests
      SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
      WHERE booking_type = ? AND booking_id = ? AND submitted_at IS NULL AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM activity_entries WHERE id = ?)
    `,
    params: [now, now, bookingType, requestId, entryId],
  }
}
