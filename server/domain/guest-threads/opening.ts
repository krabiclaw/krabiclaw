import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { getThreadOperationalRecord } from '~/server/domain/requests'
import { formatFormAnswer, type FormAnswerSnapshot } from '~/shared/form-questions'
import { formatPhone } from '~/utils/phone'
import { normalizeVertical } from '~/utils/vertical-copy'
import type { ProductKind } from '~/shared/product-details'

/*
  How a booking (a table, a class, a consultation request) or a site stay opens its
  conversation (inbox-parity.md, Revision 2026-11-06): with real messages in
  the ledger, written with the record. First the booking's own message, a
  system message stating it in plain sentences; then the guest's note, when
  there is one, as the guest's own message. Every reader (the inbox, suggested
  replies, MCP, email threading) gets them like any other message, and nothing
  renders booking facts from submission fields. Airbnb stays open with
  Airbnb's own messages and get none of this.
*/

export const OPENING_EVENT = 'thread.opening'
export const GUEST_NOTE_EVENT = 'thread.guest_note'

export type OpeningFacts = {
  guestName: string
  guestPhone: string | null
  answers: readonly FormAnswerSnapshot[]
} & (
  | { kind: 'booking'; vertical: string; productKind: ProductKind; productTitle: string; partySize: number; partySizeIsMinimum: boolean; startsAt: string; timezone: string; placeTitle: string | null }
  | { kind: 'stay'; homeTitle: string; checkIn: string; checkOut: string; guests: number }
)

