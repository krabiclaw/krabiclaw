import { HTTPError } from 'nitro'
import { queryFirst, type DbClient } from '~/server/db'
import { MIRRORED_EVENT, OPENING_EVENT, SCHEDULED_MESSAGE_EVENT, messageHasContentSql, messageRole, parseMessagePayload, type MessageRow } from '~/server/domain/conversations'
import { readConversationHistory } from '~/server/domain/conversation-history-data'
import type { GuestRequest } from '~/server/domain/requests'
import { readConversationEnrichment } from './deliveries'

const channelGuestNameSql = (conversationId: string) => `SELECT trim(json_extract(m.payload_json, '$.meta.name')) FROM messages m
  WHERE m.conversation_id = ${conversationId} AND m.author_kind = 'guest' AND m.event_name = '${MIRRORED_EVENT}'
    AND json_type(m.payload_json, '$.meta.name') = 'text' AND trim(json_extract(m.payload_json, '$.meta.name')) <> ''
  ORDER BY m.sequence DESC LIMIT 1`

/** The alert projects only its message and the prior messages it can quote. */
export async function guestMessageAlertWindow(db: DbClient, entry: MessageRow, guest: GuestRequest, business: string, historyLimit: number) {
  const filter = `(m.author_kind <> 'krabiclaw' OR m.event_name IN ('${OPENING_EVENT}', '${SCHEDULED_MESSAGE_EVENT}', '${MIRRORED_EVENT}'))
    AND (${messageHasContentSql('m')} OR json_array_length(m.payload_json, '$.unshownFiles') > 0)`
  const [history, anchor, sender] = await Promise.all([
    readConversationHistory(db, entry.conversation_id, filter, { before: entry.sequence, limit: historyLimit }),
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
function actorLabel(entry: Pick<MessageRow, 'author_kind' | 'author_user_id' | 'event_name' | 'id'>, role: MessageRow['author_kind'], mirrored: boolean, actorNames: Map<string, string>, business: string): string | null {
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
