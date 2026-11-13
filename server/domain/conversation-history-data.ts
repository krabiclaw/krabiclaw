import { executeBatch, queryAll, type BatchQuery, type DbClient } from '~/server/db'
import { conversationMessagesQuery, isEventMessage, type ConversationGuard, type ConversationRow, type ConversationWindow, type MessageRow } from './conversations'
import { readConversationEnrichment, threadDeliveriesQuery } from './guest-threads/deliveries'

/** One cursor and ordering rule for the transcript, regardless of participants or booking context. */
export async function readConversationHistory(
  db: DbClient,
  conversationId: string,
  audience: { guestUserId: string | null; guard?: ConversationGuard; filter?: string },
  window?: ConversationWindow,
  contextQueries: BatchQuery[] = [],
) {
  const messages = conversationMessagesQuery(conversationId, audience.guestUserId, window, audience.guard, audience.filter)
  const results = contextQueries.length ? await executeBatch(db, [messages, ...contextQueries], { operation: 'Read conversation history' }) : undefined
  const rows = results ? results[0]!.results as MessageRow[] : await queryAll<MessageRow>(db, messages.query, messages.params)
  const hasOlder = window !== undefined && rows.length > window.limit
  const entries = hasOlder ? rows.slice(1) : rows
  return {
    entries,
    context: results?.slice(1) ?? [],
    page: {
      before: hasOlder ? entries[0]!.sequence : null,
      oldest: entries[0]?.sequence ?? null,
      newest: entries.at(-1)?.sequence ?? null,
    },
  }
}

export type ConversationHistory = Awaited<ReturnType<typeof readConversationHistory>>

/** The history window alone determines which message attachments, authors and receipts to read. */
export async function enrichConversationHistory(
  db: DbClient,
  conversation: ConversationRow,
  entries: MessageRow[],
  guestUserId: string | null,
  window?: ConversationWindow,
) {
  const team = conversation.kind === 'team'
  const ids = entries.map(entry => entry.id)
  const attachmentIds = team ? ids : entries.filter(entry => !isEventMessage(entry)).map(entry => entry.id)
  const authorIds = team ? [] : entries.flatMap(entry =>
    entry.author_user_id && (!guestUserId || entry.author_kind === 'guest') ? [entry.author_user_id] : [],
  )
  const receipts = guestUserId || (window && !ids.length) ? null
    : threadDeliveriesQuery(conversation.id, window ? ids : undefined, team ? 'owner_alert' : undefined)
  return readConversationEnrichment(db, attachmentIds, authorIds, receipts)
}
