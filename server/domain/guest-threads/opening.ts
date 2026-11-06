import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { getThreadOperationalRecord } from '~/server/domain/requests'
import { formatFormAnswer, type FormAnswerSnapshot } from '~/shared/form-questions'
import { formatPhone } from '~/utils/phone'
import { normalizeVertical } from '~/utils/vertical-copy'

/*
  How a reservation, booking, consultation request or site stay opens its
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
  | { kind: 'reservation'; partySize: number; partySizeIsMinimum: boolean; startsAt: string; timezone: string; placeTitle: string }
  | { kind: 'booking'; vertical: string; productTitle: string; partySize: number; startsAt: string; timezone: string; placeTitle: string | null }
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
  const lead = facts.kind === 'reservation'
    ? `Table for ${facts.partySize}${facts.partySizeIsMinimum ? '+' : ''} on ${when(facts.startsAt, facts.timezone)} at ${facts.placeTitle}.`
    : facts.kind === 'booking'
      ? normalizeVertical(facts.vertical) === 'service'
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
  const entry = (key: string, offset: number, actor: 'system' | 'guest', userId: string | null, body: string, eventName: string): BatchQuery => ({
    query: `INSERT INTO activity_entries (id, request_id, kind, scope_kind, actor_kind, actor_user_id, channel, body, event_name, payload_json, dedupe_key, sequence, occurred_at, created_at)
      SELECT ?, id, 'message', 'request', ?, ?, 'web', ?, ?, '{}', ?, ${first} + ${offset}, ?, ?
        FROM requests WHERE id = ${scope.thread} AND ${unwritten}
      ON CONFLICT(dedupe_key) DO NOTHING`,
    params: [crypto.randomUUID(), actor, userId, body, eventName, key, ...scope.params, input.at, input.at, ...scope.params, key],
  })
  return [
    // OPENING_INSERT counts these two.
    { query: `UPDATE activity_entries SET sequence = sequence + ${ASIDE}
        WHERE request_id = ${scope.thread} AND sequence > ${first} AND ${unwritten}`, params: [...scope.params, ...scope.params, openingKey] },
    { query: `UPDATE activity_entries SET sequence = sequence - ${ASIDE - room}
        WHERE request_id = ${scope.thread} AND sequence > ${ASIDE}`, params: scope.params },
    entry(openingKey, 1, 'system', null, input.body, OPENING_EVENT),
    ...(note ? [entry(`${scope.key}:guest-note`, 2, 'guest', input.guestUserId, note, GUEST_NOTE_EVENT)] : []),
  ]
}

/**
 * Writes the opening messages once into reservation, booking and site-stay
 * conversations created before they were written with the record (51 of 84
 * reservation and booking threads on production opened empty on 2026-11-06).
 * The facts come from the record and the guest's submission, the same
 * `openingSentence` creation uses; the messages are dated at the thread's
 * creation and placed after its submission, before everything said since.
 * Airbnb stays are left alone, and a thread that already has its opening is
 * skipped by its dedupe key.
 */
export async function backfillOpeningMessages(db: DbClient, organizationId?: string): Promise<{ written: number; skipped: number }> {
  const threads = await queryAll<{ id: string; kind: 'reservation' | 'booking' | 'stay'; organization_id: string; location_id: string | null; user_id: string | null; created_at: string; payload_json: string; vertical: string | null; location_title: string | null }>(db, `
    SELECT r.id, r.kind, r.organization_id, r.location_id, r.user_id, r.created_at, r.payload_json, o.vertical, l.title AS location_title
      FROM requests r JOIN organization o ON o.id = r.organization_id
      LEFT JOIN business_locations l ON l.id = r.location_id AND l.organization_id = r.organization_id
     WHERE r.kind IN ('reservation', 'booking', 'stay') ${organizationId ? 'AND r.organization_id = ?' : ''}
       AND NOT EXISTS (SELECT 1 FROM activity_entries e WHERE e.request_id = r.id AND e.event_name = '${OPENING_EVENT}')
       AND (r.kind <> 'stay' OR EXISTS (SELECT 1 FROM stays s WHERE s.request_id = r.id AND s.organization_id = r.organization_id AND s.channel = 'direct' AND s.owner = 'app' AND s.idempotency_key LIKE 'checkout:%'))
     ORDER BY r.created_at, r.id`, organizationId ? [organizationId] : [])
  let written = 0, skipped = 0
  for (const thread of threads) {
    const record = await getThreadOperationalRecord(db, thread.id)
    if (!record) { skipped += 1; continue }
    const payload = JSON.parse(thread.payload_json) as { guest?: { name?: string | null; phone?: string | null }; notes?: string | null; answers?: FormAnswerSnapshot[]; party_size_is_minimum?: boolean }
    let facts: OpeningFacts
    let note: string | null = payload.notes ?? null
    if (thread.kind === 'stay') {
      const stay = await queryFirst<{ guest_name: string | null; guest_surname: string | null; guest_phone: string | null; notes: string | null; answers: string; adults: number; children: number; check_in_date: string; check_out_date: string; home: string }>(db,
        'SELECT s.guest_name, s.guest_surname, s.guest_phone, s.notes, s.answers, s.adults, s.children, s.check_in_date, s.check_out_date, p.name AS home FROM stays s JOIN products p ON p.id = s.product_id AND p.organization_id = s.organization_id WHERE s.request_id = ? AND s.organization_id = ?',
        [thread.id, thread.organization_id])
      if (!stay) throw new Error(`Site stay conversation ${thread.id} has no stay`)
      const guestName = [stay.guest_name, stay.guest_surname].filter(Boolean).join(' ').trim()
      if (!guestName) throw new Error(`Site stay conversation ${thread.id} has no guest name`)
      note = stay.notes
      facts = { kind: 'stay', homeTitle: stay.home, checkIn: stay.check_in_date, checkOut: stay.check_out_date, guests: stay.adults + stay.children,
        guestName, guestPhone: stay.guest_phone, answers: JSON.parse(stay.answers) as FormAnswerSnapshot[] }
    } else {
      const guestName = payload.guest?.name?.trim()
      if (!guestName) throw new Error(`Conversation ${thread.id} has no guest name`)
      const common = { guestName, guestPhone: payload.guest?.phone ?? null, answers: payload.answers ?? [], startsAt: record.starts_at, timezone: record.timezone }
      if (thread.kind === 'reservation') {
        if (!thread.location_title) throw new Error(`Reservation conversation ${thread.id} has no location`)
        facts = { kind: 'reservation', ...common, partySize: record.party_size, partySizeIsMinimum: payload.party_size_is_minimum === true, placeTitle: thread.location_title }
      } else {
        if (!thread.vertical || !record.product_name) throw new Error(`Booking conversation ${thread.id} has no vertical or product`)
        facts = { kind: 'booking', ...common, vertical: thread.vertical, productTitle: record.product_name, partySize: record.party_size, placeTitle: thread.location_title }
      }
    }
    const queries = openingMessageQueries({ target: { requestId: thread.id }, body: openingSentence(facts), note, guestUserId: thread.user_id, at: thread.created_at })
    const results = await executeBatch(db, queries, { operation: 'Backfill conversation opening' })
    // The opening's own insert, after the two moves that make room for it.
    if (Number(results[OPENING_INSERT]?.meta.changes ?? 0) === 1) written += 1
    else skipped += 1
  }
  return { written, skipped }
}
