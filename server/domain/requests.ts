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
 * A stay thread is the conversation about a place-to-stay `stays` row, which
 * links back through `stays.request_id`; the stay owns its dates and guests.
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
  // A stay's guest may be reachable by phone alone; the database requires an email or a phone.
  threadScope.extend({ kind: z.literal('stay'), payload: z.union([
    z.object({ guest: guest.extend({ email: z.string().nullable() })
      .refine(contact => contact.email !== null || contact.phone !== null, 'A stay conversation needs the guest\'s email or phone') }).strict(),
    z.object({
      participant: z.object({ kind: z.literal('channel'), title: z.string().trim().min(1) }).strict(),
      guest: guest.extend({ name: z.string().nullable(), email: z.string().nullable() }),
    }).strict(),
  ]) }),
])
export type GuestRequest = z.infer<typeof guestRequestSchema>
export type BookingRequest = Extract<GuestRequest, { kind: 'reservation' | 'booking' }>
export type StayRequest = Extract<GuestRequest, { kind: 'stay' }>
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

/**
 * The operational record a thread links to, when it has one.
 *
 * A stay is whole nights, not an instant: its `starts_at` is its check-in date
 * at midnight UTC and its `ends_at` is midnight UTC two days after its
 * check-out date, the moment its thread leaves Current. That is after
 * check-out in every time zone, and SQL can say it without the home's clock.
 * Its dates are `check_in_date` and `check_out_date`; nothing formats
 * `starts_at` as a local time.
 */
export interface ThreadOperationalRecord {
  assigned_member_id: string | null
  kind: 'booking' | 'reservation' | 'stay'
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
  check_in_date: string | null
  check_out_date: string | null
}

/** A stay's thread instants, as described on ThreadOperationalRecord; `alias` is the stays row. */
export const STAY_THREAD_STARTS_SQL = (alias: string) => `${alias}.check_in_date || 'T00:00:00.000Z'`
export const STAY_THREAD_ENDS_SQL = (alias: string) => `date(${alias}.check_out_date, '+2 days') || 'T00:00:00.000Z'`

/** Whether the party size is a minimum ("4+"); only bookings and reservations say so. */
export function partySizeIsMinimum(request: GuestRequest): boolean {
  return (request.kind === 'booking' || request.kind === 'reservation') && request.payload.party_size_is_minimum
}

export function parseGuestRequest(row: Record<string, unknown>): GuestRequest {
  if (typeof row.payload_json !== 'string') throw new Error('Request payload is missing')
  return guestRequestSchema.parse({ ...row, payload: JSON.parse(row.payload_json) })
}

/** A provider's conversation title is a label, never a replacement guest identity. */
export function participantLabel(request: GuestRequest): string {
  if (request.kind === 'stay' && 'participant' in request.payload) return request.payload.participant.title
  if (request.payload.guest.name === null) throw new HTTPError({ statusCode: 500, message: 'A contact participant requires its recorded guest name', data: { code: 'REQUEST_PARTICIPANT_INVALID', field: 'guest.name' } })
  return request.payload.guest.name
}

/** Resource ownership belongs to the current request and every actual linked operational record. */
export const REQUEST_CURRENT_BUYER_SQL = `r.user_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.request_id=r.id AND (b.user_id IS NULL OR b.user_id<>r.user_id OR b.organization_id<>r.organization_id OR r.kind<>'booking'))
 AND NOT EXISTS(SELECT 1 FROM reservations v WHERE v.request_id=r.id AND (v.user_id IS NULL OR v.user_id<>r.user_id OR v.organization_id<>r.organization_id OR r.kind<>'reservation'))
 AND NOT EXISTS(SELECT 1 FROM stays st WHERE st.request_id=r.id AND (st.user_id IS NULL OR st.user_id<>r.user_id OR st.organization_id<>r.organization_id OR r.kind<>'stay'))`

