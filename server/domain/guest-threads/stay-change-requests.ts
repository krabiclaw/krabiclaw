import { HTTPError } from 'nitro'
import { z } from 'zod'
import { queryFirst, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import type { ChannexEnv } from '~/server/integrations/channex/client'
import { notifyBookingChangeOwner } from '~/server/utils/notifications'
import { getPersistedSourceLocale } from '~/server/utils/localization'
import { publishGuestInboxThreadEvent, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'
import { landBookingRevision, pendingBookingRevisions } from '~/server/integrations/channex/booking-revisions'
import { listAlterationRequests, readAlterationRequest, resolveAlterationRequest, type AlterationRequest } from '~/server/integrations/channex/live-feed'
import { describeErrorForTelemetry } from '~/shared/error-telemetry'
import { formatMinorAmount } from '~/shared/prices'
import { isCurrencyCode, type CurrencyCode } from '~/shared/currencies'
import { formatCalendarDate } from '~/utils/timezone'
import { appendEntry, findEntryByDedupeKey, getEntryById } from './entries'
import { mirrorChannexThread } from './channel-messages'
import { updateThreadProjectionIfLatestEntry } from './repository'
import type { BookingChangeStatus } from './booking-change-state'
import type { BookingChangeView } from './booking-changes'
import type { GuestThreadEntryRow, GuestThreadRow } from './types'

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
type AnswerEnv = ChannexEnv & GuestInboxPublicationEnv

export function isStayChangeRequest(entry: Pick<GuestThreadEntryRow, 'event_name' | 'dedupe_key'>): boolean {
  return entry.event_name === 'booking_change.requested' && entry.dedupe_key.startsWith(PREFIX)
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
async function recordOutcome(db: DbClient, env: AnswerEnv, entry: GuestThreadEntryRow, proposal: Proposal, outcome: Outcome, actorUserId: string | null): Promise<void> {
  const answer = ANSWERS[outcome]
  const decision = await appendEntry(db, {
    threadId: entry.request_id, kind: 'operation', actorKind: actorUserId ? 'member' : 'system', actorUserId, channel: 'airbnb',
    eventName: answer.event, dedupeKey: `booking-change-decision:${entry.id}`,
    body: actorUserId ? answer.host : proposal.initiated_by === 'guest' ? answer.guest : answer.airbnb,
    payloadJson: { requestId: entry.id, outcome },
  })
  await updateThreadProjectionIfLatestEntry(db, entry.request_id, decision.id, { conversationState: 'resolved' })
  await publishGuestInboxThreadEvent(env, db, { threadId: entry.request_id, type: 'thread.changed' })
}

/** An accepted change arrives as the booking's next revision; land it if Channex already holds it. */
async function landAcceptedChange(db: DbClient, env: AnswerEnv, proposal: Proposal): Promise<void> {
  for (const revision of await pendingBookingRevisions(env, proposal.property_id, proposal.booking_id)) await landBookingRevision(db, env, revision)
}

async function alertOwners(db: DbClient, env: CloudflareEnv, thread: { id: string; organization_id: string; guest_name: string | null }, entry: GuestThreadEntryRow, proposal: Proposal) {
  if (!thread.guest_name) throw new Error(`Conversation ${thread.id} has no guest name to alert its owners with`)
  const home = await queryFirst<{ name: string; location_id: string; assigned_member_id: string | null; organization_name: string }>(db, `SELECT p.name, c.location_id, c.assigned_member_id, o.name AS organization_name
    FROM stays s JOIN products p ON p.id = s.product_id AND p.organization_id = s.organization_id
    JOIN product_stay_configs c ON c.product_id = s.product_id AND c.organization_id = s.organization_id
    JOIN organization o ON o.id = s.organization_id WHERE s.id = ? AND s.organization_id = ?`, [proposal.stay_id, thread.organization_id])
  if (!home) throw new Error(`Stay ${proposal.stay_id} has no home to name in its change request alert`)
  await notifyBookingChangeOwner(env, db, {
    organizationId: thread.organization_id, organizationName: home.organization_name, threadId: thread.id, submissionType: 'stay', submissionId: thread.id, sourceEntryId: entry.id,
    guestName: thread.guest_name, status: 'requested', requestedBy: 'guest', noun: 'stay', locationId: home.location_id, locationTitle: home.name,
    memberIds: home.assigned_member_id ? [home.assigned_member_id] : [],
    whenLabel: nightsLabel(proposal.after, 'en'), whenDate: null, whenTime: null, guests: proposal.after.adults + proposal.after.children,
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
  let entry = await findEntryByDedupeKey(db, dedupeKey)
  if (!entry && request.outcome) return 'ignored'
  if (!entry) {
    type StayRow = Terms & { id: string; request_id: string | null }
    const read = () => queryFirst<StayRow>(db, `SELECT id, request_id, check_in_date, check_out_date, adults, children, infants, total_minor, currency
      FROM stays WHERE provider = 'channex' AND external_booking_id = ? AND organization_id = ? AND product_id = ?`, [request.bookingId, mapping.organization_id, mapping.product_id])
    let stay = await read()
    if (!stay) {
      for (const revision of await pendingBookingRevisions(env, request.propertyId, request.bookingId)) await landBookingRevision(db, env, revision)
      stay = await read()
    }
    if (!stay) throw new HTTPError({ statusCode: 409, message: `Airbnb change request ${request.id} names booking ${request.bookingId}, which Channex has not sent as a stay`, data: { code: 'CHANNEL_BOOKING_NOT_LANDED', field: 'bms.booking_id' } })
    // The booking's conversation, mirrored from the thread the request names when it has not arrived yet.
    if (!stay.request_id && request.messageThreadId) {
      await mirrorChannexThread(db, env, request.messageThreadId, request.propertyId)
      stay = await read()
    }
    if (!stay?.request_id) throw new HTTPError({ statusCode: 409, message: `Airbnb change request ${request.id} is for a stay whose Airbnb conversation has not arrived yet`, data: { code: 'STAY_CONVERSATION_MISSING', field: 'request_id' } })
    const { id: stayId, request_id: threadId, ...before } = stay
    const proposal: Proposal = { source: 'airbnb', initiated_by: request.initiatedBy, live_feed_event_id: request.id, property_id: request.propertyId, booking_id: request.bookingId, stay_id: stayId, before, after: request.after }
    const guest = request.initiatedBy === 'guest'
    entry = await appendEntry(db, {
      threadId, kind: 'operation', actorKind: guest ? 'guest' : 'system', channel: 'airbnb', eventName: 'booking_change.requested', dedupeKey,
      body: `${guest ? 'Asked' : 'Proposed'} on Airbnb to change the stay to ${nightsLabel(request.after, 'en')} for ${request.after.adults + request.after.children} guests (${formatMinorAmount(request.after.total_minor, request.after.currency, 'en-US')}).`,
      payloadJson: proposal,
    })
    await updateThreadProjectionIfLatestEntry(db, threadId, entry.id, { conversationState: guest ? 'needs_attention' : 'waiting_on_guest' })
    await publishGuestInboxThreadEvent(env, db, { threadId, type: 'thread.changed' })
  }
  if (await findEntryByDedupeKey(db, `booking-change-decision:${entry.id}`)) return 'unchanged'
  const proposal = proposalSchema.parse(JSON.parse(entry.payload_json || '{}'))
  if (request.outcome) {
    await recordOutcome(db, env, entry, proposal, request.outcome, null)
    if (request.outcome === 'accepted') await landAcceptedChange(db, env, proposal)
    return 'reconciled'
  }
  // A change the host proposed on Airbnb waits on the guest there; nobody here is asked.
  if (proposal.initiated_by === 'host') return 'unchanged'
  const thread = await queryFirst<{ id: string; organization_id: string; guest_name: string | null }>(db,
    "SELECT id, organization_id, json_extract(payload_json, '$.guest.name') AS guest_name FROM requests WHERE id = ?", [entry.request_id])
  if (!thread) throw new Error(`Conversation ${entry.request_id} disappeared under its change request`)
  // Alerted once: a run that recorded the request but stopped before alerting alerts on the next one.
  if (await queryFirst(db, "SELECT 1 FROM guest_thread_deliveries WHERE entry_id = ? AND purpose = 'owner_alert'", [entry.id])) return 'unchanged'
  await alertOwners(db, env, thread, entry, proposal)
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
export async function respondToStayChangeRequest(db: DbClient, env: AnswerEnv, input: { thread: GuestThreadRow; requestId: string; decision: 'accept' | 'decline'; actorUserId: string }): Promise<void> {
  const entry = await getEntryById(db, input.requestId)
  if (!entry || entry.request_id !== input.thread.id || !isStayChangeRequest(entry)) throw new HTTPError({ statusCode: 404, message: 'Change request not found', data: { code: 'CHANGE_REQUEST_NOT_FOUND', field: 'requestId' } })
  const proposal = proposalSchema.parse(JSON.parse(entry.payload_json || '{}'))
  if (proposal.initiated_by === 'host') throw new HTTPError({ statusCode: 409, message: 'This change was proposed on Airbnb by the host; the guest answers it there.', data: { code: 'CHANGE_REQUEST_AWAITS_GUEST', field: 'requestId' } })
  const wanted: Outcome = input.decision === 'accept' ? 'accepted' : 'declined'
  let decision = await findEntryByDedupeKey(db, `booking-change-decision:${entry.id}`)
  if (!decision) {
    const current = await readAlterationRequest(env, proposal.live_feed_event_id)
    const answered = current.outcome ?? (await resolveAlterationRequest(env, current.id, input.decision)).outcome
    if (!answered) throw new HTTPError({ statusCode: 502, message: 'Channex accepted the answer but still lists the change request as waiting. Reload before answering again.', data: { code: 'CHANNEX_DECISION_NOT_RECORDED', field: 'resolution' } })
    await recordOutcome(db, env, entry, proposal, answered, !current.outcome && answered === wanted ? input.actorUserId : null)
    decision = await findEntryByDedupeKey(db, `booking-change-decision:${entry.id}`)
  }
  const outcome = (decision ? JSON.parse(decision.payload_json || '{}') as { outcome?: Outcome } : {}).outcome
  if (outcome === 'accepted') await landAcceptedChange(db, env, proposal)
  if (outcome !== wanted) throw new HTTPError({ statusCode: 409, message: `This change request was already ${outcome} on Airbnb.`, data: { code: 'CHANGE_REQUEST_RESOLVED', field: 'decision', outcome } })
}

/** The conversation's view of each request: before and after, and the answer Airbnb holds. */
export async function stayChangeView(db: DbClient, thread: GuestThreadRow, entry: GuestThreadEntryRow, status: BookingChangeStatus): Promise<BookingChangeView> {
  const proposal = proposalSchema.parse(JSON.parse(entry.payload_json || '{}'))
  const organization = await queryFirst<{ vertical: string | null }>(db, 'SELECT vertical FROM organization WHERE id = ?', [thread.organization_id])
  const home = await queryFirst<{ name: string }>(db, 'SELECT p.name FROM stays s JOIN products p ON p.id = s.product_id AND p.organization_id = s.organization_id WHERE s.id = ? AND s.organization_id = ?', [proposal.stay_id, thread.organization_id])
  if (!organization || !home) throw new Error(`Change request ${entry.id} has no organization or home to show`)
  if (!thread.payload.guest.name) throw new Error(`Change request ${entry.id} is in a conversation with no guest name`)
  const { locale } = await getPersistedSourceLocale(db, thread.organization_id)
  const side = (terms: Terms) => ({ whenLabel: nightsLabel(terms, locale), partySize: terms.adults + terms.children, totalLabel: formatMinorAmount(terms.total_minor, terms.currency, locale), assignedMemberId: null, assignedMemberName: null })
  return {
    type: thread.kind, noun: 'stay', guestName: thread.payload.guest.name, locale, vertical: organization.vertical, requestedBy: proposal.initiated_by === 'guest' ? 'guest' : 'business', channel: 'airbnb',
    before: side(proposal.before), after: side(proposal.after), locationTitle: home.name, originalLocationTitle: home.name, status,
  }
}
