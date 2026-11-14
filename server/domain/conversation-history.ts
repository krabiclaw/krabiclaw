import { queryFirst, type DbClient } from '~/server/db'
import type { ConversationEntriesPage, ConversationMessage, ConversationPage, ConversationViewerRole } from '~/shared/messages-contract'
import type { MemberAccessPrincipal } from '~/server/utils/member-access'
import { conversationAccessDenied, conversationParticipantsQuery, participantGuard, unreadSql, type ConversationParticipantRow, type ConversationRow, type ConversationWindow, type MessageRow } from './conversations'
import { conversationDeliveryReceipt, projectGuestConversation } from './guest-threads/inbox'
import { presentGroupConversation } from './team-messages'
import { guestHistoryContext } from './guest-threads/detail'
import { conversationMessage, groupConversationEntries, readConversationHistory, type ConversationHistory } from './conversation-history-data'

import { readConversationEnrichment, threadDeliveriesQuery } from './guest-threads/deliveries'
import { parseGuestRequest, participantLabel } from './requests'

type MessageEnrichment = Awaited<ReturnType<typeof readConversationEnrichment>>
type ConversationViewer = { conversation: ConversationRow; userId: string; role: ConversationViewerRole; principal: MemberAccessPrincipal | null; readThrough: number | null }

function projectMessage(message: MessageRow, author: string, enrichment: Pick<MessageEnrichment, 'photos' | 'deliveriesByMessage'>, team: boolean): ConversationMessage {
  return conversationMessage({
    id: message.id, sequence: message.sequence, side: message.author_kind === 'guest' ? 'guest' : 'business', authorUserId: message.author_user_id,
    author, automatic: message.author_kind === 'krabiclaw', sentAt: message.occurred_at, body: message.body,
    attachments: enrichment.photos.get(message.id) ?? [], deliveries: team ? enrichment.deliveriesByMessage.get(message.id) : undefined,
  })
}

/** Settle the optimistic send with its exact canonical row and bounded enrichment. */
export async function projectSentConversationMessage(
  db: DbClient,
  input: { message: MessageRow; userId: string; role: ConversationViewerRole; conversation: ConversationRow },
  senderName: string,
): Promise<ConversationMessage> {
  const { message, conversation, role, userId } = input
  if (message.conversation_id !== conversation.id || message.organization_id !== conversation.organization_id) conversationAccessDenied()
  const guard = participantGuard('c', userId, role)
  const ids = [message.id]
  const receiptQuery = role === 'member' ? threadDeliveriesQuery(conversation.id, ids, conversation.kind === 'team' ? 'owner_alert' : undefined) : null
  const [enrichment, authorized] = await Promise.all([
    readConversationEnrichment(db, ids, [], receiptQuery),
    queryFirst(db, `SELECT 1 FROM conversations c WHERE c.id = ? AND ${guard.sql}`, [conversation.id, ...guard.params]),
  ])
  if (!authorized) conversationAccessDenied()
  const author = message.author_user_id === userId ? 'You' : senderName
  const projected = projectMessage(message, author, enrichment, conversation.kind === 'team')
  const deliveries = enrichment.deliveriesByMessage.get(message.id)
  if (conversation.kind !== 'team' && role === 'member' && deliveries) {
    projected.receipt = conversationDeliveryReceipt(deliveries, participantLabel(parseGuestRequest(conversation)))
    projected.retryable = projected.receipt === 'Not delivered' && !projected.photos.length && Boolean(message.body?.trim())
  }
  return projected
}

function internalEntries(history: ConversationHistory, userId: string, now: Date) {
  const org = history.context[0]?.results[0] as { timezone: string } | undefined
  if (!org) throw new Error('Conversation has no organization')
  return groupConversationEntries(history.entries.map(message => projectMessage(
    message, message.author_user_id === userId ? 'You'
      : message.author_kind === 'krabiclaw' ? 'Sent automatically' : history.actors.get(message.author_user_id ?? '') ?? 'Former member',
    history, true,
  )), org.timezone, now)
}

const timezoneQuery = (organizationId: string) => ({ query: 'SELECT timezone FROM organization WHERE id = ?', params: [organizationId] })

