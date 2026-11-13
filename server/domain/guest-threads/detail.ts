import { buyerRequestActivityPath } from '~/server/domain/payments/buyer'
import { OPEN_REPLY_TASK_SQL } from './repository'
import { d1JsonStringSet, executeBatch, queryAll, queryFirst, type DbClient } from '~/server/db'
import { bookingDay, getGuestRequest, getThreadOperationalRecord, requestSummary, requestLocationQuery, requestActions, stayPreview, validateGuestRequest, type GuestRequest, type RequestLocation } from '~/server/domain/requests'
import { formatOperationalStatusLabel } from './status-labels'
import { resolveGuestThreadMailbox } from './mailbox'
import { GUEST_NOTE_EVENT, MIRRORED_EVENT, OPENING_EVENT, SCHEDULED_MESSAGE_EVENT, SUBMISSION_EVENT, isEventMessage, conversationMessagesQuery, listConversationMessages, messageRole, parseMessagePayload, type ConversationRow, type ConversationWindow, type MessageRow } from '~/server/domain/conversations'
import { isDeliverySent, isVisibleDeliveryFailure, listThreadDeliveries, threadDeliveriesQuery } from './deliveries'
import { groupMessagePhotos, listMessagePhotos, messagePhotosQuery, type MessagePhotoRow } from './attachments'
import type { GuestThreadDeliveryRow, GuestThreadDetailViewModel, GuestThreadEntryDeliveryViewModel, GuestThreadEntryViewModel } from './types'
import { HTTPError } from 'nitro'
import { providerTimestamp } from '~/server/integrations/channex/messages'
import { bookingChangeStates } from './booking-change-state'
import { bookingChangeViews } from './booking-changes'
import { guestThreadChannel } from './channel-messages'
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
  & { answers: FormAnswerSnapshot[]; window?: TranscriptWindow }

interface TranscriptWindow {
  before: number | null
  oldest: number | null
  newest: number | null
  support: boolean
  channelGuestName: string | null
  translated: boolean
  failedMessages: string[]
  bookingActions: GuestThreadEntryViewModel[]
}

/** Request and routing facts stay beside the view so they never enter its guest projection. */
type ThreadViewer = { buyerUserId: string } | { memberUserId: string; conversation?: ConversationRow }
type LoadedThread<View> = {
  view: View
  request: GuestRequest
  channelFacts: NonNullable<Awaited<ReturnType<typeof guestThreadChannel>>>
  timeZone: string
}

type ThreadOrganization = { name: string; vertical: string; timezone: string }
type ActorName = { id: string; name: string }
const THREAD_ORGANIZATION_SQL = 'SELECT name, vertical, timezone FROM organization WHERE id = ?'
const THREAD_ACTORS_SQL = 'SELECT id, name FROM user WHERE id IN (SELECT value FROM json_each(?))'
type ThreadWideFacts = { support: number; channel_guest_name: string | null; translated: number; invalid_receipt: number }

async function readMemberTranscriptBase(db: DbClient, conversation: ConversationRow, window?: ConversationWindow) {
  const [organization, messages, deliveries, location] = await executeBatch(db, [
    { query: THREAD_ORGANIZATION_SQL, params: [conversation.organization_id] },
    conversationMessagesQuery(conversation.id, false, window),
    window ? {
      query: `SELECT
        EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = ? AND m.author_kind = 'krabiclaw' AND m.event_name = '${MIRRORED_EVENT}') AND
        NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = ? AND m.author_kind = 'guest') AS support,
        (SELECT json_extract(m.payload_json, '$.meta.name') FROM messages m WHERE m.conversation_id = ? AND m.author_kind = 'guest' AND m.event_name = '${MIRRORED_EVENT}' AND json_type(m.payload_json, '$.meta.name') = 'text' AND trim(json_extract(m.payload_json, '$.meta.name')) <> '' ORDER BY m.sequence DESC LIMIT 1) AS channel_guest_name,
        EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = ? AND m.author_kind = 'guest' AND json_type(m.payload_json, '$.meta.translated_message') = 'text' AND trim(json_extract(m.payload_json, '$.meta.translated_message')) <> '' AND trim(json_extract(m.payload_json, '$.meta.translated_message')) IS NOT trim(m.body)) AS translated,
        EXISTS (SELECT 1 FROM messages m JOIN guest_thread_deliveries d ON d.message_id = m.id WHERE m.conversation_id = ? AND d.provider = 'channex' AND d.status IN ('accepted', 'sent', 'delivered', 'read') AND length(trim(COALESCE(d.provider_message_id, ''))) = 0) AS invalid_receipt`,
      params: Array.from({ length: 5 }, () => conversation.id),
    } : threadDeliveriesQuery(conversation.id),
    ...conversation.location_id === null ? [] : [requestLocationQuery(conversation)],
  ], { operation: 'Read member transcript' })
  return {
    organization: organization!.results[0] as ThreadOrganization | undefined,
    entryRows: messages!.results as MessageRow[],
    deliveryRows: window ? [] : deliveries!.results as GuestThreadDeliveryRow[],
    windowFacts: window ? deliveries!.results[0] as ThreadWideFacts : undefined,
    location: (location?.results[0] as RequestLocation | undefined) ?? null,
  }
}

