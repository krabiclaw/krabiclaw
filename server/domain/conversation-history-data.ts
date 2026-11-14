import { executeBatch, queryAll, type BatchQuery, type DbClient } from '~/server/db'
import { SCHEDULED_MESSAGE_EVENT, conversationMessagesQuery, type ConversationGuard, type ConversationWindow, type MessageRow } from './conversations'
import { groupMessagePhotos, messagePhotoRowsSql, type MessagePhotoRow } from './guest-threads/attachments'
import { HISTORY_DELIVERY_COLUMNS, HISTORY_DELIVERY_FIELDS, groupMessageDeliveries, type HistoryDelivery } from './guest-threads/deliveries'
import type { ConversationEntry, ConversationMessage } from '~/shared/messages-contract'
import type { GuestThreadEntryAttachmentViewModel } from './guest-threads/types'
import { transcriptDays } from './guest-threads/presentation'

export function groupConversationEntries(entries: Exclude<ConversationEntry, { type: 'day' }>[], timeZone: string, now: Date): ConversationEntry[] {
  const dates = transcriptDays(timeZone, now)
  const rows: ConversationEntry[] = []
  let day: string | undefined
  let previous: ConversationMessage | undefined
  for (const entry of entries) {
    const instant = new Date(entry.sent_at)
    const date = dates.date(instant)
    if (date.key !== day) {
      rows.push({ type: 'day', id: `day:${date.key}`, label: dates.label(instant, date) })
      day = date.key
      previous = undefined
    }
    if (entry.type === 'message') {
      const sameSender = previous?.author === entry.author && previous.author_user_id === entry.author_user_id && previous.side === entry.side
      entry.time = sameSender && previous && !previous.automatic && !entry.automatic ? null : dates.time(instant)
      previous = entry
    } else previous = undefined
    rows.push(entry)
  }
  return rows
}

export function conversationMessage(input: {
  id: string; sequence: number; authorUserId: string | null; side: ConversationMessage['side']; author: string;
  automatic: boolean; sentAt: string; body: string | null; attachments: GuestThreadEntryAttachmentViewModel[];
  deliveries?: HistoryDelivery[]; label?: string | null; time?: string | null; unshownFiles?: number;
}): ConversationMessage {
  return {
    type: 'message', id: input.id, sequence: input.sequence, author_user_id: input.authorUserId,
    side: input.side, author: input.author, automatic: input.automatic, label: input.label ?? null,
    sent_at: input.sentAt, time: input.time ?? null, body: input.body, unshown_files: input.unshownFiles ?? 0,
    photos: input.attachments.map(({ id, url, thumbnailUrl, width, height }) => ({ id, url, thumbnail_url: thumbnailUrl, width, height })),
    deliveries: input.deliveries?.map(({ id, channel, status, error, updated_at }) => ({ id, channel, status, error, updated_at })) ?? [],
    receipt: null, retryable: false,
  }
}

type HistoryRow = MessageRow & {
  author_name: string | null
  photo_rows: string
  delivery_rows: string
  template_title: string | null
  automatic_owner: string | null
}

const receiptFields = HISTORY_DELIVERY_FIELDS.map(field => `'${field}', d.${field}`).join(', ')

