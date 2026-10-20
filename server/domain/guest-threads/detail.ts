import { buyerRequestActivityPath } from '~/server/domain/payments/buyer'
import { d1JsonStringSet, queryAll, queryFirst, type DbClient } from '~/server/db'
import { getGuestRequest, getThreadOperationalRecord, requestSummary, requestActions, stayPreview } from '~/server/domain/requests'
import { formatOperationalStatusLabel } from './status-labels'
import { resolveGuestThreadMailbox } from './mailbox'
import { listThreadEntries, parseEntryPayload, isBuyerVisibleThreadEntry } from './entries'
import { isDeliverySent, isVisibleDeliveryFailure, listThreadDeliveries } from './deliveries'
import { listMessagePhotos } from './attachments'
import type { GuestThreadDetailViewModel, GuestThreadEntryDeliveryViewModel, GuestThreadEntryRow, GuestThreadEntryViewModel } from './types'
import { HTTPError } from 'nitro'
import { providerTimestamp } from '~/server/integrations/channex/messages'

/** Builds the full canonical thread detail view model — the sole source for the detail API. */
export async function getGuestThreadDetail(
  db: DbClient,
  threadId: string,
  organizationId: string,
  audience?: { buyerUserId: string },
): Promise<GuestThreadDetailViewModel | null> {
  const thread = await getGuestRequest(db, threadId, organizationId, undefined, audience?.buyerUserId)
  if (!thread || (audience && thread.user_id !== audience.buyerUserId)) return null
  const record = await getThreadOperationalRecord(db, thread.id)
  if (audience && record && (record.user_id !== audience.buyerUserId || record.organization_id !== organizationId || record.kind !== thread.kind)) return null
  const organization = await queryFirst<{name:string;vertical:string}>(db,'SELECT name,vertical FROM organization WHERE id=?',[organizationId])
  if (!organization) throw new Error('Conversation has no organization')


  const [entryRows, deliveryRows, channelThread] = await Promise.all([
    listThreadEntries(db, threadId),
    listThreadDeliveries(db, threadId),
    queryFirst(db, `SELECT request_id FROM channel_threads WHERE organization_id = ? AND request_id = ?
      UNION ALL SELECT request_id FROM stays WHERE organization_id = ? AND request_id = ? AND owner = 'channel' LIMIT 1`, [organizationId, threadId, organizationId, threadId]),
  ])

  // One read of the deliveries answers both questions the thread asks of them:
  // where each entry went, and which sends failed.
  const deliveriesByEntry = new Map<string, GuestThreadEntryDeliveryViewModel[]>()
  for (const delivery of deliveryRows) {
    const forEntry = deliveriesByEntry.get(delivery.entry_id) ?? []
    forEntry.push({ id: delivery.id, channel: delivery.channel, purpose: delivery.purpose, status: delivery.status })
    deliveriesByEntry.set(delivery.entry_id, forEntry)
  }
  const deliveryFailureRows = deliveryRows.filter(isVisibleDeliveryFailure)
  if (deliveryRows.some(delivery => delivery.provider === 'channex' && isDeliverySent(delivery) && !delivery.provider_message_id?.trim())) {
    throw new HTTPError({ statusCode: 500, message: 'A successful channel reply has no provider message ID', data: { code: 'CHANNEL_RECEIPT_INVALID', field: 'delivery.provider_message_id' } })
  }

  const photos = await listMessagePhotos(db, 'activity_entry', entryRows.filter(entry => entry.kind === 'message').map(entry => entry.id))

  // Who on the team said or did each thing, by the name their account carries.
  const actorUserIds = entryRows.flatMap(entry => entry.actor_user_id ? [entry.actor_user_id] : [])
  const actorNames = new Map(actorUserIds.length
    ? (await queryAll<{ id: string; name: string }>(db, 'SELECT id, name FROM user WHERE id IN (SELECT value FROM json_each(?))', [d1JsonStringSet(actorUserIds)]))
        .map(row => [row.id, row.name])
    : [])

  // The local attempt and its provider resource remain separate immutable facts.
  // Only an actual successful receipt ID proves the mirrored property message is
  // the same reply. No content, timestamp or in-flight state identifies an echo.
  const acceptedChannelIds = new Set(deliveryRows.flatMap(delivery => delivery.provider === 'channex' && isDeliverySent(delivery) && delivery.provider_message_id !== null ? [delivery.provider_message_id] : []))
  const presentationEntries = entryRows.filter(entry => {
    if (entry.event_name !== 'channel.message_mirrored' || entry.actor_kind !== 'member') return true
    const payload = parseEntryPayload(entry)
    if (typeof payload?.provider_message_id !== 'string' || !payload.provider_message_id) throw new HTTPError({ statusCode: 500, message: 'The mirrored message has no provider message ID', data: { code: 'CHANNEL_MESSAGE_PAYLOAD_INVALID', field: 'provider_message_id', entry_id: entry.id } })
    return !acceptedChannelIds.has(payload.provider_message_id)
  })
  const visibleEntries = audience ? presentationEntries.filter(isBuyerVisibleThreadEntry) : presentationEntries
  const entries: GuestThreadEntryViewModel[] = visibleEntries.map(entry => {
    const payload = parseEntryPayload(entry)
    if (payload) delete payload.email
    const mirrored = entry.event_name === 'channel.message_mirrored'
    if (mirrored && (!payload || !Array.isArray(payload.attachments) || !payload.attachments.every(link => typeof link === 'string' && URL.canParse(link) && new URL(link).protocol === 'https:'))) {
      throw new HTTPError({ statusCode: 500, message: 'The mirrored message has invalid attachment links', data: { code: 'CHANNEL_MESSAGE_PAYLOAD_INVALID', entry_id: entry.id, field: 'attachments' } })
    }
    const providerRecordedAt = mirrored ? providerTimestamp(payload!.provider_inserted_at, `activity_entry:${entry.id}`, 'provider_inserted_at') : null
    const attachments = mirrored
      ? (payload!.attachments as string[]).map((url, index) => ({ id: `${entry.id}:${index}`, url, alt: null, width: null, height: null }))
      : photos.get(entry.id) ?? []
    return {
      id: entry.id,
      kind: entry.kind,
      actorKind: entry.actor_kind,
      actorUserId: audience
        ? entry.actor_kind === 'guest' && entry.channel === 'web' && entry.actor_user_id === audience.buyerUserId ? entry.actor_user_id : null
        : entry.actor_user_id,
      actorLabel: actorLabel(entry, mirrored, actorNames),
      channel: entry.channel,
      body: entry.body,
      eventName: entry.event_name,
      payload: audience
        ? entry.kind === 'message' ? { unshownFiles: payload?.unshownFiles ?? [] }
          : entry.kind === 'operation' ? { action: payload?.action ?? null } : null
        : payload,
      sequence: entry.sequence,
      occurredAt: entry.occurred_at,
      providerTimestamp: providerRecordedAt,
      deliveries: audience ? [] : deliveriesByEntry.get(entry.id) ?? [],
      attachments,
    }
  })

  const summary = await requestSummary(db, thread, record)
  const now = new Date().toISOString()
  const mailbox = resolveGuestThreadMailbox(thread, record, now, audience?'buyer':'member')

  return {
    id: thread.id,
    organizationName: organization.name,
    organizationVertical: organization.vertical,
    activityPath: audience && thread.kind!=='contact' ? await buyerRequestActivityPath(db,audience.buyerUserId,thread.id) : null,
    guestName: summary.guestName,
    participantLabel: summary.participantLabel,
    replyChannel: channelThread ? 'airbnb' : 'email',
    guestAccountLinked: thread.user_id !== null,
    guestEmail: summary.guestEmail,
    guestPhone: summary.guestPhone,
    submissionType: thread.kind,
    submissionId: thread.id,
    locationLabel: summary.locationTitle,
    conversationState: audience ? null : thread.conversation_state,
    operationalRecord: record ? { id: record.id, kind: record.kind, status: record.status, starts_at: record.starts_at, ends_at: record.ends_at, timezone: record.timezone, party_size: record.party_size, check_in_date: record.check_in_date, check_out_date: record.check_out_date } : null,
    source: {
      submissionType: thread.kind,
      submissionId: thread.id,
      operationalStatus: record?.status ?? null,
      operationalStatusLabel: record ? formatOperationalStatusLabel(thread.kind, record.status) : null,
      fields: thread.kind === 'contact'
        ? { subject: thread.payload.subject, message: thread.payload.message, locationTitle: summary.locationTitle, productTitle: summary.productTitle }
        : thread.kind === 'stay'
          ? {
              // A stay is its nights in its own dates; it has no start time to localize.
              whenLabel: record?.check_in_date && record.check_out_date ? stayPreview({ check_in_date: record.check_in_date, check_out_date: record.check_out_date, party_size: record.party_size }) : null,
              startsAt: null, endsAt: null, timezone: record?.timezone ?? null,
              guests: record ? String(record.party_size) : null, partySize: record?.party_size ?? null,
              notes: null, locationTitle: summary.locationTitle, productTitle: summary.productTitle,
            }
          : {
            whenLabel: record ? new Intl.DateTimeFormat('en-US', { timeZone: record.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(record.starts_at)) : null,
            startsAt: record?.starts_at ?? null,
            endsAt: record?.ends_at ?? null,
            timezone: record?.timezone ?? null,
            guests: record ? `${record.party_size}${thread.payload.party_size_is_minimum ? '+' : ''}` : null,
            partySize: record?.party_size ?? null,
            notes: thread.payload.notes,
            locationTitle: summary.locationTitle,
            productTitle: summary.productTitle,
          },
    },
    entries,
    availableActions: audience ? [] : requestActions(record, now),
    mailbox: mailbox.mailbox,
    manuallyArchived: mailbox.manuallyArchived,
    archivedAt: audience ? null : thread.archived_at,
    archivedByUserId: audience ? null : thread.archived_by_user_id,
    canArchive: audience ? false : mailbox.canArchive,
    canUnarchive: audience ? false : mailbox.canUnarchive,
    deliveryFailures: audience ? [] : deliveryFailureRows.map(d => ({
      id: d.id,
      channel: d.channel,
      purpose: d.purpose,
      error: d.error,
      status: d.status,
      createdAt: d.created_at,
    })),
    createdAt: thread.created_at,
    updatedAt: thread.updated_at,
    resolvedAt: audience ? null : thread.resolved_at,
  }
}

/**
 * Who wrote a team-side message, from the entry's own facts. A member reply
 * always records its member; the user FK sets that to null only when the
 * account is deleted, which is a recorded fact rather than a missing one. A
 * system message is either a provider message or a scheduled message.
 */
function actorLabel(entry: GuestThreadEntryRow, mirrored: boolean, actorNames: Map<string, string>): string | null {
  if (mirrored) return entry.actor_kind === 'system' ? 'Airbnb' : entry.actor_kind === 'member' ? 'Property on Airbnb' : null
  if (entry.event_name === 'thread.scheduled_message') return 'Scheduled message'
  if (entry.actor_user_id) {
    const name = actorNames.get(entry.actor_user_id)
    if (!name?.trim()) throw new HTTPError({ statusCode: 500, message: 'The entry actor has no account name', data: { code: 'INVALID_GUEST_THREAD_ENTRY', field: 'actor_user_id', entry_id: entry.id } })
    return name
  }
  if (entry.kind !== 'message' || entry.actor_kind === 'guest') return null
  if (entry.actor_kind === 'member') return 'Deleted account'
  throw new HTTPError({ statusCode: 500, message: 'The system message has no recorded source', data: { code: 'INVALID_GUEST_THREAD_ENTRY', field: 'actor_kind', entry_id: entry.id } })
}
