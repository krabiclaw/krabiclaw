import { buyerRequestActivityPath } from '~/server/domain/payments/buyer'
import { OPEN_REPLY_TASK_SQL } from './repository'
import { executeBatch, queryAll, queryFirst, type DbClient } from '~/server/db'
import { bookingDay, getThreadOperationalRecord, requestSummary, requestLocationQuery, requestActions, stayPreview, validateGuestRequest, type GuestRequest, type RequestLocation } from '~/server/domain/requests'
import { formatOperationalStatusLabel } from './status-labels'
import { resolveGuestThreadMailbox } from './mailbox'
import { GUEST_NOTE_EVENT, MIRRORED_EVENT, OPENING_EVENT, SCHEDULED_MESSAGE_EVENT, SUBMISSION_EVENT, isEventMessage, conversationMessagesQuery, guestVisibleSql, messageHasContentSql, messageRole, participantGuard, readConversation, readGuestConversation, parseMessagePayload, type ConversationGuard, type ConversationRow, type ConversationWindow, type MessageRow } from '~/server/domain/conversations'
import { isDeliverySent, isVisibleDeliveryFailure, readConversationEnrichment, threadDeliveriesQuery } from './deliveries'
import type { GuestThreadDeliveryRow, GuestThreadDetailViewModel, GuestThreadEntryDeliveryViewModel, GuestThreadEntryViewModel } from './types'
import { HTTPError } from 'nitro'
import { providerTimestamp } from '~/server/integrations/channex/messages'
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
type ThreadViewer = ({ buyerUserId: string } | { memberUserId: string }) & { conversation?: ConversationRow; guard?: ConversationGuard }
type LoadedThread<View> = {
  view: View
  request: GuestRequest
  channelFacts: NonNullable<Awaited<ReturnType<typeof guestThreadChannel>>>
  timeZone: string
}

type ThreadOrganization = { name: string; vertical: string; timezone: string }
const THREAD_ORGANIZATION_SQL = 'SELECT name, vertical, timezone FROM organization WHERE id = ?'
const CHANNEL_GUEST_NAME_SQL = `SELECT trim(json_extract(m.payload_json, '$.meta.name')) FROM messages m
  WHERE m.conversation_id = ? AND m.author_kind = 'guest' AND m.event_name = '${MIRRORED_EVENT}'
    AND json_type(m.payload_json, '$.meta.name') = 'text' AND trim(json_extract(m.payload_json, '$.meta.name')) <> ''
  ORDER BY m.sequence DESC LIMIT 1`
type ThreadWideFacts = { support: number; channel_guest_name: string | null; translated: number; invalid_receipt: number }