export async function getGuestRequest(db: DbClient, id: string, organizationId?: string, kind?: GuestRequestKind, buyerUserId?:string): Promise<GuestRequest | null> {
  const row = await queryFirst<Record<string, unknown>>(db, `SELECT r.* FROM requests r WHERE r.id = ? AND r.kind IN ('contact', 'reservation', 'booking', 'stay')${organizationId ? ' AND r.organization_id = ?' : ''}${kind ? ' AND r.kind = ?' : ''}${buyerUserId?` AND r.user_id=? AND ${REQUEST_CURRENT_BUYER_SQL}`:''}`, [id, ...(organizationId ? [organizationId] : []), ...(kind ? [kind] : []),...(buyerUserId?[buyerUserId]:[])])
  if (!row) return null
  const request = parseGuestRequest(row)
  if (request.kind === 'stay' && 'participant' in request.payload) {
    const mapped = await queryFirst(db, `SELECT ct.request_id FROM channel_threads ct
      JOIN product_stay_configs c ON c.organization_id = ct.organization_id AND c.product_id = ct.product_id
      WHERE ct.request_id = ? AND ct.organization_id = ? AND c.location_id = ?`, [request.id, request.organization_id, request.location_id])
    if (!mapped) throw new HTTPError({ statusCode: 500, message: 'Channel conversation has no matching home mapping', data: { code: 'CHANNEL_THREAD_MAPPING_INVALID', field: 'request_id' } })
  }
  return request
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
           s.location_id, b.product_id, p.name AS product_name, b.assigned_member_id, b.organization_id, b.user_id,
           NULL AS check_in_date, NULL AS check_out_date
      FROM bookings b
      JOIN requests owner ON owner.id = b.request_id AND owner.kind = 'booking' AND owner.organization_id = b.organization_id
      JOIN product_sessions s ON s.id = b.product_session_id AND s.product_id = b.product_id AND s.organization_id = b.organization_id
      JOIN products p ON p.id = b.product_id AND p.organization_id = b.organization_id
     WHERE b.request_id = ?
    UNION ALL
    SELECT 'reservation', r.id, r.status, r.party_size, r.starts_at, r.ends_at, r.timezone,
           r.location_id, NULL, NULL, NULL, r.organization_id, r.user_id, NULL, NULL
      FROM reservations r
      JOIN requests owner ON owner.id = r.request_id AND owner.kind = 'reservation' AND owner.organization_id = r.organization_id
     WHERE r.request_id = ?
    UNION ALL
    SELECT 'stay', st.id, st.status, st.adults + st.children, ${STAY_THREAD_STARTS_SQL('st')}, ${STAY_THREAD_ENDS_SQL('st')}, l.timezone,
           c.location_id, st.product_id, p.name, c.assigned_member_id, st.organization_id, st.user_id, st.check_in_date, st.check_out_date
      FROM stays st
      JOIN requests owner ON owner.id = st.request_id AND owner.kind = 'stay' AND owner.organization_id = st.organization_id
      JOIN product_stay_configs c ON c.organization_id = st.organization_id AND c.product_id = st.product_id
      JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
      JOIN products p ON p.organization_id = st.organization_id AND p.id = st.product_id
     WHERE st.request_id = ?
     LIMIT 1
  `, [requestId, requestId, requestId])
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
  if (request?.kind === 'stay' && await queryFirst(db, 'SELECT request_id FROM channel_threads WHERE request_id = ?', [requestId])) return null
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
  const provenance = (request.kind === 'booking' || request.kind === 'reservation') && 'provenance' in request.payload ? request.payload.provenance : undefined
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

/**
 * The conversation about a stay, kept in the stay's own batch and read from the
 * stays row as committed, never from the caller: a write that lost its version
 * race opens nothing with details that were not saved.
 *
 * A stay whose guest has a name and an email or a phone opens a thread once; a
 * later write that brings one opens it then. The host who took the stay, or the
 * channel it came from, opens it. A thread already open takes the stay's current
 * guest and home location exactly for a host edit. A channel revision always
 * lands; when it no longer supplies a complete named contact, the conversation
 * retains its recorded participant as history. Reply routing reads the stay's
 * current contact, never that historical participant.
 */
/** A stay's conversation, opened by the host who entered it, the channel that sent it, or the guest who booked it on the site. */
export function stayThreadQueries(input: { organizationId: string; stayId: string; now: string; openedBy: { userId: string } | 'channel' | 'guest' }): BatchQuery[] {
  const id = crypto.randomUUID()
  const host = typeof input.openedBy === 'object' ? input.openedBy.userId : null
  const stay = `stays st JOIN product_stay_configs c ON c.organization_id = st.organization_id AND c.product_id = st.product_id
    WHERE st.id = ? AND st.organization_id = ?`
  const name = "trim(coalesce(st.guest_name, '') || ' ' || coalesce(st.guest_surname, ''))"
  // Blank contacts are absent; a complete participant has a name and at least one contact.
  const email = "nullif(trim(st.guest_email), '')"
  const phone = "nullif(trim(st.guest_phone), '')"
  const participant = `json_set(payload_json, '$.guest.name', ${name}, '$.guest.email', ${email}, '$.guest.phone', ${phone})`
  return [{
    query: `UPDATE requests SET location_id = c.location_id,
        payload_json = ${host ? participant : `CASE WHEN ${name} <> '' AND (${email} IS NOT NULL OR ${phone} IS NOT NULL) THEN ${participant} ELSE payload_json END`}
      FROM ${stay} AND requests.id = st.request_id AND requests.kind = 'stay'
        AND json_type(requests.payload_json, '$.participant') IS NULL`,
    params: [input.stayId, input.organizationId],
  }, {
    query: `UPDATE requests SET location_id = c.location_id,
        payload_json = json_set(payload_json, '$.guest.name', nullif(${name}, ''), '$.guest.email', ${email}, '$.guest.phone', ${phone})
      FROM ${stay} AND requests.id = st.request_id AND requests.kind = 'stay'
        AND json_extract(requests.payload_json, '$.participant.kind') = 'channel'
        AND EXISTS (SELECT 1 FROM channel_threads t WHERE t.request_id = requests.id AND t.organization_id = st.organization_id AND t.product_id = st.product_id)`,
    params: [input.stayId, input.organizationId],
  }, {
    // A booking the channel or the guest brought is new to the host; one the host took waits on its guest.
    // The conversation belongs to the stay's guest account when the guest booked it.
    query: `INSERT INTO requests (id, kind, organization_id, location_id, user_id, review_id, conversation_state, resolved_at, payload_json, created_at, updated_at)
      SELECT ?, 'stay', st.organization_id, c.location_id, st.user_id, NULL, ?, NULL,
        json_object('guest', json_object('name', ${name}, 'email', ${email}, 'phone', ${phone})), ?, ?
      FROM ${stay} AND st.request_id IS NULL AND st.owner = 'app' AND (${email} IS NOT NULL OR ${phone} IS NOT NULL) AND ${name} <> ''`,
    params: [id, host ? 'waiting_on_guest' : 'needs_attention', input.now, input.now, input.stayId, input.organizationId],
  }, {
    query: `INSERT INTO activity_entries (id, request_id, kind, scope_kind, actor_kind, actor_user_id, channel, payload_json, dedupe_key, sequence, occurred_at, created_at)
      SELECT ?, id, 'submission', 'request', ?, ?, 'system', json_object('kind', kind, 'stay_id', ?), ?, 1, created_at, created_at FROM requests WHERE id = ? AND changes() = 1`,
    params: [crypto.randomUUID(), host ? 'member' : input.openedBy === 'guest' ? 'guest' : 'system', host, input.stayId, `request:${id}:submission`, id],
  }, {
    query: 'UPDATE stays SET request_id = ? WHERE id = ? AND organization_id = ? AND request_id IS NULL AND EXISTS (SELECT 1 FROM requests WHERE id = ?)',
    params: [id, input.stayId, input.organizationId, id],
  }, publicResourceCacheInvalidationQuery(input.organizationId, 'guest-thread-create')]
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
  // A stay is changed and cancelled from its own screen; its thread is the conversation.
  if (record?.kind === 'stay' || !canCancelBookingRequest(record, now)) return []
  return record.kind === 'booking' && record.status === 'pending' ? ['confirm', 'reject', 'change', 'cancel'] : ['change', 'cancel']
}

export function canCancelBookingRequest(record: ThreadOperationalRecord | null, now: string): record is ThreadOperationalRecord {
  return Boolean(record && ['pending', 'confirmed'].includes(record.status) && record.ends_at > now && !isBookingComplete(record, now))
}

/** A stay's nights and party, in the stay's own dates: "Mar 3 – Mar 6 · 2 guests". */
export function stayPreview(record: { check_in_date: string; check_out_date: string; party_size: number }): string {
  const day = (date: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${date}T00:00:00Z`))
  return `${day(record.check_in_date)} – ${day(record.check_out_date)} · ${record.party_size} ${record.party_size === 1 ? 'guest' : 'guests'}`
}

