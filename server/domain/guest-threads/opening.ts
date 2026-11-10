import type { BatchQuery } from '~/server/db'
import { GUEST_NOTE_EVENT, OPENING_EVENT, messageQueries } from '~/server/domain/conversations'
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

export { OPENING_EVENT, GUEST_NOTE_EVENT }

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

/**
 * The opening messages, written with the record: KrabiClaw's sentence for the
 * booking, by whoever made it (the guest, or the host who took it), then the
 * guest's note as their own message. Gated on the opening's dedupe key, so a
 * replay of the creation writes nothing.
 */
export function openingMessageQueries(input: {
  conversationId: string
  body: string; note: string | null; guestUserId: string | null; openedByUserId: string | null; at: string
}): BatchQuery[] {
  const note = input.note?.trim() ? input.note.trim() : null
  const openingKey = `conversation:${input.conversationId}:opening`
  return [
    ...messageQueries({ conversationId: input.conversationId, authorKind: 'krabiclaw', authorUserId: input.openedByUserId, channel: 'web',
      body: input.body, eventName: OPENING_EVENT, dedupeKey: openingKey, occurredAt: input.at }).queries,
    ...(note ? messageQueries({ conversationId: input.conversationId, authorKind: 'guest', authorUserId: input.guestUserId, channel: 'web',
      body: note, eventName: GUEST_NOTE_EVENT, dedupeKey: `conversation:${input.conversationId}:guest-note`, occurredAt: input.at }).queries : []),
  ]
}