async function readTranscriptBase(db: DbClient, conversation: ConversationRow, guestUserId: string | null, window?: ConversationWindow, guard?: ConversationGuard) {
  const results = await executeBatch(db, [
    { query: THREAD_ORGANIZATION_SQL, params: [conversation.organization_id] },
    conversationMessagesQuery(conversation.id, guestUserId, window, guard),
    ...(conversation.location_id === null ? [] : [requestLocationQuery(conversation)]),
    ...guestUserId ? [] : [window ? {
      query: `SELECT
        EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = ? AND m.author_kind = 'krabiclaw' AND m.event_name = '${MIRRORED_EVENT}') AND
        NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = ? AND m.author_kind = 'guest') AS support,
        (${CHANNEL_GUEST_NAME_SQL}) AS channel_guest_name,
        EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = ? AND m.author_kind = 'guest' AND json_type(m.payload_json, '$.meta.translated_message') = 'text' AND trim(json_extract(m.payload_json, '$.meta.translated_message')) <> '' AND trim(json_extract(m.payload_json, '$.meta.translated_message')) IS NOT trim(m.body)) AS translated,
        EXISTS (SELECT 1 FROM messages m JOIN guest_thread_deliveries d ON d.message_id = m.id WHERE m.conversation_id = ? AND d.provider = 'channex' AND d.status IN ('accepted', 'sent', 'delivered', 'read') AND length(trim(COALESCE(d.provider_message_id, ''))) = 0) AS invalid_receipt`,
      params: Array.from({ length: 5 }, () => conversation.id),
    } : threadDeliveriesQuery(conversation.id)],
  ], { operation: 'Read transcript' })
  const [organization, messages, third, fourth] = results
  const locationResult = conversation.location_id === null ? undefined : third
  const deliveryResult = conversation.location_id === null ? third : fourth
  return {
    organization: organization!.results[0] as ThreadOrganization | undefined,
    entryRows: messages!.results as MessageRow[],
    deliveryRows: window || guestUserId ? [] : (deliveryResult?.results ?? []) as GuestThreadDeliveryRow[],
    windowFacts: window ? deliveryResult?.results[0] as ThreadWideFacts | undefined : undefined,
    location: (locationResult?.results[0] as RequestLocation | undefined) ?? null,
  }
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
  const conversation = viewer?.conversation ?? (audience ? await readGuestConversation(db, audience.buyerUserId, threadId) : await readConversation(db, organizationId, threadId))
  if (audience && (!conversation || conversation.organization_id !== organizationId)) return null
  if (!conversation || conversation.kind === 'team') return null
  if (conversation.id !== threadId || conversation.organization_id !== organizationId) {
    throw new Error('The authorized guest conversation does not match the requested thread')
  }
  const now = at.toISOString()
  const traveler = audience && conversation.user_id !== audience.buyerUserId
  const guard = viewer?.guard ?? (audience ? participantGuard('c', audience.buyerUserId, 'guest') : undefined)
  const [thread, record, base, channelThread, needsReply, archive] = await Promise.all([
    validateGuestRequest(db, conversation),
    traveler ? null : getThreadOperationalRecord(db, threadId, conversation),
    readTranscriptBase(db, conversation, audience?.buyerUserId ?? null, window, guard),
    guestThreadChannel(db, threadId, organizationId),
    audience || transcript ? false : queryFirst(db, `SELECT 1 AS open FROM conversations gt WHERE gt.id = ? AND ${OPEN_REPLY_TASK_SQL}`, [threadId]).then(Boolean),
    memberUserId && !transcript ? queryFirst<{ archived_at: string | null }>(db, 'SELECT archived_at FROM conversation_participants WHERE conversation_id = ? AND user_id = ?', [threadId, memberUserId]) : null,
  ])
  const { organization, location, windowFacts } = base
  const hasOlder = window !== undefined && base.entryRows.length > window.limit
  const entryRows = hasOlder ? base.entryRows.slice(1) : base.entryRows
  if (audience && !traveler && record && (record.user_id !== audience.buyerUserId || record.organization_id !== organizationId)) return null
  if (!organization) throw new Error('Conversation has no organization')
  if (!channelThread) throw new Error('Conversation has no channel facts')
  if (window && !audience && !windowFacts) throw new Error('Transcript window is missing thread facts')

  // The second wave: what the conversation's own rows point at. Who on the team
  // said or did each thing is read by the name their account carries.
  const actorUserIds = entryRows.flatMap(entry =>
    entry.author_user_id && (!audience || entry.author_kind === 'guest') ? [entry.author_user_id] : [],
  )
  const messageIds = entryRows.filter(entry => !isEventMessage(entry)).map(entry => entry.id)
  const receiptQuery = window && !audience && entryRows.length ? threadDeliveriesQuery(threadId, entryRows.map(row => row.id)) : null
  const [enrichment, answers, summary, home, activityPath, failedMessages, pendingProposals] = await Promise.all([
    readConversationEnrichment(db, messageIds, actorUserIds, receiptQuery),
    !traveler && (!transcript || entryRows.some(entry => entry.event_name === SUBMISSION_EVENT)) ? threadAnswers(db, thread) : [],
    requestSummary(db, thread, record, location),
    audience || record?.unit === 'nights' || !channelThread.productId ? null
      : queryFirst<{ internal_name: string }>(db, 'SELECT internal_name FROM product_stay_configs WHERE organization_id = ? AND product_id = ?', [organizationId, channelThread.productId]),
    audience && !traveler && thread.kind !== 'contact' ? buyerRequestActivityPath(db, audience.buyerUserId, thread.id) : null,
    window && !audience ? queryAll<{ id: string }>(db, `SELECT DISTINCT m.id FROM messages m JOIN guest_thread_deliveries d ON d.message_id = m.id
      WHERE m.conversation_id = ? AND (d.status = 'failed' OR (d.channel = 'email' AND d.status <> 'skipped' AND length(d.error) > 0))`, [threadId]) : [],
    !traveler && window?.before === null && thread.kind === 'booking' ? queryAll<MessageRow>(db, `SELECT m.* FROM messages m WHERE m.conversation_id = ? AND m.event_name = 'booking_change.requested'
      AND NOT EXISTS (SELECT 1 FROM messages decision WHERE decision.dedupe_key = 'booking-change-decision:' || m.id)
      ${audience ? `AND ${guestVisibleSql('m', '1')}` : ''}`, [threadId]) : [],
  ])
  const inWindow = new Set(entryRows.map(entry => entry.id))
  const olderProposals = pendingProposals.filter(entry => !inWindow.has(entry.id))
  const changes = traveler ? new Map() : await bookingChangeViews(db, thread, [...entryRows, ...olderProposals], now)
  const { photos, actors: actorRows } = enrichment
  const deliveryRows = receiptQuery ? enrichment.deliveries : base.deliveryRows
  // One read of the deliveries answers both questions the thread asks of them:
  // where each entry went, and which sends failed.
  const deliveriesByEntry = new Map<string, GuestThreadEntryDeliveryViewModel[]>()
  for (const delivery of deliveryRows) {
    if (!delivery.message_id) throw new Error(`Delivery ${delivery.id} of conversation ${threadId} names no message`)
    const forEntry = deliveriesByEntry.get(delivery.message_id) ?? []
    forEntry.push({ id: delivery.id, channel: delivery.channel, provider: delivery.provider, purpose: delivery.purpose, status: delivery.status, error: delivery.error, updated_at: delivery.updated_at })
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
    inquiry: !traveler && thread.kind === 'booking' && thread.payload.inquiry ? { checkIn: thread.payload.inquiry.check_in_date, checkOut: thread.payload.inquiry.check_out_date } : null,
  }
  const context = { request: thread, channelFacts: channelThread, timeZone: summary.locationTimezone ?? organization.timezone }
  if (transcript) {
    let windowView: TranscriptWindow | undefined
    if (window) {
      windowView = {
        before: hasOlder ? entryRows[0]!.sequence : null,
        oldest: entryRows[0]?.sequence ?? null,
        newest: entryRows.at(-1)?.sequence ?? null,
        support: Boolean(windowFacts?.support),
        channelGuestName: windowFacts?.channel_guest_name?.trim() ?? null,
        translated: Boolean(windowFacts?.translated),
        failedMessages: failedMessages.map(row => row.id),
        bookingActions: olderProposals.filter(entry => changes.get(entry.id)?.status === 'pending').map(projectEntry),
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

/** The alert projects only its message and the prior messages it can quote. */
export async function guestMessageAlertWindow(db: DbClient, entry: MessageRow, guest: GuestRequest, business: string, historyLimit: number) {
  const previous = await queryAll<MessageRow>(db, `
    SELECT m.* FROM messages m WHERE m.conversation_id = ? AND m.sequence < ?
      AND (m.author_kind <> 'krabiclaw' OR m.event_name IN ('${OPENING_EVENT}', '${SCHEDULED_MESSAGE_EVENT}', '${MIRRORED_EVENT}'))
      AND (${messageHasContentSql('m')} OR json_array_length(m.payload_json, '$.unshownFiles') > 0)
    ORDER BY m.sequence DESC LIMIT ?`, [entry.conversation_id, entry.sequence, historyLimit])
  const rows = [...previous.reverse(), entry]
  const [{ photos, actors }, sender] = await Promise.all([
    readConversationEnrichment(db, rows.map(row => row.id), rows.flatMap(row => row.author_user_id ? [row.author_user_id] : []), null),
    entry.channel === 'airbnb' ? queryFirst<{ name: string | null }>(db, `SELECT (${CHANNEL_GUEST_NAME_SQL}) AS name`, [guest.id]) : null,
  ])
  const names = new Map(actors.map(actor => [actor.id, actor.name]))
  const messages = rows.map(row => {
    const role = messageRole(row, guest.user_id)
    return {
      id: row.id,
      actorKind: role,
      actorLabel: actorLabel(row, role, row.event_name === MIRRORED_EVENT, names, business),
      body: row.body,
      payload: parseMessagePayload(row),
      attachments: photos.get(row.id) ?? [],
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
