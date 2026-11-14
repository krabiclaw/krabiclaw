import { buyerRequestActivityPath } from '~/server/domain/payments/buyer'
import { OPEN_REPLY_TASK_SQL } from './repository'
import { queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { bookingDay, getThreadOperationalRecord, requestSummary, requestLocationQuery, requestActions, stayPreview, validateGuestRequest, type GuestRequest, type RequestLocation } from '~/server/domain/requests'
import { formatOperationalStatusLabel } from './status-labels'
import { resolveGuestThreadMailbox } from './mailbox'
import { GUEST_NOTE_EVENT, MIRRORED_EVENT, OPENING_EVENT, SCHEDULED_MESSAGE_EVENT, SUBMISSION_EVENT, isEventMessage, messageHasContentSql, messageRole, participantGuard, readConversation, readGuestConversation, parseMessagePayload, type ConversationRow, type ConversationWindow, type MessageRow } from '~/server/domain/conversations'
import { readConversationHistory, type ConversationHistory } from '~/server/domain/conversation-history-data'
import { groupMessageDeliveries, isVisibleDeliveryFailure, listThreadDeliveries, readConversationEnrichment } from './deliveries'
import type { GuestThreadDetailViewModel, GuestThreadEntryViewModel } from './types'
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

function deliveryRecipient(emailJson: string | null): string | null {
  if (!emailJson) return null
  const parsed = JSON.parse(emailJson) as { message?: { to?: unknown } }
  return typeof parsed.message?.to === 'string' && parsed.message.to.trim() ? parsed.message.to.trim() : null
}

/**
 * Builds the full canonical conversation detail view model — the sole source
 * for the detail API. A guest reads it as `buyerUserId`; a member as
 * `memberUserId`, whose own archive it shows; a server read (an alert, MCP)
 * as neither. It never writes.
 */
export async function getGuestThreadDetail(
  db: DbClient,
  threadId: string,
  organizationId: string,
  viewer?: { buyerUserId: string } | { memberUserId: string },
): Promise<GuestThreadDetailViewModel | null> {
  const detail = await loadGuestThreadDetail(db, threadId, organizationId, viewer)
  return detail ? detail.view : null
}

export type TranscriptView = Pick<GuestThreadDetailViewModel,
  'id' | 'organizationName' | 'organizationVertical' | 'activityPath' | 'guestName' | 'participantLabel'
  | 'conversationChannel' | 'locationLabel' | 'operationalRecord' | 'entries' | 'inquiry'>
  & { answers: FormAnswerSnapshot[]; window?: TranscriptWindow; automaticOwner: string | null; templateTitles: Map<string, string> }

interface TranscriptWindow {
  support: boolean
  channelGuestName: string | null
  translated: boolean
}

/** Request and routing facts stay beside the view so they never enter its guest projection. */
type ThreadViewer = ({ buyerUserId: string } | { memberUserId: string }) & { conversation?: ConversationRow }
type LoadedThread<View> = {
  view: View
  request: GuestRequest
  channelFacts: ReturnType<typeof parseGuestThreadChannel>
  timeZone: string
}

type ThreadOrganization = { name: string; vertical: string; timezone: string }
const THREAD_ORGANIZATION_SQL = 'SELECT name, vertical, timezone FROM organization WHERE id = ?'
const CHANNEL_GUEST_NAME_SQL = `SELECT trim(json_extract(m.payload_json, '$.meta.name')) FROM messages m
  WHERE m.conversation_id = ? AND m.author_kind = 'guest' AND m.event_name = '${MIRRORED_EVENT}'
    AND json_type(m.payload_json, '$.meta.name') = 'text' AND trim(json_extract(m.payload_json, '$.meta.name')) <> ''
  ORDER BY m.sequence DESC LIMIT 1`
type ThreadWideFacts = { support: number; channel_guest_name: string | null; translated: number }

export function guestHistoryContext(conversation: ConversationRow, guestUserId: string | null, window?: ConversationWindow): BatchQuery[] {
  return [
    { query: THREAD_ORGANIZATION_SQL, params: [conversation.organization_id] },
    ...(conversation.kind === 'booking' ? [guestThreadChannelQuery(conversation.id, conversation.organization_id)] : []),
    ...(conversation.location_id === null ? [] : [requestLocationQuery(conversation)]),
    ...guestUserId || !window || conversation.kind !== 'booking' ? [] : [{
      query: `SELECT
        EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = ? AND m.author_kind = 'krabiclaw' AND m.event_name = '${MIRRORED_EVENT}') AND
        NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = ? AND m.author_kind = 'guest') AS support,
        (${CHANNEL_GUEST_NAME_SQL}) AS channel_guest_name,
        EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = ? AND m.author_kind = 'guest' AND json_type(m.payload_json, '$.meta.translated_message') = 'text' AND trim(json_extract(m.payload_json, '$.meta.translated_message')) <> '' AND trim(json_extract(m.payload_json, '$.meta.translated_message')) IS NOT trim(m.body)) AS translated`,
      params: Array.from({ length: 4 }, () => conversation.id),
    }],
  ]
}

export function loadGuestThreadDetail(db: DbClient, threadId: string, organizationId: string, viewer?: ThreadViewer, at?: Date, transcript?: false): Promise<LoadedThread<GuestThreadDetailViewModel> | null>
export function loadGuestThreadDetail(db: DbClient, threadId: string, organizationId: string, viewer: ThreadViewer, at: Date, transcript: true, window: ConversationWindow | undefined, history: Promise<ConversationHistory>): Promise<LoadedThread<TranscriptView> | null>
export async function loadGuestThreadDetail(
  db: DbClient,
  threadId: string,
  organizationId: string,
  viewer?: ThreadViewer,
  at = new Date(),
  transcript = false,
  window?: ConversationWindow,
  history?: Promise<ConversationHistory>,
): Promise<LoadedThread<GuestThreadDetailViewModel | TranscriptView> | null> {
  const audience = viewer && 'buyerUserId' in viewer ? viewer : undefined
  const member = viewer && 'memberUserId' in viewer ? viewer : undefined
  const memberUserId = member?.memberUserId ?? null
  const conversation = viewer?.conversation ?? (audience ? await readGuestConversation(db, audience.buyerUserId, threadId) : await readConversation(db, organizationId, threadId))
  if (audience && (!conversation || conversation.organization_id !== organizationId)) return null
  if (!conversation || conversation.kind === 'team') return null
  if (conversation.id !== threadId || conversation.organization_id !== organizationId) {
    throw new Error('The authorized guest conversation does not match the requested thread')
  }
  const now = at.toISOString()
  const traveler = audience && conversation.user_id !== audience.buyerUserId
  const guestUserId = audience?.buyerUserId ?? null
  const guard = guestUserId ? participantGuard('c', guestUserId, 'guest') : memberUserId ? participantGuard('c', memberUserId, 'member') : undefined
  const [thread, record, loaded, needsReply, archive, deliveryRows] = await Promise.all([
    validateGuestRequest(db, conversation),
    traveler ? null : getThreadOperationalRecord(db, threadId, conversation),
    history ?? readConversationHistory(db, threadId, { guestUserId, guard, kind: conversation.kind }, window, guestHistoryContext(conversation, guestUserId, window)),
    audience || transcript ? false : queryFirst(db, `SELECT 1 AS open FROM conversations gt WHERE gt.id = ? AND ${OPEN_REPLY_TASK_SQL}`, [threadId]).then(Boolean),
    memberUserId && !transcript ? queryFirst<{ archived_at: string | null }>(db, 'SELECT archived_at FROM conversation_participants WHERE conversation_id = ? AND user_id = ?', [threadId, memberUserId]) : null,
    !audience && !transcript ? listThreadDeliveries(db, threadId) : [],
  ])
  const { entries: entryRows, context: [organizationResult, ...results], photos, actors: actorNames, automaticOwner, templateTitles } = loaded
  const organization = organizationResult!.results[0] as ThreadOrganization | undefined
  const channelRow = conversation.kind === 'booking' ? results.shift()?.results[0] as GuestThreadChannelRow | undefined : null
  const location = (conversation.location_id === null ? undefined : results.shift()?.results[0] as RequestLocation | undefined) ?? null
  const windowFacts = !audience && window && conversation.kind === 'booking' ? results[0]?.results[0] as ThreadWideFacts | undefined : undefined
  if (audience && !traveler && record && (record.user_id !== audience.buyerUserId || record.organization_id !== organizationId)) return null
  if (!organization) throw new Error('Conversation has no organization')
  if (conversation.kind === 'booking' && !channelRow) throw new Error('Conversation has no channel facts')
  if (window && !audience && conversation.kind === 'booking' && !windowFacts) throw new Error('Transcript window is missing thread facts')
  const channelThread = channelRow ? parseGuestThreadChannel(channelRow) : { productId: null, mapping: null, connected: false, booking: null }

  const [answers, summary, home, activityPath] = await Promise.all([
    !traveler && (!transcript || entryRows.some(entry => entry.event_name === SUBMISSION_EVENT)) ? threadAnswers(db, thread) : [],
    requestSummary(db, thread, record, location),
    audience || record?.unit === 'nights' || !channelThread.productId ? null
      : queryFirst<{ internal_name: string }>(db, 'SELECT internal_name FROM product_stay_configs WHERE organization_id = ? AND product_id = ?', [organizationId, channelThread.productId]),
    audience && !traveler && thread.kind !== 'contact' ? buyerRequestActivityPath(db, audience.buyerUserId, thread.id) : null,
  ])
  const deliveriesByMessage = transcript ? loaded.deliveriesByMessage : groupMessageDeliveries(deliveryRows)
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
      actorUserId: audience
        ? role === 'guest' && entry.author_user_id === audience.buyerUserId ? entry.author_user_id : null
        : entry.author_user_id,
      actorLabel: role === 'guest' && entry.author_user_id && entry.author_user_id !== thread.user_id ? actorNames.get(entry.author_user_id) ?? null
        : audience ? null : actorLabel(entry, role, mirrored, actorNames, organization.name),
      channel: entry.channel,
      body: entry.body,
      eventName: entry.event_name,
      payload: audience
        ? event ? { action: payload.action ?? null } : { unshownFiles: payload.unshownFiles ?? [] }
        : payload,
      sequence: entry.sequence,
      occurredAt: entry.occurred_at,
      providerTimestamp: providerRecordedAt,
      deliveries: (deliveriesByMessage.get(entry.id) ?? []).map(({ id, channel, provider, purpose, status, error, updated_at }) => ({ id, channel, provider, purpose, status, error, updated_at })),
      attachments,
    }
  })

  if (!audience) {
    const named = record?.unit === 'nights' ? { internal_name: record.product_internal_name } : home
    if (named) { summary.productTitle = named.internal_name; summary.locationTitle = named.internal_name }
  }
  const sharedView = {
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
  }
  const context = { request: thread, channelFacts: channelThread, timeZone: summary.locationTimezone ?? organization.timezone }
  if (transcript) {
    let windowView: TranscriptWindow | undefined
    if (window) {
      windowView = {
        support: Boolean(windowFacts?.support),
        channelGuestName: windowFacts?.channel_guest_name?.trim() ?? null,
        translated: Boolean(windowFacts?.translated),
      }
    }
    return { ...context, view: { ...sharedView, answers, automaticOwner, templateTitles, ...windowView && { window: windowView } } }
  }

  const mailbox = resolveGuestThreadMailbox({ blocked_at: thread.blocked_at, archived_at: archive?.archived_at ?? null }, record, now, { lastMessageAt: thread.last_message_at }, audience ? 'buyer' : 'member')
  const words = (event: string) => entryRows.find(entry => entry.event_name === event && entry.author_kind === 'guest')?.body ?? null
  const submissionType = thread.kind === 'booking' && (record ? record.unit === 'nights' : channelThread.productId !== null) ? 'stay' : thread.kind
  const view: GuestThreadDetailViewModel = {
    ...sharedView,
    guestEmail: summary.guestEmail,
    guestPhone: summary.guestPhone,
    submissionType,
    submissionId: thread.id,
    needsReply,
    source: {
      submissionType,
      submissionId: thread.id,
      operationalStatus: record?.status ?? null,
      operationalStatusLabel: record ? formatOperationalStatusLabel(submissionType, record.status) : null,
      fields: thread.kind === 'contact'
        ? { subject: thread.payload.subject, message: words(SUBMISSION_EVENT), locationTitle: summary.locationTitle, productTitle: summary.productTitle, answers }
        : submissionType === 'stay'
          ? {
              // A stay is its nights in its own days.
              whenLabel: record ? stayPreview(record) : null,
              startsAt: null, endsAt: null, timezone: record?.timezone ?? null,
              guests: record ? String(record.party_size) : null, partySize: record?.party_size ?? null,
              notes: null, locationTitle: summary.locationTitle, productTitle: summary.productTitle, answers,
            }
          : {
            whenLabel: record ? new Intl.DateTimeFormat('en-US', { timeZone: record.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(record.starts_at)) : null,
            startsAt: record?.starts_at ?? null,
            endsAt: record?.ends_at ?? null,
            timezone: record?.timezone ?? null,
            guests: record ? `${record.party_size}${record.party_size_is_minimum ? '+' : ''}` : null,
            partySize: record?.party_size ?? null,
            notes: words(GUEST_NOTE_EVENT),
            locationTitle: summary.locationTitle,
            productTitle: summary.productTitle,
            answers,
          },
    },
    availableActions: audience ? [] : requestActions(record, now),
    mailbox: mailbox.mailbox,
    manuallyArchived: mailbox.manuallyArchived,
    archivedAt: audience ? null : archive?.archived_at ?? null,
    blockedAt: audience ? null : thread.blocked_at,
    canArchive: audience ? false : mailbox.canArchive,
    canUnarchive: audience ? false : mailbox.canUnarchive,
    deliveryFailures: audience ? [] : deliveryRows.filter(isVisibleDeliveryFailure).map(d => ({
      id: d.id,
      channel: d.channel,
      purpose: d.purpose,
      // The guest's own address; a host alert's recipient is a teammate's, which is not shown on the conversation.
      recipient: d.channel === 'email' && d.purpose === 'guest_acknowledgement' ? deliveryRecipient(d.email_json) : null,
      error: d.error,
      status: d.status,
      createdAt: d.created_at,
    })),
    createdAt: thread.created_at,
    lastMessageAt: thread.last_message_at,
  }
  return { ...context, view }
}

/** The alert projects only its message and the prior messages it can quote. */
export async function guestMessageAlertWindow(db: DbClient, entry: MessageRow, guest: GuestRequest, business: string, historyLimit: number) {
  const filter = `(m.author_kind <> 'krabiclaw' OR m.event_name IN ('${OPENING_EVENT}', '${SCHEDULED_MESSAGE_EVENT}', '${MIRRORED_EVENT}'))
    AND (${messageHasContentSql('m')} OR json_array_length(m.payload_json, '$.unshownFiles') > 0)`
  const [history, anchor, sender] = await Promise.all([
    readConversationHistory(db, entry.conversation_id, { guestUserId: null, kind: guest.kind, filter }, { before: entry.sequence, limit: historyLimit }),
    readConversationEnrichment(db, [entry.id], entry.author_user_id ? [entry.author_user_id] : []),
    entry.channel === 'airbnb' ? queryFirst<{ name: string | null }>(db, `SELECT (${CHANNEL_GUEST_NAME_SQL}) AS name`, [guest.id]) : null,
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
