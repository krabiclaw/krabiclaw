import { buyerRequestActivityPath } from '~/server/domain/payments/buyer'
import { d1JsonStringSet, queryAll, queryFirst, type DbClient } from '~/server/db'
import { getGuestRequest, getThreadOperationalRecord, requestSummary, requestActions, stayPreview } from '~/server/domain/requests'
import { formatOperationalStatusLabel } from './status-labels'
import { resolveGuestThreadMailbox } from './mailbox'
import { listThreadEntries, parseEntryPayload, isBuyerVisibleThreadEntry } from './entries'
import { isVisibleDeliveryFailure, listThreadDeliveries } from './deliveries'
import { listMessagePhotos } from './attachments'
import type { GuestThreadDetailViewModel, GuestThreadEntryDeliveryViewModel, GuestThreadEntryViewModel } from './types'

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


  const [entryRows, deliveryRows] = await Promise.all([
    listThreadEntries(db, threadId),
    listThreadDeliveries(db, threadId),
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

  const photos = await listMessagePhotos(db, entryRows.filter(entry => entry.kind === 'message').map(entry => entry.id))

  // Who on the team said or did each thing, by the name their account carries.
  const actorUserIds = entryRows.flatMap(entry => entry.actor_user_id ? [entry.actor_user_id] : [])
  const actorNames = new Map(actorUserIds.length
    ? (await queryAll<{ id: string; name: string }>(db, 'SELECT id, name FROM user WHERE id IN (SELECT value FROM json_each(?))', [d1JsonStringSet(actorUserIds)]))
        .map(row => [row.id, row.name])
    : [])

  const visibleEntries = audience ? entryRows.filter(isBuyerVisibleThreadEntry) : entryRows
  const entries: GuestThreadEntryViewModel[] = visibleEntries.map(entry => {
    const payload = parseEntryPayload(entry)
    if (payload) delete payload.email
    return {
      id: entry.id,
      kind: entry.kind,
      actorKind: entry.actor_kind,
      actorUserId: audience
        ? entry.actor_kind === 'guest' && entry.channel === 'web' && entry.actor_user_id === audience.buyerUserId ? entry.actor_user_id : null
        : entry.actor_user_id,
      actorLabel: entry.actor_user_id ? actorNames.get(entry.actor_user_id) ?? null : null,
      channel: entry.channel,
      body: entry.body,
      eventName: entry.event_name,
      payload: audience
        ? entry.kind === 'message' ? { unshownFiles: payload?.unshownFiles ?? [] }
          : entry.kind === 'operation' ? { action: payload?.action ?? null } : null
        : payload,
      sequence: entry.sequence,
      occurredAt: entry.occurred_at,
      deliveries: audience ? [] : deliveriesByEntry.get(entry.id) ?? [],
      attachments: photos.get(entry.id) ?? [],
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
    guestEmail: summary.guestEmail,
    guestPhone: summary.guestPhone,
    submissionType: thread.kind,
    submissionId: thread.id,
    contextLabel: summary.contextLabel,
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
      createdAt: d.created_at,
    })),
    createdAt: thread.created_at,
    updatedAt: thread.updated_at,
    resolvedAt: audience ? null : thread.resolved_at,
  }
}