const LOCALE = 'en-US'
const when = (startsAt: string, timeZone: string) => {
  const at = new Date(startsAt)
  const day = new Intl.DateTimeFormat(LOCALE, { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(at)
  const time = new Intl.DateTimeFormat(LOCALE, { timeZone, hour: 'numeric', minute: '2-digit' }).format(at)
  return `${day} at ${time}`
}
const date = (value: string) => new Intl.DateTimeFormat(LOCALE, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${value}T00:00:00Z`))
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * The booking's own message: "Table for 4 on Tue, Nov 4 at 2:00 PM at
 * Kikuzuki. Filip Heurckmans, +32 475 69 94 44.", then each form answer on
 * its own line as the guest answered it.
 */
export function openingSentence(facts: OpeningFacts): string {
  const who = [facts.guestName, facts.guestPhone ? formatPhone(facts.guestPhone) : null].filter(Boolean).join(', ')
  const lead = facts.kind === 'booking'
    ? facts.productKind === 'table'
      ? `Table for ${facts.partySize}${facts.partySizeIsMinimum ? '+' : ''} on ${when(facts.startsAt, facts.timezone)}${facts.placeTitle ? ` at ${facts.placeTitle}` : ''}.`
      : normalizeVertical(facts.vertical) === 'service'
        ? `Consultation request: ${facts.productTitle} on ${when(facts.startsAt, facts.timezone)}${facts.placeTitle ? ` at ${facts.placeTitle}` : ''}.`
        : `${facts.productTitle} for ${count(facts.partySize, 'guest', 'guests')} on ${when(facts.startsAt, facts.timezone)}${facts.placeTitle ? ` at ${facts.placeTitle}` : ''}.`
      : `${facts.homeTitle} from ${date(facts.checkIn)} to ${date(facts.checkOut)} for ${count(facts.guests, 'guest', 'guests')}.`
  const answers = facts.answers.map(answer => `${answer.label} ${formatFormAnswer(answer, { yes: 'Yes', no: 'No' })}`)
  return [`${lead} ${who}.`, ...answers].join('\n')
}

/** Where the opening's own insert sits in `openingMessageQueries`. */
const OPENING_INSERT = 2

/**
 * The opening messages, placed directly after the thread's first entry (its
 * submission) in the ledger's sequence, which is the order every reader uses.
 * In the batch that writes the thread nothing follows that entry yet; a thread
 * written before them (the one-time backfill) has its later entries moved up to
 * make room, in two steps so `activity_entries_request_sequence_unique` holds
 * after each row. Everything is gated on the opening's dedupe key, so a replay
 * of the creation, or of the backfill, writes and moves nothing.
 */
export function openingMessageQueries(input: {
  /** The thread by its id, or a stay's thread when the batch that opens it chooses the id. */
  target: { requestId: string } | { stayId: string; organizationId: string }
  body: string; note: string | null; guestUserId: string | null; at: string
}): BatchQuery[] {
  const scope = 'requestId' in input.target
    ? { key: `request:${input.target.requestId}`, thread: '?', params: [input.target.requestId] }
    : { key: `stay:${input.target.stayId}`, thread: '(SELECT request_id FROM stays WHERE id = ? AND organization_id = ?)', params: [input.target.stayId, input.target.organizationId] }
  const note = input.note?.trim() ? input.note.trim() : null
  const room = note ? 2 : 1
  const openingKey = `${scope.key}:opening`
  const unwritten = 'NOT EXISTS (SELECT 1 FROM activity_entries WHERE dedupe_key = ?)'
  const first = `(SELECT MIN(sequence) FROM activity_entries WHERE request_id = ${scope.thread})`
  // Clear of any sequence a thread has, then back down by the room the messages take.
  const ASIDE = 1_000_000_000
  // The opening is written where its key is not; the note only where this batch
  // just wrote the opening, so a replay that read a different note moves nothing.
  const entry = (key: string, offset: number, actor: 'system' | 'guest', userId: string | null, body: string, eventName: string, gate: { sql: string; params: string[] }): BatchQuery => ({
    query: `INSERT INTO activity_entries (id, request_id, kind, scope_kind, actor_kind, actor_user_id, channel, body, event_name, payload_json, dedupe_key, sequence, occurred_at, created_at)
      SELECT ?, id, 'message', 'request', ?, ?, 'web', ?, ?, '{}', ?, ${first} + ${offset}, ?, ?
        FROM requests WHERE id = ${scope.thread} AND ${gate.sql}
      ON CONFLICT(dedupe_key) DO NOTHING`,
    params: [crypto.randomUUID(), actor, userId, body, eventName, key, ...scope.params, input.at, input.at, ...scope.params, ...gate.params],
  })
  return [
    // OPENING_INSERT counts these two.
    { query: `UPDATE activity_entries SET sequence = sequence + ${ASIDE}
        WHERE request_id = ${scope.thread} AND sequence > ${first} AND ${unwritten}`, params: [...scope.params, ...scope.params, openingKey] },
    { query: `UPDATE activity_entries SET sequence = sequence - ${ASIDE - room}
        WHERE request_id = ${scope.thread} AND sequence > ${ASIDE}`, params: scope.params },
    entry(openingKey, 1, 'system', null, input.body, OPENING_EVENT, { sql: unwritten, params: [openingKey] }),
    ...(note ? [entry(`${scope.key}:guest-note`, 2, 'guest', input.guestUserId, note, GUEST_NOTE_EVENT, { sql: 'changes() = 1', params: [] })] : []),
  ]
}

/**
 * Writes the opening messages once into booking and site-stay
 * conversations created before they were written with the record (51 of 84
 * reservation and booking threads on production opened empty on 2026-11-06).
 * They say what the guest booked when they booked it, from what was recorded
 * then: a stay's checkout purchase; otherwise the guest's submission with the
 * visit as it stood before its first change (that change's own `before`), or
 * as the record or, for a checkout never captured, its hold says when nothing
 * changed it. They are dated at the thread's creation and placed after its
 * submission. Airbnb stays are left alone, and a thread that already has its
 * opening is skipped by its dedupe key.
 */
export async function backfillOpeningMessages(db: DbClient, organizationId?: string): Promise<{ written: number; skipped: number }> {
  const threads = await queryAll<{ id: string; kind: 'booking' | 'stay'; organization_id: string; user_id: string | null; created_at: string; payload_json: string; vertical: string | null; checkout: string | null }>(db, `
    SELECT r.id, r.kind, r.organization_id, r.user_id, r.created_at, r.payload_json, o.vertical,
           (SELECT substr(s.idempotency_key, 10) FROM stays s WHERE s.request_id = r.id AND s.organization_id = r.organization_id) AS checkout
      FROM requests r JOIN organization o ON o.id = r.organization_id
     WHERE r.kind IN ('booking', 'stay') ${organizationId ? 'AND r.organization_id = ?' : ''}
       AND NOT EXISTS (SELECT 1 FROM activity_entries e WHERE e.request_id = r.id AND e.event_name = '${OPENING_EVENT}')
       AND (r.kind <> 'stay' OR EXISTS (SELECT 1 FROM stays s WHERE s.request_id = r.id AND s.organization_id = r.organization_id AND s.channel = 'direct' AND s.owner = 'app' AND s.idempotency_key LIKE 'checkout:%'))
     ORDER BY r.created_at, r.id`, organizationId ? [organizationId] : [])
  let written = 0, skipped = 0
  for (const thread of threads) {
    const opening = thread.kind === 'stay' ? await bookedStay(db, thread) : await bookedVisit(db, thread)
    const queries = openingMessageQueries({ target: { requestId: thread.id }, body: openingSentence(opening.facts), note: opening.note, guestUserId: thread.user_id, at: thread.created_at })
    const results = await executeBatch(db, queries, { operation: 'Backfill conversation opening' })
    // The opening's own insert, after the two moves that make room for it.
    if (Number(results[OPENING_INSERT]?.meta.changes ?? 0) === 1) written += 1
    else skipped += 1
  }
  return { written, skipped }
}

type BackfillThread = { id: string; kind: 'booking' | 'stay'; organization_id: string; payload_json: string; vertical: string | null; checkout: string | null }

/** A site stay as its checkout bought it: the purchase frozen on its payment. */
async function bookedStay(db: DbClient, thread: BackfillThread): Promise<{ facts: OpeningFacts; note: string | null }> {
  const payment = thread.checkout ? await queryFirst<{ price_snapshot_json: string }>(db, 'SELECT price_snapshot_json FROM payments WHERE id = ? AND organization_id = ?', [thread.checkout, thread.organization_id]) : null
  const snapshot: unknown = payment ? JSON.parse(payment.price_snapshot_json) : null
  const purchase = snapshot && typeof snapshot === 'object' && 'stay' in snapshot ? snapshot.stay : null
  // Loaded here: payments' checkout module reaches back into requests, which imports this one.
  const { isStayPurchase } = await import('~/server/domain/payments/checkout')
  if (!isStayPurchase(purchase)) throw new Error(`Site stay conversation ${thread.id} has no checkout purchase`)
  const home = await queryFirst<{ name: string }>(db, 'SELECT name FROM products WHERE id = ? AND organization_id = ?', [purchase.product_id, thread.organization_id])
  if (!home) throw new Error(`Site stay conversation ${thread.id} names a home that does not exist`)
  return {
    note: purchase.guest.notes,
    facts: { kind: 'stay', homeTitle: home.name, checkIn: purchase.check_in_date, checkOut: purchase.check_out_date, guests: purchase.adults + purchase.children,
      guestName: purchase.guest.name.trim(), guestPhone: purchase.guest.phone, answers: purchase.guest.answers ?? [] },
  }
}

/** The values a booking change records about the visit it changed, in either of the shapes it has been written in. */
type ChangedFrom = { startsAt?: string; starts_at?: string; partySize?: number; party_size?: number; partySizeIsMinimum?: boolean; timezone?: string; productId?: string | null; locationId?: string | null; notes?: string | null; guest?: { name?: string | null; phone?: string | null } }

type Visit = { startsAt: string; timezone: string; partySize: number; productId: string | null; locationId: string | null }

/**
 * The visit a changed thread was booked as: its first change's own record of
 * it, never the record a change has since rewritten. A change records the time
 * and party it replaced in every shape it has been written in; one that does not
 * cannot say what was booked, and refuses. The early accepted shape
 * (`starts_at`, `ends_at`, `party_size`, `assigned_member_id`, with the same keys
 * after) could move only the time and party, so the place, offering and zone are
 * the record's; every later shape records them itself.
 */
function askedBeforeChange(threadId: string, before: ChangedFrom, now: Visit): Visit {
  const startsAt = before.startsAt ?? before.starts_at
  const partySize = before.partySize ?? before.party_size
  if (typeof startsAt !== 'string' || typeof partySize !== 'number') throw new Error(`Conversation ${threadId} has a change that does not record the time and party it was booked with`)
  if (before.starts_at !== undefined) return { ...now, startsAt, partySize }
  if (typeof before.timezone !== 'string' || before.locationId === undefined || before.productId === undefined) throw new Error(`Conversation ${threadId} has a change that does not record the place it was booked at`)
  return { startsAt, partySize, timezone: before.timezone, productId: before.productId, locationId: before.locationId }
}

/** A booking as the guest asked for it. */
async function bookedVisit(db: DbClient, thread: BackfillThread): Promise<{ facts: OpeningFacts; note: string | null }> {
  const payload = JSON.parse(thread.payload_json) as { guest?: { name?: string | null; phone?: string | null }; notes?: string | null; answers?: FormAnswerSnapshot[]; party_size_is_minimum?: boolean }
  // A checkout never captured left no booking, and reading one for it refuses.
  const recorded = await queryFirst(db, 'SELECT 1 FROM bookings WHERE request_id = ? AND organization_id = ?', [thread.id, thread.organization_id])
  const record = recorded ? await getThreadOperationalRecord(db, thread.id) : null
  const hold = record ? null : await queryFirst<{ starts_at: string; timezone: string | null; quantity: number; product_id: string | null; location_id: string | null }>(db,
    'SELECT starts_at, timezone, quantity, product_id, location_id FROM payment_checkout_holds WHERE request_id = ? AND organization_id = ? ORDER BY created_at LIMIT 1', [thread.id, thread.organization_id])
  const now: Visit | null = record ? { startsAt: record.starts_at, timezone: record.timezone, partySize: record.party_size, productId: record.product_id, locationId: record.location_id }
    : hold?.timezone ? { startsAt: hold.starts_at, timezone: hold.timezone, partySize: hold.quantity, productId: hold.product_id, locationId: hold.location_id } : null
  if (!now) throw new Error(`Conversation ${thread.id} has neither its ${thread.kind} nor a checkout hold`)
  const first = await queryFirst<{ before: string }>(db, `SELECT json_extract(payload_json, '$.before') AS before FROM activity_entries
     WHERE request_id = ? AND event_name IN ('booking_change.requested', 'booking_change.moved', 'booking_change.accepted') AND json_type(payload_json, '$.before') = 'object'
     ORDER BY sequence LIMIT 1`, [thread.id])
  const before = first ? JSON.parse(first.before) as ChangedFrom : {}
  const asked = first ? askedBeforeChange(thread.id, before, now) : now
  const guestName = (before.guest?.name ?? payload.guest?.name)?.trim()
  if (!guestName) throw new Error(`Conversation ${thread.id} has no guest name`)
  const place = asked.locationId ? await queryFirst<{ title: string }>(db, 'SELECT title FROM business_locations WHERE id = ? AND organization_id = ?', [asked.locationId, thread.organization_id]) : null
  if (asked.locationId && !place) throw new Error(`Conversation ${thread.id} was booked at location ${asked.locationId}, which does not exist`)
  const common = { guestName, guestPhone: before.guest?.phone === undefined ? payload.guest?.phone ?? null : before.guest.phone, answers: payload.answers ?? [], startsAt: asked.startsAt, timezone: asked.timezone, partySize: asked.partySize }
  // The submission always records its note, null when the guest left none.
  const note = before.notes === undefined ? payload.notes : before.notes
  if (note === undefined) throw new Error(`Conversation ${thread.id} does not record the guest's note`)
  const product = asked.productId ? await queryFirst<{ name: string; kind: ProductKind }>(db, 'SELECT name, kind FROM products WHERE id = ? AND organization_id = ?', [asked.productId, thread.organization_id]) : null
  if (!thread.vertical || !product) throw new Error(`Booking conversation ${thread.id} has no vertical or product`)
  // A table's "4+" as asked. A change the guest accepted, or a move, sets the submission's flag
  // to false, so a changed table reads it from its first change's own record of it;
  // only one never changed still has it as submitted.
  const changed = product.kind === 'table' && await queryFirst(db, "SELECT 1 FROM activity_entries WHERE request_id = ? AND event_name IN ('booking_change.accepted', 'booking_change.moved')", [thread.id])
  const partySizeIsMinimum = changed ? before.partySizeIsMinimum : payload.party_size_is_minimum
  if (typeof partySizeIsMinimum !== 'boolean') throw new Error(`Booking conversation ${thread.id} does not record whether the party size it was booked with is a minimum`)
  return { note, facts: { kind: 'booking', ...common, vertical: thread.vertical, productKind: product.kind, productTitle: product.name, partySizeIsMinimum, placeTitle: place?.title ?? null } }
}
