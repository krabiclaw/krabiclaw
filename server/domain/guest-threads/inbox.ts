import { executeBatch, type DbClient } from '~/server/db'
import type { ConversationDetails, ConversationViewerRole } from '~/shared/messages-contract'
import type { ThreadWideFacts } from './detail'
import { messagePhotoRowsSql, type MessagePhotoRow } from './attachments'
import type { HistoryDelivery } from './deliveries'
import { resolveGuestThreadMailbox } from './mailbox'
import { participantLabel, type GuestRequest } from '~/server/domain/requests'
import { providerTimestamp } from '~/server/integrations/channex/messages'
import { conversationAccessDenied, guestVisibleSql, isEventMessage, MIRRORED_EVENT, participantGuard, SUPPORT_CONVERSATION_SQL, type ConversationRow, type MessageRow } from '~/server/domain/conversations'
import { firstName, providerInstant } from './presentation'

export function guestConversationNames(thread: GuestRequest, facts: ThreadWideFacts, channel: 'airbnb' | 'direct') {
  const kind = facts.support ? 'support' as const : 'guest' as const
  const recordedName = thread.payload.guest.name
  const channelName = facts.channel_guest_name
  const full = kind === 'support' ? 'Airbnb Support' : recordedName ?? channelName ?? participantLabel(thread)
  const title = kind === 'support' ? full : channelName ?? (channel === 'airbnb' && recordedName ? firstName(recordedName) : full)
  return { kind, full, title }
}

const RECEIPT_RANK = ['pending', 'sending', 'accepted', 'sent', 'delivered', 'read'] as const

/** What became of a reply, said once under the newest one as Airbnb says it. */
export function conversationDeliveryReceipt(deliveries: readonly Pick<HistoryDelivery, 'purpose' | 'provider' | 'status'>[], guestName: string): string | null {
  const attempts = deliveries.filter(delivery => delivery.purpose === 'member_reply' || delivery.purpose === 'scheduled_message')
  const providerReplies = attempts.filter(delivery => delivery.provider !== 'log_only')
  const replies = providerReplies.length ? providerReplies : attempts
  if (!replies.length) return null
  if (replies.every(delivery => delivery.status === 'failed' || delivery.status === 'skipped')) return 'Not delivered'
  const best = replies.reduce((top, delivery) => RECEIPT_RANK.indexOf(delivery.status as typeof RECEIPT_RANK[number]) > RECEIPT_RANK.indexOf(top.status as typeof RECEIPT_RANK[number]) ? delivery : top)
  if (best.provider === 'log_only') return 'Recorded locally'
  switch (best.status) {
    case 'read': return `Read by ${guestName}`
    case 'delivered': return 'Delivered'
    case 'accepted': case 'sent': return 'Sent'
    default: return 'Sending'
  }
}

/**
 * "In this conversation": its visible photos and the viewer's mailbox actions.
 * Everyone uses the roster already loaded with the conversation.
 */
export async function getConversationDetails(db: DbClient, conversation: ConversationRow, userId: string, role: ConversationViewerRole, now = new Date()): Promise<ConversationDetails> {
  const { id, organization_id: organizationId } = conversation
  const guard = participantGuard('c', userId, role)
  const [factsResult, photosResult] = await executeBatch(db, [
    { query: `SELECT c.blocked_at, c.last_message_at, seat.archived_at, b.ends_at, ${SUPPORT_CONVERSATION_SQL('c')} AS support
        FROM conversations c
        JOIN conversation_participants seat ON seat.conversation_id = c.id AND seat.user_id = ?
        LEFT JOIN bookings b ON b.id = c.booking_id AND b.organization_id = c.organization_id
        WHERE c.id = ? AND c.organization_id = ? AND ${guard.sql}`, params: [userId, id, organizationId, ...guard.params] },
    { query: messagePhotoRowsSql(
      `mp.owner_type = 'message' AND m.conversation_id = ? AND mp.organization_id = ? AND ${guard.sql}
        ${role === 'guest' ? `AND ${guestVisibleSql('m', 'c.user_id = ?')}` : ''}`,
      'JOIN messages m ON m.id = mp.owner_id AND m.organization_id = mp.organization_id JOIN conversations c ON c.id = m.conversation_id',
      `, m.author_kind, m.event_name, m.occurred_at,
       CASE WHEN m.event_name = '${MIRRORED_EVENT}' THEN json_extract(m.payload_json, '$.provider_inserted_at') END AS provider_time`,
      'm.sequence, mp.sort_order',
    ), params: [id, organizationId, ...guard.params, ...(role === 'guest' ? [userId] : [])] },
  ], { operation: 'Read conversation details' })
  const facts = factsResult!.results[0] as { support: number; blocked_at: string | null; archived_at: string | null; last_message_at: string; ends_at: string | null } | undefined
  if (!facts) conversationAccessDenied()
  const photoRows = photosResult!.results as (MessagePhotoRow & Pick<MessageRow, 'author_kind' | 'event_name' | 'occurred_at'> & { provider_time: string | null })[]
  const photos = photoRows.filter(row => !isEventMessage(row)).map(row => ({
    id: row.id, url: row.public_url, thumbnail_url: row.thumbnail_url ?? row.public_url, width: row.width, height: row.height,
    sent_at: row.event_name === MIRRORED_EVENT ? providerInstant(providerTimestamp(row.provider_time, `message:${row.owner_id}`, 'provider_inserted_at')) : row.occurred_at,
  })).sort((a, b) => b.sent_at.localeCompare(a.sent_at))
  const mailbox = resolveGuestThreadMailbox(facts, facts.ends_at === null ? null : { ends_at: facts.ends_at }, now.toISOString(), { lastMessageAt: facts.last_message_at }, role === 'member' ? 'member' : 'buyer')
  const canModerate = role === 'member' && conversation.kind !== 'team' && !facts.support
  return {
    photos,
    actions: {
      archive: mailbox.canArchive,
      unarchive: mailbox.canUnarchive,
      report: canModerate,
      block: canModerate && mailbox.mailbox !== 'blocked',
      unblock: canModerate && mailbox.mailbox === 'blocked',
    },
  }
}
