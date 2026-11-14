import { queryAll, type BatchQuery, type DbClient } from '~/server/db'
import { MEMBER_REPLY_EVENT, SCHEDULED_MESSAGE_EVENT, type ConversationWindow, type MessageRow } from './conversations'
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
  deliveries?: HistoryDelivery[]; unshownFiles?: number;
}): ConversationMessage {
  return {
    type: 'message', id: input.id, sequence: input.sequence, author_user_id: input.authorUserId,
    side: input.side, author: input.author, automatic: input.automatic,
    sent_at: input.sentAt, time: null, body: input.body, unshown_files: input.unshownFiles ?? 0,
    photos: input.attachments.map(({ id, url, thumbnailUrl, width, height }) => ({ id, url, thumbnail_url: thumbnailUrl, width, height })),
    deliveries: input.deliveries?.map(({ id, channel, status, error, updated_at }) => ({ id, channel, status, error, updated_at })) ?? [],
    receipt: null, retryable: false,
  }
}

export type HistoryRow = Pick<MessageRow, 'id' | 'organization_id' | 'conversation_id' | 'sequence' | 'author_user_id' | 'author_kind' | 'event_name' | 'occurred_at' | 'body' | 'payload_json'> & {
  author_name: string | null
  photo_rows: string
  delivery_rows: string | null
}

const receiptFields = HISTORY_DELIVERY_FIELDS.map(field => `'${field}', d.${field}`).join(', ')

/** The display window uses the conversation sequence index and fetches one extra row for the cursor. */
export function conversationHistorySql(
  window: ConversationWindow,
  scope: BatchQuery,
  authorized = false,
): BatchQuery {
  const visibleAuthors = authorized ? "AND (m.viewer_role = 'member' OR m.author_kind = 'guest')" : ''
  const photos = messagePhotoRowsSql("mp.owner_type = 'message' AND mp.owner_id = m.id AND mp.organization_id = m.organization_id")
  const receipts = authorized ? `CASE WHEN m.enrich AND m.viewer_role = 'member'
      AND (m.kind = 'team' OR m.event_name IN ('${MEMBER_REPLY_EVENT}', '${SCHEDULED_MESSAGE_EVENT}')) THEN (
    SELECT json_group_array(json_object(${receiptFields}))
    FROM (SELECT ${HISTORY_DELIVERY_COLUMNS} FROM guest_thread_deliveries d
      WHERE d.message_id = m.id AND CASE WHEN m.kind = 'team'
        THEN d.purpose = 'owner_alert' AND d.status = 'failed'
        ELSE d.purpose IN ('member_reply', 'scheduled_message') END
      ORDER BY d.created_at, d.id) d
  ) END` : 'NULL'
  return { query: `WITH page AS MATERIALIZED (
      SELECT m.id, m.organization_id, m.conversation_id, m.sequence, m.author_kind, m.author_user_id,
        m.event_name, m.occurred_at, m.body, m.payload_json${authorized ? ', (SELECT viewer_role FROM authorized) AS viewer_role, (SELECT kind FROM authorized) AS kind' : ''}
      FROM messages m WHERE ${scope.query}
        ${window.before === null ? '' : 'AND m.sequence < ?'}
      ORDER BY m.sequence DESC LIMIT ?
    ), display AS MATERIALIZED (
      SELECT page.*, sequence <> min(sequence) OVER () OR count(*) OVER () <= ? AS enrich FROM page
    ), authors AS MATERIALIZED (
      SELECT u.id, u.name FROM user u WHERE u.id IN (
        SELECT m.author_user_id FROM display m WHERE m.enrich AND m.author_user_id IS NOT NULL ${visibleAuthors}
      )
    )
    SELECT m.*, a.name AS author_name,
      CASE WHEN m.enrich THEN (SELECT json_group_array(json_object('owner_id', p.owner_id, 'id', p.id, 'public_url', p.public_url,
        'thumbnail_url', p.thumbnail_url, 'alt_text', p.alt_text, 'width', p.width, 'height', p.height)) FROM (${photos}) p) END AS photo_rows,
      ${receipts} AS delivery_rows
    FROM display m LEFT JOIN authors a ON a.id = m.author_user_id ${visibleAuthors} ORDER BY m.sequence`,
  params: [...(scope.params ?? []), ...(window.before === null ? [] : [window.before]), window.limit + 1, window.limit] }
}

/** A notification quote uses the same bounded page as the transcript. */
export async function readConversationHistory(db: DbClient, conversationId: string, filter: string, window: ConversationWindow) {
  const { query, params } = conversationHistorySql(window, { query: `m.conversation_id = ? AND (${filter})`, params: [conversationId] })
  return projectConversationHistory(await queryAll<HistoryRow>(db, query, params), window.limit)
}

export function projectConversationHistory(rows: HistoryRow[], limit: number) {
  const hasOlder = rows.length > limit
  const entries = hasOlder ? rows.slice(1) : rows
  const actors = new Map<string, string>()
  const messagePhotos: MessagePhotoRow[] = []
  const deliveries: HistoryDelivery[] = []
  for (const row of entries) {
    if (row.author_user_id && row.author_name !== null) actors.set(row.author_user_id, row.author_name)
    for (const photo of JSON.parse(row.photo_rows) as MessagePhotoRow[]) messagePhotos.push(photo)
    if (row.delivery_rows !== null) {
      for (const receipt of JSON.parse(row.delivery_rows) as HistoryDelivery[]) deliveries.push(receipt)
    }
  }
  return {
    entries,
    photos: groupMessagePhotos(messagePhotos),
    actors,
    deliveriesByMessage: groupMessageDeliveries(deliveries),
    page: {
      before: hasOlder ? entries[0]!.sequence : null,
      oldest: entries[0]?.sequence ?? null,
      newest: entries.at(-1)?.sequence ?? null,
    },
  }
}

export type ConversationHistory = ReturnType<typeof projectConversationHistory>
