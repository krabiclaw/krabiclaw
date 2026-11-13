import { queryFirst, type DbClient } from '~/server/db'
import type { ConversationMessage, ConversationPage, ConversationViewerRole } from '~/shared/messages-contract'
import type { MemberAccessPrincipal } from '~/server/utils/member-access'
import { conversationAccessDenied, participantGuard, type ConversationRow, type ConversationWindow, type MessageRow } from './conversations'
import { conversationDeliveryReceipt, projectGuestConversation, readConversationParticipants } from './guest-threads/inbox'
import { getTeamThread } from './team-messages'
import { guestHistoryContext } from './guest-threads/detail'
import { enrichConversationHistory, readConversationHistory } from './conversation-history-data'

import { readConversationEnrichment, threadDeliveriesQuery } from './guest-threads/deliveries'
import { parseGuestRequest, participantLabel } from './requests'

type MessageEnrichment = Awaited<ReturnType<typeof readConversationEnrichment>>

function projectMessage(message: MessageRow, author: string, enrichment: MessageEnrichment, team: boolean): ConversationMessage {
  return {
    type: 'message', id: message.id, sequence: message.sequence, side: message.author_kind === 'guest' ? 'guest' : 'business', author_user_id: message.author_user_id,
    author, automatic: message.author_kind === 'krabiclaw', label: null, sent_at: team ? message.created_at : message.occurred_at, time: null,
    body: team ? message.body ?? '' : message.body,
    photos: (enrichment.photos.get(message.id) ?? []).map(photo => ({
      id: photo.id, url: photo.url, thumbnail_url: photo.thumbnailUrl, width: photo.width, height: photo.height,
    })),
    translated: null, unshown_files: 0, receipt: null, retryable: false,
    deliveries: team ? (enrichment.deliveriesByMessage.get(message.id) ?? []).map(({ id, channel, status, error, updated_at }) => ({ id, channel, status, error, updated_at })) : [],
  }
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

/** The same cursor window and wire projection serve every Messages surface. */
export async function loadConversationPage(
  db: DbClient,
  input: { conversation: ConversationRow; userId: string; role: ConversationViewerRole; principal: MemberAccessPrincipal | null; readThrough: number | null },
  window?: ConversationWindow,
  now = new Date(),
): Promise<ConversationPage> {
  const { conversation, userId, role, principal, readThrough } = input
  const { id, organization_id: organizationId } = conversation
  const guard = participantGuard('c', userId, role)
  if (role === 'member' && (!principal || principal.userId !== userId || principal.organizationId !== organizationId)) conversationAccessDenied()
  if (role === 'guest' && conversation.kind === 'team') conversationAccessDenied()
  const guestUserId = role === 'guest' ? userId : null
  const history = readConversationHistory(db, id, { guestUserId, guard }, window,
    conversation.kind === 'team' ? [] : guestHistoryContext(conversation, guestUserId, window))
  if (conversation.kind === 'team') {
    if (!principal) conversationAccessDenied()
    const [thread, { entries, page }, enrichment] = await Promise.all([
      getTeamThread(db, principal, id),
      history,
      history.then(({ entries }) => enrichConversationHistory(db, conversation, entries, null, window)),
    ])
    const { participants, ...header } = thread
    if (!participants.some(person => person.id === userId)) conversationAccessDenied()
    const names = new Map(participants.map(person => [person.id, person.name]))
    const title = header.name ?? participants.filter(person => person.id !== userId).map(person => person.name).join(', ')
    return {
      conversation: {
        ...header, kind: 'team', title: title || 'You', organization_id: organizationId,
        participants: participants.map(person => ({ ...person, role: 'member', can_remove: false })),
      },
      entries: entries.map(message => projectMessage(
        message, message.author_kind === 'krabiclaw' ? 'Sent automatically' : message.author_user_id === userId ? 'You' : names.get(message.author_user_id ?? '') ?? 'Former member',
        enrichment, true,
      )),
      page: {
        ...page,
        read_through: readThrough, failed_messages: [], booking_actions: [],
      },
      viewer_role: role,
      capabilities: {
        can_send: true, can_manage_participants: header.can_manage, can_invite_guest: false,
        can_leave: header.can_leave, can_view_read_receipts: true,
      },
    }
  }
  const [thread, participants] = await Promise.all([
    projectGuestConversation(db, conversation, role === 'member' && principal
      ? { audience: 'member', userId, principal }
      : { audience: 'buyer', userId }, now, window, history),
    readConversationParticipants(db, conversation, userId, role),
  ])
  if (!thread || thread.kind === 'team' || !participants.some(person => person.id === userId && person.role === role)) conversationAccessDenied()
  const { stream, page, ...header } = thread
  const bookingHost = role === 'member' && conversation.kind === 'booking' && conversation.booking_id !== null
  return {
    conversation: {
      ...header, kind: thread.kind, organization_id: organizationId,
      participants: participants.map(({ membership_role: _, ...person }) => ({
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