export async function loadEarlierConversationEntries(db: DbClient, viewer: ConversationViewer, window: ConversationWindow): Promise<ConversationEntriesPage> {
  const { conversation, userId, role, principal, readThrough } = viewer
  const guestUserId = role === 'guest' ? userId : null
  const guard = participantGuard('c', userId, role)
  const [organization, ...contextQueries] = conversation.kind === 'team'
    ? [timezoneQuery(conversation.organization_id)] : guestHistoryContext(conversation, guestUserId, window)
  const history = readConversationHistory(db, conversation.id, { guestUserId, guard, kind: conversation.kind }, window, [{
    query: `${organization!.query} AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = ? AND ${guard.sql})`,
    params: [...(organization!.params ?? []), conversation.id, ...guard.params],
  }, ...contextQueries])
  const { context, page } = await history
  if (!context[0]?.results.length) conversationAccessDenied()
  const entries = conversation.kind === 'team' ? internalEntries(await history, userId, new Date())
    : (await projectGuestConversation(db, conversation, principal
      ? { audience: 'member', userId, principal } : { audience: 'buyer', userId }, new Date(), window, history, false))?.stream
  if (!entries) conversationAccessDenied()
  return { conversation_id: conversation.id, entries, page: { ...page, read_through: readThrough } }
}

/** The same cursor window and wire projection serve every Messages surface. */
export async function loadConversationPage(
  db: DbClient,
  input: ConversationViewer,
  window?: ConversationWindow,
  now = new Date(),
): Promise<ConversationPage> {
  const { conversation, userId, role, principal, readThrough } = input
  const { id, organization_id: organizationId } = conversation
  const guard = participantGuard('c', userId, role)
  if (role === 'member' && (!principal || principal.userId !== userId || principal.organizationId !== organizationId)) conversationAccessDenied()
  if (role === 'guest' && conversation.kind === 'team') conversationAccessDenied()
  const guestUserId = role === 'guest' ? userId : null
  const unread = unreadSql('c', userId, readThrough)
  const history = readConversationHistory(db, id, { guestUserId, guard, kind: conversation.kind }, window, [
    ...(conversation.kind === 'team' ? [timezoneQuery(organizationId), {
      query: `SELECT ${unread.sql} AS unread FROM (SELECT ? AS id, ? AS user_id) c`,
      params: [...unread.params, id, conversation.user_id],
    }] : guestHistoryContext(conversation, guestUserId, window)),
    conversationParticipantsQuery(conversation, userId, role),
  ])
  const [loaded, guestThread] = await Promise.all([history, conversation.kind === 'team' ? null
    : projectGuestConversation(db, conversation, role === 'member' && principal
      ? { audience: 'member', userId, principal } : { audience: 'buyer', userId }, now, window, history)])
  const roster = loaded.context.at(-1)!.results as ConversationParticipantRow[]
  if (!roster.some(person => person.id === userId && person.role === role)) conversationAccessDenied()
  if (conversation.kind === 'team') {
    if (!principal) conversationAccessDenied()
    const { unread } = loaded.context[1]!.results[0] as { unread: number }
    const thread = await presentGroupConversation(principal, conversation, roster, unread === 1)
    const { participants, ...header } = thread
    const title = header.name ?? participants.filter(person => person.id !== userId).map(person => person.name).join(', ')
    return {
      conversation: {
        ...header, kind: 'team', title: title || 'You', organization_id: organizationId,
        participants: participants.map(person => ({ ...person, role: 'member', can_remove: false })),
      },
      entries: internalEntries(loaded, userId, now),
      page: { ...loaded.page, read_through: readThrough },
      viewer_role: role,
      capabilities: {
        can_send: true, can_manage_participants: header.can_manage, can_invite_guest: false,
        can_leave: header.can_leave, can_view_read_receipts: true,
      },
    }
  }
  const thread = guestThread
  if (!thread) conversationAccessDenied()
  const { stream, page, ...header } = thread
  const bookingHost = role === 'member' && conversation.kind === 'booking' && conversation.booking_id !== null
  return {
    conversation: {
      ...header, kind: thread.kind, organization_id: organizationId,
      participants: roster.map(({ membership_role: _, ...person }) => ({
        ...person, can_remove: bookingHost && person.role === 'guest' && person.id !== conversation.user_id,
      })),
    },
    entries: stream, page: { ...page, read_through: readThrough }, viewer_role: role,
    capabilities: {
      can_send: header.composer.available, can_manage_participants: false,
      can_invite_guest: bookingHost && conversation.blocked_at === null,
      can_leave: false, can_view_read_receipts: role === 'member',
    },
  }
}