export async function requestSummary(db: DbClient, request: GuestRequest, knownRecord?: ThreadOperationalRecord | null) {
  const record = knownRecord === undefined ? await getThreadOperationalRecord(db, request.id) : knownRecord
  // A thread without a location belongs to the business itself; one with a location must find it.
  const location = request.location_id === null ? null
    : await queryFirst<{ title: string }>(db, 'SELECT title FROM business_locations WHERE id = ? AND organization_id = ?', [request.location_id, request.organization_id])
  if (request.location_id !== null && !location) throw new HTTPError({ statusCode: 500, message: 'The conversation location does not exist', data: { code: 'INVALID_GUEST_THREAD', field: 'location_id', request_id: request.id } })
  return {
    guestName: request.payload.guest.name, participantLabel: participantLabel(request), guestEmail: request.payload.guest.email, guestPhone: request.payload.guest.phone,
    organizationId: request.organization_id, locationId: request.location_id,
    locationTitle: location?.title ?? null, productTitle: record?.product_name ?? null,
    createdAt: request.created_at,
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
  if (!current || current.kind === 'contact' || current.kind === 'stay') return null
  const record = await getThreadOperationalRecord(db, current.id)
  if (!record || record.organization_id !== input.organizationId || record.kind !== current.kind) return null
  if (input.buyerUserId && (current.user_id !== input.buyerUserId || record.user_id !== input.buyerUserId)) return null
  async function readCancelled(changed = false) {
    const request = await getGuestRequest(db, input.id, input.organizationId, input.kind)
    const cancelled = await getThreadOperationalRecord(db, input.id)
    if (!request || request.kind === 'contact' || request.kind === 'stay' || !request.payload.cancellation.used_at || !cancelled || cancelled.status !== 'cancelled' || cancelled.organization_id !== input.organizationId || cancelled.kind !== request.kind) return null
    if (input.buyerUserId ? request.user_id !== input.buyerUserId || cancelled.user_id !== input.buyerUserId
      : request.payload.cancellation.token_hash !== input.tokenHash || !request.payload.cancellation.expires_at || request.payload.cancellation.expires_at <= input.now) return null
    const entry = await queryFirst<{ payload_json: string }>(db, 'SELECT payload_json FROM activity_entries WHERE request_id = ? AND dedupe_key = ?', [input.id, `${cancelled.kind}:${cancelled.id}:guest-cancel`])
    if (!entry) return null
    const before = JSON.parse(entry.payload_json).beforeStatus
    if (!['pending', 'confirmed'].includes(before)) throw new Error('Cancellation audit has no valid prior status')
    if (cancelled.kind === 'booking') await recordBookingCancelled(db, { organizationId: input.organizationId, bookingId: cancelled.id, cancelledBy: 'guest', actorUserId: input.buyerUserId ?? null })
    if (cancelled.kind === 'reservation') {
      const refund = await queryFirst<{ payment_id: string; idempotency_key: string }>(db, `SELECT r.payment_id,r.idempotency_key FROM payment_refunds r
        JOIN payments p ON p.id=r.payment_id WHERE p.organization_id=? AND p.subject_type='reservation' AND p.subject_id=?
          AND r.idempotency_key='guest-cancelled-reservation:'||p.subject_id`, [input.organizationId, cancelled.id])
      if (refund) {
        if (!input.env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured')
        await executeRefund(db, createStripeClient(input.env.STRIPE_SECRET_KEY, 'payments'), await requirePayment(db, input.organizationId, refund.payment_id), null, refund.idempotency_key, 'requested_by_customer', input.buyerUserId ?? null, input.env)
      }
    }
    return { request, record: cancelled, wasConfirmed: before === 'confirmed', changed }
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
  }) : { queries: [], guard: null }
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

  return await readCancelled(true)
}
