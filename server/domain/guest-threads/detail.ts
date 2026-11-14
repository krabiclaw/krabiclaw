import { buyerRequestActivityPath } from '~/server/domain/payments/buyer'
import { accountActivityPath } from '~/shared/account-activity'
import { queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { bookingDay, getThreadOperationalRecord, requestSummary, requestLocationQuery, validateGuestRequest, type GuestRequest, type RequestLocation, type ThreadOperationalRecord } from '~/server/domain/requests'
import { MIRRORED_EVENT, OPENING_EVENT, SCHEDULED_MESSAGE_EVENT, SUBMISSION_EVENT, SUPPORT_CONVERSATION_SQL, isEventMessage, messageHasContentSql, messageRole, parseMessagePayload, type ConversationRow, type ConversationWindow, type MessageRow } from '~/server/domain/conversations'
import { readConversationHistory, type ConversationHistory } from '~/server/domain/conversation-history-data'
import { readConversationEnrichment } from './deliveries'
import type { GuestThreadEntryViewModel } from './types'
import { HTTPError } from 'nitro'
import { providerTimestamp } from '~/server/integrations/channex/messages'
import { guestThreadChannelQuery, parseGuestThreadChannel, type GuestThreadChannelRow } from './channel-messages'
import { formAnswerSnapshotsSchema, type FormAnswerSnapshot } from '~/shared/form-questions'

/** What the guest answered when they wrote in or booked: on a contact's thread, or on the booking the thread is about (none before a checkout's payment makes it). */
async function threadAnswers(db: DbClient, thread: GuestRequest): Promise<FormAnswerSnapshot[]> {
  if (thread.kind === 'contact') return thread.payload.answers
  if (!thread.booking_id) return []
  const booking = await queryFirst<{ answers: string }>(db, 'SELECT answers FROM bookings WHERE organization_id = ? AND id = ?', [thread.organization_id, thread.booking_id])
  return booking ? formAnswerSnapshotsSchema.parse(JSON.parse(booking.answers)) : []
}

export interface TranscriptView {
  id: string
  organizationName: string
  organizationVertical: string
  activityPath: string | null
  guestName: string | null
  participantLabel: string
  conversationChannel: 'airbnb' | 'direct'
  locationLabel: string | null
  operationalRecord: (Pick<ThreadOperationalRecord, 'id' | 'unit' | 'product_kind' | 'status' | 'starts_at' | 'ends_at' | 'timezone' | 'party_size'> & { check_in_date: string | null; check_out_date: string | null }) | null
  entries: GuestThreadEntryViewModel[]
  inquiry: { checkIn: string; checkOut: string } | null
  answers: FormAnswerSnapshot[]
  window?: TranscriptWindow
  automaticOwner: string | null
  templateTitles: Map<string, string>
}

interface TranscriptWindow {
  support: boolean
  channelGuestName: string | null
}

type ThreadOrganization = { name: string; vertical: string; timezone: string }
const THREAD_ORGANIZATION_SQL = 'SELECT name, vertical, timezone FROM organization WHERE id = ?'
const channelGuestNameSql = (conversationId: string) => `SELECT trim(json_extract(m.payload_json, '$.meta.name')) FROM messages m
  WHERE m.conversation_id = ${conversationId} AND m.author_kind = 'guest' AND m.event_name = '${MIRRORED_EVENT}'
    AND json_type(m.payload_json, '$.meta.name') = 'text' AND trim(json_extract(m.payload_json, '$.meta.name')) <> ''
  ORDER BY m.sequence DESC LIMIT 1`
export type ThreadWideFacts = { support: number; channel_guest_name: string | null }
export const guestNameColumns = (alias: string) => `
  ${SUPPORT_CONVERSATION_SQL(alias)} AS support,
  (${channelGuestNameSql(`${alias}.id`)}) AS channel_guest_name`

export function guestHistoryContext(conversation: ConversationRow, guestUserId: string | null, window?: ConversationWindow): BatchQuery[] {
  return [
    { query: THREAD_ORGANIZATION_SQL, params: [conversation.organization_id] },
    ...(conversation.kind === 'booking' ? [guestThreadChannelQuery(conversation.id, conversation.organization_id)] : []),
    ...(conversation.location_id === null ? [] : [requestLocationQuery(conversation)]),
    ...guestUserId || !window || conversation.kind !== 'booking' ? [] : [{
      query: `SELECT ${guestNameColumns('c')} FROM conversations c WHERE c.id = ?`,
      params: [conversation.id],
    }],
  ]
}

export async function guestTranscript(
  db: DbClient,
  conversation: ConversationRow,
  buyerUserId: string | null,
  window: ConversationWindow | undefined,
  history: Promise<ConversationHistory>,
) {
  if (conversation.kind === 'team') return null
  const { id: threadId, organization_id: organizationId } = conversation
  const traveler = buyerUserId !== null && conversation.user_id !== buyerUserId
  const [thread, record, { entries: entryRows, context: [organizationResult, ...results], photos, actors: actorNames, automaticOwner, templateTitles, deliveriesByMessage }] = await Promise.all([
    validateGuestRequest(db, conversation),
    traveler ? null : getThreadOperationalRecord(db, threadId, conversation),
    history,
  ])
  const organization = organizationResult!.results[0] as ThreadOrganization | undefined
  const channelRow = conversation.kind === 'booking' ? results.shift()?.results[0] as GuestThreadChannelRow | undefined : null
  const location = (conversation.location_id === null ? undefined : results.shift()?.results[0] as RequestLocation | undefined) ?? null
  const windowFacts = !buyerUserId && window && conversation.kind === 'booking' ? results[0]?.results[0] as ThreadWideFacts | undefined : undefined
  if (buyerUserId && !traveler && record && (record.user_id !== buyerUserId || record.organization_id !== organizationId)) return null
  if (!organization) throw new Error('Conversation has no organization')
  if (conversation.kind === 'booking' && !channelRow) throw new Error('Conversation has no channel facts')
  if (window && !buyerUserId && conversation.kind === 'booking' && !windowFacts) throw new Error('Transcript window is missing thread facts')
  const channelThread = channelRow ? parseGuestThreadChannel(channelRow) : { productId: null, mapping: null, connected: false, booking: null }

  const [answers, summary, home, activityPath] = await Promise.all([
    !traveler && entryRows.some(entry => entry.event_name === SUBMISSION_EVENT) ? threadAnswers(db, thread) : [],
    requestSummary(db, thread, record, location),
    buyerUserId || record?.unit === 'nights' || !channelThread.productId ? null
      : queryFirst<{ internal_name: string }>(db, 'SELECT internal_name FROM product_stay_configs WHERE organization_id = ? AND product_id = ?', [organizationId, channelThread.productId]),
    buyerUserId && !traveler && thread.kind === 'booking' && window?.before == null
      ? record && channelRow?.booking_owner === 'app'
        ? accountActivityPath(record.unit === 'nights' ? 'stay' : 'booking', thread.id)
        : buyerRequestActivityPath(db, { organizationId, conversationId: thread.id, userId: buyerUserId })
      : null,
  ])
  const entries = entryRows.map((entry): GuestThreadEntryViewModel => {
    const payload = parseMessagePayload(entry)
    delete payload.email
    const mirrored = entry.event_name === MIRRORED_EVENT
    const event = isEventMessage(entry)
    const role = messageRole(entry, thread.user_id)
    if (mirrored && (!Array.isArray(payload.attachments) || !payload.attachments.every(link => typeof link === 'string' && URL.canParse(link) && new URL(link).protocol === 'https:'))) {
      throw new HTTPError({ statusCode: 500, message: 'The mirrored message has invalid attachment links', data: { code: 'CHANNEL_MESSAGE_PAYLOAD_INVALID', entry_id: entry.id, field: 'attachments' } })
    }
    const providerRecordedAt = mirrored ? providerTimestamp(payload.provider_inserted_at, `message:${entry.id}`, 'provider_inserted_at') : null
    // Airbnb's photos are our own media once the mirror has stored them, like every message's.
    const attachments = photos.get(entry.id) ?? []
    return {
      id: entry.id,
      kind: event ? 'event' : 'message',
      actorKind: role,
      actorUserId: buyerUserId
        ? role === 'guest' && entry.author_user_id === buyerUserId ? entry.author_user_id : null
        : entry.author_user_id,
      actorLabel: role === 'guest' && entry.author_user_id && entry.author_user_id !== thread.user_id ? actorNames.get(entry.author_user_id) ?? null
        : buyerUserId ? null : actorLabel(entry, role, mirrored, actorNames, organization.name),
      channel: entry.channel,
      body: entry.body,
      eventName: entry.event_name,
      payload: buyerUserId
        ? event ? { action: payload.action ?? null } : { unshownFiles: payload.unshownFiles ?? [] }
        : payload,
      sequence: entry.sequence,
      occurredAt: entry.occurred_at,
      providerTimestamp: providerRecordedAt,
      deliveries: (deliveriesByMessage.get(entry.id) ?? []).map(({ id, channel, provider, purpose, status, error, updated_at }) => ({ id, channel, provider, purpose, status, error, updated_at })),
      attachments,
    }
  })

  if (!buyerUserId) {
    const named = record?.unit === 'nights' ? { internal_name: record.product_internal_name } : home
    if (named) { summary.productTitle = named.internal_name; summary.locationTitle = named.internal_name }
  }
  const view: TranscriptView = {
    id: thread.id,
    organizationName: organization.name,
    organizationVertical: organization.vertical,
    activityPath,
    guestName: summary.guestName,
    participantLabel: summary.participantLabel,
    conversationChannel: channelThread.productId !== null ? 'airbnb' as const : 'direct' as const,
    locationLabel: summary.locationTitle,
    operationalRecord: record ? { id: record.id, unit: record.unit, product_kind: record.product_kind, status: record.status, starts_at: record.starts_at, ends_at: record.ends_at, timezone: record.timezone, party_size: record.party_size,
      check_in_date: record.unit === 'nights' ? bookingDay(record.starts_at, record.timezone) : null, check_out_date: record.unit === 'nights' ? bookingDay(record.ends_at, record.timezone) : null } : null,
    entries,
    inquiry: !traveler && thread.kind === 'booking' && thread.payload.inquiry ? { checkIn: thread.payload.inquiry.check_in_date, checkOut: thread.payload.inquiry.check_out_date } : null,
    answers, automaticOwner, templateTitles,
    ...(window ? { window: { support: Boolean(windowFacts?.support), channelGuestName: windowFacts?.channel_guest_name ?? null } } : {}),
  }
  return { request: thread, channelFacts: channelThread, timeZone: summary.locationTimezone ?? organization.timezone, view }
}

/** The alert projects only its message and the prior messages it can quote. */
export async function guestMessageAlertWindow(db: DbClient, entry: MessageRow, guest: GuestRequest, business: string, historyLimit: number) {
  const filter = `(m.author_kind <> 'krabiclaw' OR m.event_name IN ('${OPENING_EVENT}', '${SCHEDULED_MESSAGE_EVENT}', '${MIRRORED_EVENT}'))
    AND (${messageHasContentSql('m')} OR json_array_length(m.payload_json, '$.unshownFiles') > 0)`
  const [history, anchor, sender] = await Promise.all([
    readConversationHistory(db, entry.conversation_id, { guestUserId: null, kind: guest.kind, filter }, { before: entry.sequence, limit: historyLimit }),
    readConversationEnrichment(db, [entry.id], entry.author_user_id ? [entry.author_user_id] : []),
    entry.channel === 'airbnb' ? queryFirst<{ name: string | null }>(db, `SELECT (${channelGuestNameSql('?')}) AS name`, [guest.id]) : null,
  ])
  const names = new Map([...history.actors, ...anchor.actors.map(actor => [actor.id, actor.name] as const)])
  const messages = [...history.entries, entry].map(row => {
    const role = messageRole(row, guest.user_id)
    return {
      id: row.id,
      actorKind: role,
      actorLabel: actorLabel(row, role, row.event_name === MIRRORED_EVENT, names, business),
      body: row.body,
      payload: parseMessagePayload(row),
      attachments: (row.id === entry.id ? anchor.photos : history.photos).get(row.id) ?? [],
    }
  })
  return { messages, channelGuestName: sender?.name ?? null }
}

/**
 * Who wrote a message or caused an event, from its own facts. A member's
 * message always records its member; the user FK sets that to null only when
 * the account is deleted, which is a recorded fact rather than a missing one.
 * KrabiClaw alone writes a relayed provider message, an automatic message or
 * an event nobody caused.
 */
function actorLabel(entry: MessageRow, role: GuestThreadEntryViewModel['actorKind'], mirrored: boolean, actorNames: Map<string, string>, business: string): string | null {
  // The host's Airbnb messages are the business's side, whoever typed them on Airbnb.
  if (mirrored) return entry.author_kind === 'krabiclaw' ? 'Airbnb' : entry.author_kind === 'member' ? business : null
  if (entry.event_name === SCHEDULED_MESSAGE_EVENT) return 'Scheduled message'
  // The booking's own message, written with the record: no one on the team said it.
  if (entry.event_name === OPENING_EVENT) return null
  if (role === 'guest') return null
  if (entry.author_user_id) {
    const name = actorNames.get(entry.author_user_id)
    if (!name?.trim()) throw new HTTPError({ statusCode: 500, message: 'The message author has no account name', data: { code: 'INVALID_GUEST_THREAD_ENTRY', field: 'author_user_id', entry_id: entry.id } })
    return name
  }
  if (role === 'krabiclaw') return null
  return 'Deleted account'
}