/** One cursor and ordering rule for the transcript, regardless of participants or booking context. */
export async function readConversationHistory(
  db: DbClient,
  conversationId: string,
  audience: { guestUserId: string | null; guard?: ConversationGuard; filter?: string },
  window?: ConversationWindow,
  contextQueries: BatchQuery[] = [],
) {
  const { query, params } = conversationMessagesQuery(conversationId, audience.guestUserId, window, audience.guard, audience.filter)
  const staff = !audience.guestUserId
  const photos = messagePhotoRowsSql("mp.owner_type = 'message' AND mp.owner_id = m.id AND mp.organization_id = m.organization_id")
  const receipts = staff && !audience.filter ? `(
    SELECT json_group_array(json_object(${receiptFields}))
    FROM (SELECT ${HISTORY_DELIVERY_COLUMNS} FROM guest_thread_deliveries d
      WHERE d.message_id = m.id AND d.purpose IN ('owner_alert', 'member_reply', 'scheduled_message')
      ORDER BY d.created_at, d.id) d
  )` : "'[]'"
  const showAutomatic = !audience.filter
  const automatic = showAutomatic ? `,
    scheduled AS MATERIALIZED (SELECT id, organization_id, conversation_id FROM display WHERE enrich AND event_name = '${SCHEDULED_MESSAGE_EVENT}'),
    template_titles AS MATERIALIZED (
      SELECT s.message_id, s.template_title
        FROM scheduled_guest_messages s
       WHERE s.organization_id = (SELECT organization_id FROM scheduled LIMIT 1)
         AND s.message_id IN (SELECT id FROM scheduled)
    )${staff ? `, automatic_owner AS MATERIALIZED (
      SELECT u.name FROM member seat JOIN user u ON u.id = seat.userId
       WHERE seat.organizationId = (SELECT organization_id FROM scheduled LIMIT 1)
         AND seat.role = 'owner' ORDER BY seat.createdAt, seat.id LIMIT 1
    )` : ''}` : ''
  const page = { query: `WITH page AS MATERIALIZED (${query}), display AS MATERIALIZED (
      SELECT page.*, ${window ? 'sequence <> min(sequence) OVER () OR count(*) OVER () <= ?' : '1'} AS enrich FROM page
    )${automatic}
    SELECT m.*,
      CASE WHEN enrich THEN (SELECT u.name FROM user u WHERE u.id = m.author_user_id ${staff ? '' : "AND m.author_kind = 'guest'"}) END AS author_name,
      CASE WHEN enrich THEN (SELECT json_group_array(json_object('owner_id', p.owner_id, 'id', p.id, 'public_url', p.public_url,
        'thumbnail_url', p.thumbnail_url, 'alt_text', p.alt_text, 'width', p.width, 'height', p.height)) FROM (${photos}) p) END AS photo_rows,
      CASE WHEN enrich THEN ${receipts} END AS delivery_rows,
      ${showAutomatic ? '(SELECT s.template_title FROM template_titles s WHERE s.message_id = m.id)' : 'NULL'} AS template_title,
      ${showAutomatic && staff ? '(SELECT name FROM automatic_owner)' : 'NULL'} AS automatic_owner
    FROM display m ORDER BY m.sequence`, params: [...(params ?? []), ...(window ? [window.limit] : [])] }
  const results = contextQueries.length ? await executeBatch(db, [page, ...contextQueries], { operation: 'Read conversation history' }) : undefined
  const rows = results ? results[0]!.results as HistoryRow[] : await queryAll<HistoryRow>(db, page.query, page.params)
  const hasOlder = window !== undefined && rows.length > window.limit
  const entries = hasOlder ? rows.slice(1) : rows
  const actors = new Map<string, string>()
  const templateTitles = new Map<string, string>()
  const messagePhotos: MessagePhotoRow[] = []
  const deliveries: HistoryDelivery[] = []
  let automaticOwner: string | null = null
  for (const row of entries) {
    if (row.author_user_id && row.author_name !== null) actors.set(row.author_user_id, row.author_name)
    if (row.template_title !== null) templateTitles.set(row.id, row.template_title)
    automaticOwner ??= row.automatic_owner
    for (const photo of JSON.parse(row.photo_rows) as MessagePhotoRow[]) messagePhotos.push(photo)
    for (const receipt of JSON.parse(row.delivery_rows) as HistoryDelivery[]) deliveries.push(receipt)
  }
  return {
    entries,
    context: results?.slice(1) ?? [],
    photos: groupMessagePhotos(messagePhotos),
    actors,
    deliveriesByMessage: groupMessageDeliveries(deliveries),
    templateTitles,
    automaticOwner,
    page: {
      before: hasOlder ? entries[0]!.sequence : null,
      oldest: entries[0]?.sequence ?? null,
      newest: entries.at(-1)?.sequence ?? null,
    },
  }
}

export type ConversationHistory = Awaited<ReturnType<typeof readConversationHistory>>