async function readTranscriptActorsAndPhotos(db: DbClient, messageIds: string[], authorIds: string[]) {
  const actors = { query: THREAD_ACTORS_SQL, params: [d1JsonStringSet(authorIds)] }
  if (!messageIds.length || !authorIds.length) return Promise.all([
    listMessagePhotos(db, 'message', messageIds),
    authorIds.length ? queryAll<ActorName>(db, actors.query, actors.params) : [],
  ] as const)
  const [photos, names] = await executeBatch(db, [messagePhotosQuery('message', messageIds), actors], { operation: 'Read transcript photos and authors' })
  return [groupMessagePhotos(photos!.results as MessagePhotoRow[]), names!.results as ActorName[]] as const
}

export function loadGuestThreadDetail(db: DbClient, threadId: string, organizationId: string, viewer?: ThreadViewer, at?: Date, transcript?: false): Promise<LoadedThread<GuestThreadDetailViewModel> | null>
export function loadGuestThreadDetail(db: DbClient, threadId: string, organizationId: string, viewer: ThreadViewer, at: Date, transcript: true, window?: ConversationWindow): Promise<LoadedThread<TranscriptView> | null>
export async function loadGuestThreadDetail(
  db: DbClient,
  threadId: string,
  organizationId: string,
  viewer?: ThreadViewer,
  at = new Date(),
  transcript = false,
  window?: ConversationWindow,
): Promise<LoadedThread<GuestThreadDetailViewModel | TranscriptView> | null> {
  const audience = viewer && 'buyerUserId' in viewer ? viewer : undefined
  const member = viewer && 'memberUserId' in viewer ? viewer : undefined
  const memberUserId = member?.memberUserId ?? null
  const conversation = member?.conversation
  if (conversation && (conversation.id !== threadId || conversation.organization_id !== organizationId || conversation.kind === 'team')) {
    throw new Error('The authorized guest conversation does not match the requested thread')
  }
  const now = at.toISOString()
  const batched = transcript && conversation ? readMemberTranscriptBase(db, conversation, window) : null
  const [thread, record, base, channelThread, needsReply, archive] = await Promise.all([
    conversation ? validateGuestRequest(db, conversation) : getGuestRequest(db, threadId, organizationId, undefined, audience?.buyerUserId),
    getThreadOperationalRecord(db, threadId, conversation),
    batched ?? Promise.all([
      queryFirst<ThreadOrganization>(db, THREAD_ORGANIZATION_SQL, [organizationId]),
      listConversationMessages(db, threadId, Boolean(audience)),
      audience ? [] : listThreadDeliveries(db, threadId),
    ]).then(([organization, entryRows, deliveryRows]) => ({ organization, entryRows, deliveryRows, location: undefined, windowFacts: undefined })),
    guestThreadChannel(db, threadId, organizationId),
    audience || transcript ? false : queryFirst(db, `SELECT 1 AS open FROM conversations gt WHERE gt.id = ? AND ${OPEN_REPLY_TASK_SQL}`, [threadId]).then(Boolean),
    memberUserId && !transcript ? queryFirst<{ archived_at: string | null }>(db, 'SELECT archived_at FROM conversation_participants WHERE conversation_id = ? AND user_id = ?', [threadId, memberUserId]) : null,
  ])
  const { organization, location, windowFacts } = base
  const hasOlder = window !== undefined && base.entryRows.length > window.limit
  const entryRows = hasOlder ? base.entryRows.slice(1) : base.entryRows
  if (!thread || (audience && thread.user_id !== audience.buyerUserId)) return null
  if (audience && record && (record.user_id !== audience.buyerUserId || record.organization_id !== organizationId)) return null
  if (!organization) throw new Error('Conversation has no organization')
  if (!channelThread) throw new Error('Conversation has no channel facts')
  if (window && !windowFacts) throw new Error('Transcript window is missing thread facts')

  // The second wave: what the conversation's own rows point at. Who on the team
  // said or did each thing is read by the name their account carries.
  const actorUserIds = entryRows.flatMap(entry => entry.author_user_id ? [entry.author_user_id] : [])
  const messageIds = entryRows.filter(entry => !isEventMessage(entry)).map(entry => entry.id)
  const receiptQuery = window ? threadDeliveriesQuery(threadId, entryRows.map(row => row.id)) : null
  const [[photos, actorRows], changes, answers, summary, home, activityPath, deliveryRows, failedMessages, pendingProposals] = await Promise.all([
    batched ? readTranscriptActorsAndPhotos(db, messageIds, actorUserIds) : Promise.all([
      listMessagePhotos(db, 'message', messageIds),
      actorUserIds.length ? queryAll<ActorName>(db, THREAD_ACTORS_SQL, [d1JsonStringSet(actorUserIds)]) : [],
    ] as const),
    bookingChangeViews(db, thread, entryRows, now),
    !transcript || entryRows.some(entry => entry.event_name === SUBMISSION_EVENT) ? threadAnswers(db, thread) : [],
    requestSummary(db, thread, record, location),
    audience || record?.unit === 'nights' || !channelThread.productId ? null
      : queryFirst<{ internal_name: string }>(db, 'SELECT internal_name FROM product_stay_configs WHERE organization_id = ? AND product_id = ?', [organizationId, channelThread.productId]),
    audience && thread.kind !== 'contact' ? buyerRequestActivityPath(db, audience.buyerUserId, thread.id) : null,
    receiptQuery && entryRows.length ? queryAll<GuestThreadDeliveryRow>(db, receiptQuery.query, receiptQuery.params) : base.deliveryRows,
    window ? queryAll<{ id: string }>(db, `SELECT DISTINCT m.id FROM messages m JOIN guest_thread_deliveries d ON d.message_id = m.id
      WHERE m.conversation_id = ? AND (d.status = 'failed' OR (d.channel = 'email' AND d.status <> 'skipped' AND length(d.error) > 0))`, [threadId]) : [],
    window?.before === null && thread.kind === 'booking' ? queryAll<MessageRow>(db, `SELECT m.* FROM messages m WHERE m.conversation_id = ? AND m.event_name = 'booking_change.requested'
      AND NOT EXISTS (SELECT 1 FROM messages decision WHERE decision.dedupe_key = 'booking-change-decision:' || m.id)`, [threadId]) : [],
  ])
  // One read of the deliveries answers both questions the thread asks of them:
  // where each entry went, and which sends failed.
  const deliveriesByEntry = new Map<string, GuestThreadEntryDeliveryViewModel[]>()
  for (const delivery of deliveryRows) {
    if (!delivery.message_id) throw new Error(`Delivery ${delivery.id} of conversation ${threadId} names no message`)
    const forEntry = deliveriesByEntry.get(delivery.message_id) ?? []
    forEntry.push({ id: delivery.id, channel: delivery.channel, provider: delivery.provider, purpose: delivery.purpose, status: delivery.status })
    deliveriesByEntry.set(delivery.message_id, forEntry)
  }
  if (windowFacts?.invalid_receipt || deliveryRows.some(delivery => delivery.provider === 'channex' && isDeliverySent(delivery) && !delivery.provider_message_id?.trim())) {
    throw new HTTPError({ statusCode: 500, message: 'A successful channel reply has no provider message ID', data: { code: 'CHANNEL_RECEIPT_INVALID', field: 'delivery.provider_message_id' } })
  }


  const actorNames = new Map(actorRows.map(row => [row.id, row.name]))

  const projectEntry = (entry: MessageRow): GuestThreadEntryViewModel => {
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
      actorLabel: actorLabel(entry, role, mirrored, actorNames, organization.name),
      channel: entry.channel,
      body: entry.body,
      eventName: entry.event_name,
      payload: audience
        ? event ? { action: payload.action ?? null } : { unshownFiles: payload.unshownFiles ?? [] }
        : payload,
      sequence: entry.sequence,
      occurredAt: entry.occurred_at,
      providerTimestamp: providerRecordedAt,
      deliveries: audience ? [] : deliveriesByEntry.get(entry.id) ?? [],
      attachments,
      bookingChange: changes.get(entry.id) ?? null,
    }
  }
  const entries = entryRows.map(projectEntry)

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
    inquiry: thread.kind === 'booking' && thread.payload.inquiry ? { checkIn: thread.payload.inquiry.check_in_date, checkOut: thread.payload.inquiry.check_out_date } : null,
  }
  const context = { request: thread, channelFacts: channelThread, timeZone: summary.locationTimezone ?? organization.timezone }
  if (transcript) {
    let windowView: TranscriptWindow | undefined
    if (window && windowFacts) {
      const proposals = pendingProposals.filter(entry => !changes.has(entry.id))
      const states = await bookingChangeStates(db, proposals.map(entry => entry.id), now)
      const pending = proposals.filter(entry => states.get(entry.id)?.status === 'pending')
      const pendingViews = await bookingChangeViews(db, thread, pending, now)
      windowView = {
        before: hasOlder ? entryRows[0]!.sequence : null,
        oldest: entryRows[0]?.sequence ?? null,
        newest: entryRows.at(-1)?.sequence ?? null,
        support: Boolean(windowFacts.support),
        channelGuestName: windowFacts.channel_guest_name?.trim() ?? null,
        translated: Boolean(windowFacts.translated),
        failedMessages: failedMessages.map(row => row.id),
        bookingActions: pending.map(entry => ({ ...projectEntry(entry), bookingChange: pendingViews.get(entry.id)! })),
      }
    }
    return { ...context, view: { ...sharedView, answers, ...windowView && { window: windowView } } }
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
