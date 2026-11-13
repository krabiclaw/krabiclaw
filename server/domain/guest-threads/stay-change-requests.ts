import { HTTPError } from 'nitro'
import { z } from 'zod'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { bookingDay } from '~/server/domain/requests'
import type { CloudflareEnv } from '~/server/utils/auth'
import type { ChannexEnv } from '~/server/integrations/channex/client'
import { notifyBookingChangeOwner, stayParty } from '~/server/utils/notifications'
import { stayChangeDifferences } from '~/server/notifications/events'
import { getPersistedSourceLocale } from '~/server/utils/localization'
import { publishConversationEvent, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'
import { landBookingRevision, pendingBookingRevisions } from '~/server/integrations/channex/booking-revisions'
import { listAlterationRequests, readAlterationRequest, resolveAlterationRequest, type AlterationRequest } from '~/server/integrations/channex/live-feed'
import { describeErrorForTelemetry } from '~/shared/error-telemetry'
import { formatMinorAmount } from '~/shared/prices'
import { isCurrencyCode, type CurrencyCode } from '~/shared/currencies'
import { formatCalendarDate } from '~/utils/timezone'
import { appendMessage, conversationAccessSql, findMessageByDedupeKey, getMessage, type MessageRow } from '~/server/domain/conversations'
import { mirrorChannexThread } from './channel-messages'
import { conversationTaskQueries } from './repository'
import type { GuestThreadRow } from './types'

/**
 * An Airbnb guest's request to change their stay, as a booking change request
 * in the stay's conversation: the same `booking_change.requested` fact and
 * `booking-change-decision:` answer as a business's proposal, asked the other
 * way round. Channex's live feed event is the request (live-feed.ts); the host
 * answers it there, and the stay changes only when Airbnb's confirmed revision
 * lands through the booking revision path.
 */

const PREFIX = 'channex-alteration:'
const termsSchema = z.object({
  check_in_date: z.string(), check_out_date: z.string(), adults: z.number().int(), children: z.number().int(), infants: z.number().int(),
  total_minor: z.number().int(), currency: z.custom<CurrencyCode>(isCurrencyCode),
})
const proposalSchema = z.object({ source: z.literal('airbnb'), initiated_by: z.enum(['guest', 'host']), live_feed_event_id: z.string(), property_id: z.string(), booking_id: z.string(), stay_id: z.string(), before: termsSchema, after: termsSchema })
type Terms = z.infer<typeof termsSchema>
type Proposal = z.infer<typeof proposalSchema>
type Outcome = NonNullable<AlterationRequest['outcome']>
type AnswerEnv = ChannexEnv & GuestInboxPublicationEnv & CloudflareEnv

export function isStayChangeRequest(entry: Pick<MessageRow, 'event_name' | 'dedupe_key'>): boolean {
  return entry.event_name === 'booking_change.requested' && entry.dedupe_key.startsWith(PREFIX)
}

function nights(terms: Terms): number {
  return Math.round((Date.parse(`${terms.check_out_date}T00:00:00Z`) - Date.parse(`${terms.check_in_date}T00:00:00Z`)) / 86_400_000)
}

function nightsLabel(terms: Terms, locale: string): string {
  const day = (value: string) => formatCalendarDate(value, locale, { month: 'short', day: 'numeric', year: 'numeric' })
  return `${day(terms.check_in_date)} – ${day(terms.check_out_date)}`
}

/** How each outcome reads: answered by the host here, or on Airbnb, for a change the guest or the host asked for. */
const ANSWERS: Record<Outcome, { event: string; host: string; guest: string; airbnb: string }> = {
  accepted: { event: 'booking_change.accepted', host: 'Accepted the guest’s change on Airbnb.', guest: 'The guest’s change was accepted on Airbnb.', airbnb: 'The guest accepted the change on Airbnb.' },
  declined: { event: 'booking_change.declined', host: 'Declined the guest’s change on Airbnb.', guest: 'The guest’s change was declined on Airbnb.', airbnb: 'The guest declined the change on Airbnb.' },
  withdrawn: { event: 'booking_change.withdrawn', host: 'Withdrew the change on Airbnb.', guest: 'The guest withdrew the change on Airbnb.', airbnb: 'The change was withdrawn on Airbnb.' },
}

/** Airbnb's outcome, recorded once as the request's answer; a member is named only for the answer they chose. */
async function recordOutcome(db: DbClient, entry: MessageRow, proposal: Proposal, outcome: Outcome, actorUserId: string | null): Promise<MessageRow> {
  const answer = ANSWERS[outcome]
  return appendMessage(db, {
    conversationId: entry.conversation_id, authorKind: 'krabiclaw', authorUserId: actorUserId, channel: 'airbnb',
    eventName: answer.event, dedupeKey: `booking-change-decision:${entry.id}`,
    body: actorUserId ? answer.host : proposal.initiated_by === 'guest' ? answer.guest : answer.airbnb,
    payload: { requestId: entry.id, outcome },
  }, conversationTaskQueries(entry.conversation_id, new Date().toISOString()))
}

/** Whether the stay was written after an outcome was recorded: the accepted revision, or a later one. */
async function stayChangedSince(db: DbClient, proposal: Proposal, decision: MessageRow): Promise<boolean> {
  const stay = await queryFirst<{ updated_at: string }>(db, 'SELECT updated_at FROM bookings WHERE id = ?', [proposal.stay_id])
  if (!stay) throw new Error(`Stay ${proposal.stay_id} disappeared under its change request`)
  return stay.updated_at > decision.created_at
}

/** An accepted change arrives as the booking's next revision; land it if Channex already holds it. */
async function landAcceptedChange(db: DbClient, env: AnswerEnv, proposal: Proposal): Promise<void> {
  for (const revision of await pendingBookingRevisions(env, proposal.property_id, proposal.booking_id)) await landBookingRevision(db, env, revision)
}

async function alertOwners(db: DbClient, env: CloudflareEnv, thread: { id: string; organization_id: string; guest_name: string | null }, entry: MessageRow, proposal: Proposal, status: 'requested' | 'withdrawn') {
  if (!thread.guest_name) throw new Error(`Conversation ${thread.id} has no guest name to alert its owners with`)
  const home = await queryFirst<{ name: string; location_id: string; product_id: string; organization_name: string }>(db, `SELECT p.name, c.location_id, s.product_id, o.name AS organization_name
    FROM bookings s JOIN products p ON p.id = s.product_id AND p.organization_id = s.organization_id
    JOIN product_stay_configs c ON c.product_id = s.product_id AND c.organization_id = s.organization_id
    JOIN organization o ON o.id = s.organization_id WHERE s.id = ? AND s.organization_id = ?`, [proposal.stay_id, thread.organization_id])
  if (!home) throw new Error(`Stay ${proposal.stay_id} has no home to name in its change request alert`)
  const money = (minor: number) => formatMinorAmount(minor, proposal.after.currency, 'en-US')
  if (proposal.before.currency !== proposal.after.currency) throw new HTTPError({ statusCode: 409, message: `Airbnb change request ${proposal.live_feed_event_id} changes the stay's currency`, data: { code: 'CHANGE_REQUEST_CURRENCY_MISMATCH', field: 'bms.currency' } })
  const terms = (side: Terms) => ({
    date: nightsLabel(side, 'en'), time: null, nights: nights(side), location: home.name, assignee: null,
    partySize: stayParty(side),
    total: money(side.total_minor),
  })
  const counts = (side: Terms) => ({ checkIn: side.check_in_date, checkOut: side.check_out_date, guests: side.adults + side.children, infants: side.infants, totalMinor: side.total_minor })
  await notifyBookingChangeOwner(env, db, {
    organizationId: thread.organization_id, organizationName: home.organization_name, threadId: thread.id, submissionType: 'stay', submissionId: thread.id, bookingId: proposal.stay_id, messageId: entry.id,
    locationId: home.location_id, vertical: 'lodging', stay: { id: proposal.stay_id, product_id: home.product_id },
    change: {
      recordKind: 'stay', channel: 'Airbnb', guestName: thread.guest_name, requestedBy: { kind: 'guest' }, status, locationLabel: 'Home',
      current: terms(proposal.before), requested: terms(proposal.after),
      differences: stayChangeDifferences(counts(proposal.before), counts(proposal.after), money),
    },
  })
}

/**
 * Take one alteration request: record it on the stay's conversation and alert
 * the owners while it waits, or record how Airbnb resolved it. A request first
 * seen already resolved predates this conversation's knowledge of it and is
 * not recorded; a recorded one is reconciled.
 */
export async function takeAlterationRequest(db: DbClient, env: CloudflareEnv, request: AlterationRequest): Promise<'recorded' | 'reconciled' | 'unchanged' | 'ignored'> {
  const mapping = await queryFirst<{ organization_id: string; product_id: string; enabled: number }>(db,
    "SELECT organization_id, product_id, enabled FROM product_channel_mappings WHERE provider = 'channex' AND property_id = ?", [request.propertyId])
  if (!mapping || mapping.enabled !== 1) return 'ignored'
  const dedupeKey = `${PREFIX}${request.id}`
  let entry = await findMessageByDedupeKey(db, dedupeKey)
  if (!entry && request.outcome) return 'ignored'
  if (!entry) {
    type StayRow = Omit<Terms, 'check_in_date' | 'check_out_date'> & { id: string; conversation_id: string; guest_user_id: string | null; starts_at: string; ends_at: string; timezone: string; mirrored: number }
    const read = async (): Promise<(Terms & { id: string; conversation_id: string; guest_user_id: string | null; mirrored: boolean }) | null> => {
      const row = await queryFirst<StayRow>(db, `SELECT b.id, c.id AS conversation_id, c.user_id AS guest_user_id, b.starts_at, b.ends_at, b.timezone, b.adults, b.children, b.infants, b.total_minor, b.currency,
          EXISTS (SELECT 1 FROM channel_threads t WHERE t.conversation_id = c.id) AS mirrored
        FROM bookings b JOIN conversations c ON c.booking_id = b.id AND c.organization_id = b.organization_id AND c.kind = 'booking'
        WHERE b.provider = 'channex' AND b.external_booking_id = ? AND b.organization_id = ? AND b.product_id = ? AND b.product_session_id IS NULL`, [request.bookingId, mapping.organization_id, mapping.product_id])
      if (!row) return null
      const { starts_at, ends_at, timezone, mirrored, ...terms } = row
      return { ...terms, check_in_date: bookingDay(starts_at, timezone), check_out_date: bookingDay(ends_at, timezone), mirrored: mirrored === 1 }
    }
    let stay = await read()
    if (!stay) {
      for (const revision of await pendingBookingRevisions(env, request.propertyId, request.bookingId)) await landBookingRevision(db, env, revision)
      stay = await read()
    }
    if (!stay) throw new HTTPError({ statusCode: 409, message: `Airbnb change request ${request.id} names booking ${request.bookingId}, which Channex has not sent as a stay`, data: { code: 'CHANNEL_BOOKING_NOT_LANDED', field: 'bms.booking_id' } })
    // The booking's Airbnb conversation, mirrored from the thread the request names when it has not arrived yet.
    if (!stay.mirrored && request.messageThreadId) {
      await mirrorChannexThread(db, env, request.messageThreadId, request.propertyId)
      stay = await read()
    }
    if (!stay) throw new HTTPError({ statusCode: 409, message: `Airbnb change request ${request.id} names a stay that changed while its conversation was mirrored`, data: { code: 'CHANNEL_BOOKING_NOT_LANDED', field: 'bms.booking_id' } })
    const { id: stayId, conversation_id: threadId } = stay
    const before: Terms = { check_in_date: stay.check_in_date, check_out_date: stay.check_out_date, adults: stay.adults, children: stay.children, infants: stay.infants, total_minor: stay.total_minor, currency: stay.currency }
    const proposal: Proposal = { source: 'airbnb', initiated_by: request.initiatedBy, live_feed_event_id: request.id, property_id: request.propertyId, booking_id: request.bookingId, stay_id: stayId, before, after: request.after }
    const guest = request.initiatedBy === 'guest'
    // The guest's own request names their account; a host's proposal on Airbnb is KrabiClaw's to relay.
    entry = await appendMessage(db, {
      conversationId: threadId, authorKind: 'krabiclaw', authorUserId: guest ? stay.guest_user_id : null, channel: 'airbnb', eventName: 'booking_change.requested', dedupeKey,
      body: `${guest ? 'Asked' : 'Proposed'} on Airbnb to change the stay to ${nightsLabel(request.after, 'en')} for ${request.after.adults + request.after.children} guests (${formatMinorAmount(request.after.total_minor, request.after.currency, 'en-US')}).`,
      payload: proposal,
    }, conversationTaskQueries(threadId, new Date().toISOString()))
    await publishConversationEvent(env, db, { conversationId: threadId, type: 'MESSAGE_CREATE' })
  }
  const proposal = proposalSchema.parse(JSON.parse(entry.payload_json || '{}'))
  const thread = await queryFirst<{ id: string; organization_id: string; guest_name: string | null }>(db,
    "SELECT id, organization_id, json_extract(payload_json, '$.guest.name') AS guest_name FROM conversations WHERE id = ?", [entry.conversation_id])
  if (!thread) throw new Error(`Conversation ${entry.conversation_id} disappeared under its change request`)
  // Each owner alert is sent once: a run that recorded the fact but stopped before alerting alerts on the next one.
  const alerted = async (entryId: string) => Boolean(await queryFirst(db, "SELECT 1 FROM guest_thread_deliveries WHERE message_id = ? AND purpose = 'owner_alert'", [entryId]))
  let decision = await findMessageByDedupeKey(db, `booking-change-decision:${entry.id}`)
  const reconciled = !decision && request.outcome !== null
  if (!decision && request.outcome) {
    decision = await recordOutcome(db, entry, proposal, request.outcome, null)
  }
  if (decision) {
    // An accepted change lands as the booking's next revision. A run that
    // recorded the acceptance but stopped before landing it lands it now.
    if (decision.event_name === 'booking_change.accepted' && !await stayChangedSince(db, proposal, decision)) await landAcceptedChange(db, env, proposal)
    // A guest who withdraws on Airbnb leaves the owners nothing to answer; they
    // were asked, so they are told. An accepted change is told by its stay's
    // revision, and a host answers only here or on Airbnb themselves.
    if (decision.event_name === 'booking_change.withdrawn' && proposal.initiated_by === 'guest' && await alerted(entry.id) && !await alerted(decision.id)) {
      await alertOwners(db, env, thread, decision, proposal, 'withdrawn')
    }
    if (reconciled) await publishConversationEvent(env, db, { conversationId: thread.id, type: 'MESSAGE_CREATE', message: { id: decision.id, sequence: decision.sequence } })
    return reconciled ? 'reconciled' : 'unchanged'
  }
  // A change the host proposed on Airbnb waits on the guest there; nobody here is asked.
  if (proposal.initiated_by === 'host') return 'unchanged'
  if (await alerted(entry.id)) return 'unchanged'
  await alertOwners(db, env, thread, entry, proposal, 'requested')
  return 'recorded'
}

/**
 * Channex's alteration requests, for one property (a webhook's) or every one:
 * the backup for a webhook that never arrived, and the only way to learn that
 * a request was resolved on Airbnb. Every request is tried; the run fails
 * naming the ones that did not land.
 */
export async function runAlterationRequestFeed(db: DbClient, env: CloudflareEnv, propertyId?: string): Promise<{ recorded: number; reconciled: number }> {
  let recorded = 0
  let reconciled = 0
  const failures: string[] = []
  for (const request of await listAlterationRequests(env, propertyId)) {
    try {
      const outcome = await takeAlterationRequest(db, env, request)
      if (outcome === 'recorded') recorded += 1
      if (outcome === 'reconciled') reconciled += 1
    } catch (error) {
      failures.push(`${request.id}: ${describeErrorForTelemetry(error)}`)
    }
  }
  if (failures.length) throw new Error(`${failures.length} Airbnb change request(s) did not land: ${failures.join('; ')}`)
  return { recorded, reconciled }
}

/**
 * The host's answer. Channex is read first, since the guest may have
 * withdrawn on Airbnb; the answer recorded is the outcome Channex holds
 * afterwards, and an answer that differs from the host's is refused naming it.
 */
export async function respondToStayChangeRequest(db: DbClient, env: AnswerEnv, input: { thread: Pick<GuestThreadRow, 'id' | 'booking_id'>; requestId: string; decision: 'accept' | 'decline'; actorUserId: string }): Promise<void> {
  const entry = await getMessage(db, input.requestId)
  if (!entry || entry.conversation_id !== input.thread.id || !isStayChangeRequest(entry)) throw new HTTPError({ statusCode: 404, message: 'Change request not found', data: { code: 'CHANGE_REQUEST_NOT_FOUND', field: 'requestId' } })
  const proposal = proposalSchema.parse(JSON.parse(entry.payload_json || '{}'))
  if (proposal.stay_id !== input.thread.booking_id) throw new Error(`Change request ${entry.id} does not match its stay`)
  if (proposal.initiated_by === 'host') throw new HTTPError({ statusCode: 409, message: 'This change was proposed on Airbnb by the host; the guest answers it there.', data: { code: 'CHANGE_REQUEST_AWAITS_GUEST', field: 'requestId' } })
  const wanted: Outcome = input.decision === 'accept' ? 'accepted' : 'declined'
  let decision = await findMessageByDedupeKey(db, `booking-change-decision:${entry.id}`)
  if (!decision) {
    const current = await readAlterationRequest(env, proposal.live_feed_event_id)
    const answered = current.outcome ?? (await resolveAlterationRequest(env, current.id, input.decision)).outcome
    if (!answered) throw new HTTPError({ statusCode: 502, message: 'Channex accepted the answer but still lists the change request as waiting. Reload before answering again.', data: { code: 'CHANNEX_DECISION_NOT_RECORDED', field: 'resolution' } })
    decision = await recordOutcome(db, entry, proposal, answered, !current.outcome && answered === wanted ? input.actorUserId : null)
  }
  const { outcome } = z.object({ outcome: z.enum(['accepted', 'declined', 'withdrawn']) }).parse(JSON.parse(decision.payload_json || '{}'))
  try {
    if (outcome === 'accepted') await landAcceptedChange(db, env, proposal)
    await publishConversationEvent(env, db, { conversationId: entry.conversation_id, type: 'MESSAGE_CREATE', message: { id: decision.id, sequence: decision.sequence } })
  } catch (cause) {
    throw new HTTPError({
      statusCode: 503,
      message: `Airbnb recorded the change request as ${outcome}. Retry the update to finish syncing it.`,
      data: { code: 'STAY_CHANGE_INCOMPLETE', field: 'message_id', committed: true, message_id: entry.id, outcome },
      cause,
    })
  }
  if (outcome !== wanted) throw new HTTPError({ statusCode: 409, message: `This change request was already ${outcome} on Airbnb.`, data: { code: 'CHANGE_REQUEST_RESOLVED', field: 'decision', outcome } })
}

/** A channel decides when its request closes. Until its recorded answer arrives, show it on the authorized stay. */
export async function pendingStayChanges(db: DbClient, input: { bookingId: string; conversationId: string; organizationId: string; userId: string }) {
  const access = conversationAccessSql('c', input)
  const entries = await queryAll<Pick<MessageRow, 'id' | 'payload_json'>>(db, `SELECT proposal.id, proposal.payload_json
    FROM conversations c JOIN messages proposal ON proposal.conversation_id = c.id
    WHERE c.id = ? AND c.organization_id = ? AND c.booking_id = ? AND ${access.sql}
      AND proposal.event_name = 'booking_change.requested' AND proposal.dedupe_key GLOB ?
      AND NOT EXISTS (SELECT 1 FROM messages decision WHERE decision.conversation_id = c.id AND decision.dedupe_key = 'booking-change-decision:' || proposal.id)
    ORDER BY proposal.sequence DESC`, [input.conversationId, input.organizationId, input.bookingId, ...access.params, `${PREFIX}*`])
  if (!entries.length) return []
  const { locale } = await getPersistedSourceLocale(db, input.organizationId)
  const side = (terms: Terms) => ({ dates: nightsLabel(terms, locale), guests: terms.adults + terms.children, total: formatMinorAmount(terms.total_minor, terms.currency, locale) })
  return entries.map(entry => {
    const proposal = proposalSchema.parse(JSON.parse(entry.payload_json || '{}'))
    if (proposal.stay_id !== input.bookingId) throw new Error(`Change request ${entry.id} does not match its stay`)
    return { id: entry.id, requested_by: proposal.initiated_by, before: side(proposal.before), after: side(proposal.after) }
  })
}
