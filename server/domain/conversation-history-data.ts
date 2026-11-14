import { executeBatch, queryAll, type BatchQuery, type DbClient } from '~/server/db'
import { SCHEDULED_MESSAGE_EVENT, conversationMessagesQuery, type ConversationGuard, type ConversationRow, type ConversationWindow, type MessageRow } from './conversations'
import { groupMessagePhotos, messagePhotoRowsSql, type MessagePhotoRow } from './guest-threads/attachments'
import { HISTORY_DELIVERY_COLUMNS, HISTORY_DELIVERY_FIELDS, groupMessageDeliveries, type HistoryDelivery } from './guest-threads/deliveries'

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
  audience: { guestUserId: string | null; kind: ConversationRow['kind']; guard?: ConversationGuard; filter?: string },
  window?: ConversationWindow,
  contextQueries: BatchQuery[] = [],
) {
  const { query, params } = conversationMessagesQuery(conversationId, audience.guestUserId, window, audience.guard, audience.filter)
  const team = audience.kind === 'team'
  const staff = !audience.guestUserId
  const photos = messagePhotoRowsSql("mp.owner_type = 'message' AND mp.owner_id = m.id AND mp.organization_id = m.organization_id")
  const receipts = staff && !audience.filter ? `(
    SELECT json_group_array(json_object(${receiptFields}))
    FROM (SELECT ${HISTORY_DELIVERY_COLUMNS} FROM guest_thread_deliveries d
      WHERE d.message_id = m.id AND d.purpose ${team ? "= 'owner_alert'" : "IN ('member_reply', 'scheduled_message')"}
      ORDER BY ${team ? 'd.created_at, d.id' : 'd.created_at DESC, d.id'}) d
  )` : "'[]'"
  const showAutomatic = !team && !audience.filter
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
      ${team ? 'NULL' : `CASE WHEN enrich THEN (SELECT u.name FROM user u WHERE u.id = m.author_user_id ${staff ? '' : "AND m.author_kind = 'guest'"}) END`} AS author_name,
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
