import { z } from 'zod'
import { HTTPError } from 'nitro'
import { guestReservationRefundQueries } from '~/server/domain/payments/visit-refund'
import { executeRefund, requirePayment } from '~/server/domain/payments'
import { createStripeClient } from '~/server/utils/stripe-client'
import type { CloudflareEnv } from '~/server/utils/auth'
import { recordBookingCancelled } from '~/server/domain/booking-analytics'
import { executeBatch, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { isBookingComplete, type BookingStatus } from '~/shared/bookings'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'

/**
 * The inbox.
 *
 * A request is one conversation thread with a guest and its workflow state.
 * It is NOT the booking. It used to carry (product_id, booking_date,
 * time_slot, party_size, status) as an independently writable copy of an
 * occurrence; the occurrence is now a `product_sessions` row, the seat claim
 * a `bookings` row, and a table reservation a `reservations` row. Each of
 * those links back here through `request_id`.
 *
 * A contact thread has neither and is not forced into the booking model.
 */

const guest = z.object({ name: z.string(), email: z.string(), phone: z.string().nullable(), locale: z.string().optional() })

/**
 * What the thread itself owns.
 *
 * `cancellation` is the emailed self-service token: the thread's capability,
 * not the booking's state. Whether the booking is cancelled is
 * `bookings.status`; `used_at` only records that this token was spent.
 * Completion and review timestamps are deliberately absent — those belong to
 * `bookings.completed_at` and the `review_requests` record.
 */
const threadPayload = z.object({
  provenance: z.object({ source: z.string(), external_reference: z.string().nullable(), actor_user_id: z.string().nullable(), idempotency_key: z.string(), fingerprint: z.string(), guest_acknowledgement: z.boolean(), creation_kind: z.enum(['ordinary', 'checkout']), creation_status: z.enum(['pending', 'confirmed']), followups_completed: z.boolean() }).optional(),
  guest,
  party_size_is_minimum: z.boolean(),
  notes: z.string().nullable(),
  ip_hash: z.string().nullable(),
  cancellation: z.object({ token_hash: z.string().nullable(), expires_at: z.string().nullable(), used_at: z.string().nullable() }),
})

const threadScope = z.object({
  id: z.string(), organization_id: z.string(),  location_id: z.string().nullable(),
  user_id: z.string().nullable(), review_id: z.string().nullable(),
  conversation_state: z.enum(['needs_attention', 'waiting_on_guest', 'resolved']), resolved_at: z.string().nullable(),
  archived_at: z.string().nullable(), archived_by_user_id: z.string().nullable(),
  created_at: z.string(), updated_at: z.string(),
})

export const guestRequestSchema = z.discriminatedUnion('kind', [
  threadScope.extend({ kind: z.literal('contact'), payload: z.object({
    guest, subject: z.string().nullable(), message: z.string(), consent_at: z.string().nullable(), ip_hash: z.string().nullable(),
    // Where the message came from, when a form or ChatGPT escalation says so.
    source: z.string().nullable().optional(), route_context: z.string().nullable().optional(),
    suggested_summary: z.string().nullable().optional(), agent_metadata: z.unknown().optional(),
  }) }),
  threadScope.extend({ kind: z.literal('reservation'), payload: threadPayload.extend({ guest: guest.extend({ phone: z.string() }) }) }),
  threadScope.extend({ kind: z.literal('booking'), payload: threadPayload }),
])
export type GuestRequest = z.infer<typeof guestRequestSchema>
export type BookingRequest = Extract<GuestRequest, { kind: 'reservation' | 'booking' }>
export type GuestRequestKind = GuestRequest['kind']
export type ThreadPayload = z.infer<typeof threadPayload>

/** The authenticated business operation that created a guest commitment. */
export interface BookingOperator {
  userId: string
  idempotencyKey: string
  source: string
  externalReference: string | null
  guestAcknowledgement: boolean
}

/** The operational record a thread links to, when it has one. */
export interface ThreadOperationalRecord {
  assigned_member_id: string | null
  kind: 'booking' | 'reservation'
  id: string
  status: BookingStatus
  party_size: number
  starts_at: string
  ends_at: string
  timezone: string
  location_id: string | null
  product_id: string | null
  product_name: string | null
  organization_id: string
  user_id: string | null
}

export function parseGuestRequest(row: Record<string, unknown>): GuestRequest {
  if (typeof row.payload_json !== 'string') throw new Error('Request payload is missing')
  return guestRequestSchema.parse({ ...row, payload: JSON.parse(row.payload_json) })
}

/** Resource ownership belongs to the current request and every actual linked operational record. */
export const REQUEST_CURRENT_BUYER_SQL = `r.user_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.request_id=r.id AND (b.user_id IS NULL OR b.user_id<>r.user_id OR b.organization_id<>r.organization_id OR r.kind<>'booking'))
 AND NOT EXISTS(SELECT 1 FROM reservations v WHERE v.request_id=r.id AND (v.user_id IS NULL OR v.user_id<>r.user_id OR v.organization_id<>r.organization_id OR r.kind<>'reservation'))`

export async function getGuestRequest(db: DbClient, id: string, organizationId?: string, kind?: GuestRequestKind, buyerUserId?:string): Promise<GuestRequest | null> {
  const row = await queryFirst<Record<string, unknown>>(db, `SELECT r.* FROM requests r WHERE r.id = ? AND r.kind IN ('contact', 'reservation', 'booking')${organizationId ? ' AND r.organization_id = ?' : ''}${kind ? ' AND r.kind = ?' : ''}${buyerUserId?` AND r.user_id=? AND ${REQUEST_CURRENT_BUYER_SQL}`:''}`, [id, ...(organizationId ? [organizationId] : []), ...(kind ? [kind] : []),...(buyerUserId?[buyerUserId]:[])])
  return row ? parseGuestRequest(row) : null
}

/**
 * Load the booking or reservation a thread refers to.
 *
 * A contact thread has no operational record. A booking or reservation thread
 * must have its own tenant's matching record after allocation. Uncaptured
 * Checkout has only its native payment and capacity hold until conversion.
 */
export async function getThreadOperationalRecord(db: DbClient, requestId: string): Promise<ThreadOperationalRecord | null> {
  const record = await queryFirst<ThreadOperationalRecord>(db, `
    SELECT 'booking' AS kind, b.id, b.status, b.party_size, s.starts_at, s.ends_at, s.timezone,
           s.location_id, b.product_id, p.name AS product_name, b.assigned_member_id, b.organization_id, b.user_id
      FROM bookings b
      JOIN requests owner ON owner.id = b.request_id AND owner.kind = 'booking' AND owner.organization_id = b.organization_id
      JOIN product_sessions s ON s.id = b.product_session_id AND s.product_id = b.product_id AND s.organization_id = b.organization_id
      JOIN products p ON p.id = b.product_id AND p.organization_id = b.organization_id
     WHERE b.request_id = ?
    UNION ALL
    SELECT 'reservation', r.id, r.status, r.party_size, r.starts_at, r.ends_at, r.timezone,
           r.location_id, NULL, NULL, NULL, r.organization_id, r.user_id
      FROM reservations r
      JOIN requests owner ON owner.id = r.request_id AND owner.kind = 'reservation' AND owner.organization_id = r.organization_id
     WHERE r.request_id = ?
     LIMIT 1
  `, [requestId, requestId])
  if (record) return record
  const request = await queryFirst<{ kind: GuestRequestKind; uncaptured_checkout: number | null }>(db, `
    SELECT r.kind,
      (json_extract(r.payload_json, '$.provenance.creation_kind') = 'checkout'
       AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.request_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM reservations v WHERE v.request_id = r.id)
       AND EXISTS (
         SELECT 1 FROM payment_checkout_holds h
         JOIN payments p ON p.id = h.payment_id AND p.organization_id = h.organization_id AND p.subject_type = r.kind
         JOIN payment_attempts a ON a.payment_id = p.id
           AND a.idempotency_key = 'checkout:' || r.organization_id || ':' || json_extract(r.payload_json, '$.provenance.idempotency_key')
         WHERE h.request_id = r.id AND h.organization_id = r.organization_id
           AND h.status IN ('active', 'released') AND h.converted_booking_id IS NULL AND h.converted_reservation_id IS NULL
           AND p.state IN ('pending', 'failed') AND p.captured_amount = 0 AND p.subject_id IS NULL
           AND a.status IN ('creating', 'open', 'expired', 'failed')
       )) AS uncaptured_checkout
    FROM requests r WHERE r.id = ?
  `, [requestId])
  if (request?.uncaptured_checkout === 1) return null
  if (request && request.kind !== 'contact') throw new HTTPError({ statusCode: 404, message: 'The conversation has no matching booking or reservation', data: { code: 'REQUEST_OPERATIONAL_RECORD_NOT_FOUND', request_id: requestId } })
  return null
}

/**
 * The thread and the activity entry that opens it.
 *
 * `claimedBy` is the row whose existence this thread depends on — the booking
 * or reservation written earlier in the same batch. A conditional claim that
 * finds no room inserts zero rows WITHOUT raising, so a thread written before
 * it would commit anyway and leave a conversation about a seat nobody holds.
 * Carrying the claim's existence into this insert is what ties them together.
 *
 * A new thread has not been archived by anyone, so it carries no archive state.
 */
export function requestInsertQueries(request: Omit<GuestRequest, 'archived_at' | 'archived_by_user_id'>, claimedBy?: BatchQuery): BatchQuery[] {
  const provenance = request.kind !== 'contact' && 'provenance' in request.payload ? request.payload.provenance : undefined
  const values = [request.id, request.kind, request.organization_id, request.location_id, request.user_id, request.review_id,
    request.conversation_state, request.resolved_at, JSON.stringify(request.payload), request.created_at, request.updated_at]
  return [{
    query: claimedBy
      ? `INSERT INTO requests (id, kind, organization_id, location_id, user_id, review_id, conversation_state, resolved_at, payload_json, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${claimedBy.query})`
      : `INSERT INTO requests (id, kind, organization_id, location_id, user_id, review_id, conversation_state, resolved_at, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: claimedBy ? [...values, ...(claimedBy.params ?? [])] : values,
  }, {
    query: `INSERT INTO activity_entries (id, request_id, kind, scope_kind, actor_kind, actor_user_id, channel, payload_json, dedupe_key, sequence, occurred_at, created_at)
      SELECT ?, id, 'submission', 'request', ?, ?, ?, json_object('kind', kind), ?, 1, created_at, created_at FROM requests WHERE id = ? AND changes() = 1`,
    params: [crypto.randomUUID(), provenance?.actor_user_id ? 'member' : 'guest', provenance?.actor_user_id ?? request.user_id, provenance?.actor_user_id ? 'system' : 'web', `request:${request.id}:submission`, request.id],
  }, publicResourceCacheInvalidationQuery(request.organization_id, 'guest-thread-create')]
}

interface GuestThreadInput { name: string; email: string; phone?: string | null; locale?: string; notes?: string | null; ipHash?: string | null; partySizeIsMinimum?: boolean }
export function threadPayloadForGuest(input: GuestThreadInput & { phone: string }): ThreadPayload & { guest: { phone: string } }
export function threadPayloadForGuest(input: GuestThreadInput): ThreadPayload
export function threadPayloadForGuest(input: GuestThreadInput): ThreadPayload {
  return {
    guest: { name: input.name, email: input.email, phone: input.phone ?? null, ...(input.locale === undefined ? {} : { locale: input.locale }) },
    notes: input.notes ?? null, ip_hash: input.ipHash ?? null,
    party_size_is_minimum: input.partySizeIsMinimum ?? false,
    cancellation: { token_hash: null, expires_at: null, used_at: null },
  }
}

/**
 * What a tenant can still do. Nothing is approved and nothing is marked done:
 * a booking arrives confirmed, and one whose end has passed is complete
 * because the clock says so.
 */
export function requestActions(record: ThreadOperationalRecord | null, now: string): string[] {
  if (!canCancelBookingRequest(record, now)) return []
  return record.kind === 'booking' && record.status === 'pending' ? ['confirm', 'reject', 'change', 'cancel'] : ['change', 'cancel']
}

export function canCancelBookingRequest(record: ThreadOperationalRecord | null, now: string): record is ThreadOperationalRecord {
  return Boolean(record && ['pending', 'confirmed'].includes(record.status) && record.ends_at > now && !isBookingComplete(record, now))
}

export function requestPreview(request: GuestRequest, record: ThreadOperationalRecord | null): string {
  if (request.kind === 'contact') return request.payload.message.replace(/\s+/g, ' ').trim().slice(0, 160)
  if (request.payload.notes) return request.payload.notes.replace(/\s+/g, ' ').trim().slice(0, 160)
  // With no operational record there is nothing to summarize, and inventing a
  // date would make a broken thread look ordinary.
  if (!record) return ''
  const local = new Intl.DateTimeFormat('en-US', { timeZone: record.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(record.starts_at))
  return `${local} · ${record.party_size}${request.payload.party_size_is_minimum ? '+' : ''} guests`.slice(0, 160)
}

export async function requestSummary(db: DbClient, request: GuestRequest, knownRecord?: ThreadOperationalRecord | null) {
  const record = knownRecord === undefined ? await getThreadOperationalRecord(db, request.id) : knownRecord
  const labels = await queryFirst<{ location_title: string | null }>(db, 'SELECT title AS location_title FROM business_locations WHERE id = ?', [request.location_id])
  return {
    guestName: request.payload.guest.name, guestEmail: request.payload.guest.email, guestPhone: request.payload.guest.phone,
    organizationId: request.organization_id, locationId: request.location_id,
    locationTitle: labels?.location_title ?? null, productTitle: record?.product_name ?? null,
    contextLabel: requestPreview(request, record), createdAt: request.created_at,
    operationalStatus: record?.status ?? null,
  }
}

/**
 * Spend a guest's cancellation token and cancel what it refers to.
 *
 * Two writes, one batch: the token is marked used on the thread and the
 * booking or reservation moves to cancelled. Cancelling the operational
 * record is what releases the seats — the thread holds none.
 */
export async function cancelBookingRequest(db: DbClient, input: {
  id: string; organizationId: string; kind: BookingRequest['kind']; now: string; env: CloudflareEnv
} & ({ tokenHash: string; buyerUserId?: never } | { buyerUserId: string; tokenHash?: never })): Promise<{ request: BookingRequest; record: ThreadOperationalRecord; wasConfirmed: boolean; changed: boolean } | null> {
  const current = await getGuestRequest(db, input.id, input.organizationId, input.kind)
  if (!current || current.kind === 'contact') return null
  const record = await getThreadOperationalRecord(db, current.id)
  if (!record || record.organization_id !== input.organizationId || record.kind !== current.kind) return null
  if (input.buyerUserId && (current.user_id !== input.buyerUserId || record.user_id !== input.buyerUserId)) return null
  async function readCancelled() {
    const request = await getGuestRequest(db, input.id, input.organizationId, input.kind)
    const cancelled = await getThreadOperationalRecord(db, input.id)
    if (!request || request.kind === 'contact' || !request.payload.cancellation.used_at || !cancelled || cancelled.status !== 'cancelled' || cancelled.organization_id !== input.organizationId || cancelled.kind !== request.kind) return null
    if (input.buyerUserId ? request.user_id !== input.buyerUserId || cancelled.user_id !== input.buyerUserId
      : request.payload.cancellation.token_hash !== input.tokenHash || !request.payload.cancellation.expires_at || request.payload.cancellation.expires_at <= input.now) return null
    const entry = await queryFirst<{ payload_json: string }>(db, 'SELECT payload_json FROM activity_entries WHERE request_id = ? AND dedupe_key = ?', [input.id, `${cancelled.kind}:${cancelled.id}:guest-cancel`])
    if (!entry) return null
    const before = JSON.parse(entry.payload_json).beforeStatus
    if (!['pending', 'confirmed'].includes(before)) throw new Error('Cancellation audit has no valid prior status')
    if (cancelled.kind === 'booking') await recordBookingCancelled(db, { organizationId: input.organizationId, bookingId: cancelled.id, cancelledBy: 'guest', actorUserId: input.buyerUserId ?? null })
    return { request, record: cancelled, wasConfirmed: before === 'confirmed', changed: false }
  }
  if (record.status === 'cancelled') return await readCancelled()
  if (!canCancelBookingRequest(record, input.now)) return null

  // Two writes, one batch, each carrying the other's condition: the token is
  // spent only while the record is still cancellable, and the record is
  // cancelled only where the token was spent. Separately, a record whose status
  // moved in between left the guest with a consumed token and a live booking
  // still holding its seats.
  const table = record.kind === 'booking' ? 'bookings' : 'reservations'
  const refund = record.kind === 'reservation' ? await guestReservationRefundQueries(db, {
    organizationId: input.organizationId, reservationId: record.id, requestId: input.id, startsAt: record.starts_at, now: input.now, buyerUserId: input.buyerUserId,
  }) : { queries: [], guard: null, refund: null }
  const [consumed, released] = await executeBatch(db, [
    {
      query: `UPDATE requests SET
          payload_json = json_set(payload_json, '$.cancellation.used_at', ?), updated_at = ?
        WHERE id = ? AND organization_id = ? AND kind = ?
          AND ${input.buyerUserId ? 'user_id = ?' : "json_extract(payload_json, '$.cancellation.token_hash') = ? AND json_extract(payload_json, '$.cancellation.expires_at') > ?"}
          AND json_extract(payload_json, '$.cancellation.used_at') IS NULL AND (${refund.guard?.query ?? '1=1'})
          AND EXISTS (SELECT 1 FROM ${table} WHERE id = ? AND organization_id = ? AND request_id = ? AND status = ?${input.buyerUserId ? ' AND user_id = ?' : ''}) RETURNING *`,
      params: [input.now, input.now, input.id, input.organizationId, input.kind, ...(input.buyerUserId ? [input.buyerUserId] : [input.tokenHash, input.now]), ...(refund.guard?.params ?? []), record.id, input.organizationId, input.id, record.status, ...(input.buyerUserId ? [input.buyerUserId] : [])],
    },
    {
      query: `UPDATE ${table} SET status = 'cancelled', cancelled_at = ?, cancellation_reason = 'guest_cancelled', updated_at = ?
        WHERE id = ? AND organization_id = ? AND request_id = ? AND status = ?${input.buyerUserId ? ' AND user_id = ?' : ''}
          AND EXISTS (SELECT 1 FROM requests WHERE id = ? AND organization_id = ?
            AND json_extract(payload_json, '$.cancellation.used_at') = ?)`,
      params: [input.now, input.now, record.id, input.organizationId, input.id, record.status, ...(input.buyerUserId ? [input.buyerUserId] : []), input.id, input.organizationId, input.now],
    },
    {
      query: `INSERT INTO activity_entries (id, request_id, kind, scope_kind, actor_kind, event_name, payload_json, dedupe_key, sequence, occurred_at, created_at)
        SELECT ?, ?, 'operation', 'request', 'guest', ?, ?, ?,
          COALESCE((SELECT MAX(sequence) FROM activity_entries WHERE request_id = ?), 0) + 1, ?, ?
        WHERE changes() = 1`,
      params: [crypto.randomUUID(), input.id, `${record.kind}.cancel`, JSON.stringify({ action: 'cancel', beforeStatus: record.status, afterStatus: 'cancelled', operational_booking_id: record.id, request_id: input.id, ...(input.buyerUserId ? { actor_user_id: input.buyerUserId } : {}) }), `${record.kind}:${record.id}:guest-cancel`, input.id, input.now, input.now],
    },
    ...refund.queries,
  ], { operation: 'Cancel booking request' })

  const row = (consumed?.results?.[0] ?? null) as Record<string, unknown> | null
  if (!row) return await readCancelled()
  if ((released?.meta?.changes ?? 0) !== 1) throw new Error('Cancellation consumed the token without releasing the booking')

  const request = parseGuestRequest(row)
  if (request.kind === 'contact') throw new Error('Cancellation returned a contact thread')
  if (record.kind === 'booking') await recordBookingCancelled(db, { organizationId: input.organizationId, bookingId: record.id, cancelledBy: 'guest', actorUserId: input.buyerUserId ?? null })
  // The deposit goes back the moment the table is released: Stripe's full-remaining refund, under the cancellation's own key.
  if (refund.refund) {
    if (!input.env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured')
    await executeRefund(db, createStripeClient(input.env.STRIPE_SECRET_KEY, 'payments'), await requirePayment(db, input.organizationId, refund.refund.paymentId), null, refund.refund.key, 'requested_by_customer', input.buyerUserId ?? null, input.env)
  }
  return { request, record: { ...record, status: 'cancelled' }, wasConfirmed: record.status === 'confirmed', changed: true }
}
