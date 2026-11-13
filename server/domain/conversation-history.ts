import { queryFirst, type DbClient } from '~/server/db'
import type { ConversationMessage, ConversationPage, ConversationViewerRole } from '~/shared/messages-contract'
import type { MemberAccessPrincipal } from '~/server/utils/member-access'
import { conversationAccessDenied, participantGuard, type ConversationRow, type ConversationWindow, type MessageRow } from './conversations'
import { conversationDeliveryReceipt, getInboxThread, readConversationParticipants } from './guest-threads/inbox'
import { getTeamThread, loadTeamMessageWindow, type TeamMessage } from './team-messages'

import { readConversationEnrichment, threadDeliveriesQuery } from './guest-threads/deliveries'
import { parseGuestRequest, participantLabel } from './requests'

/** The wire representation used for both pages and acknowledgements. */
export function projectTeamConversationMessage(message: TeamMessage, author: string): ConversationMessage {
  return {
    type: 'message', id: message.id, sequence: message.sequence, side: 'business', author_user_id: message.author_user_id,
    author, automatic: message.automatic, label: null, sent_at: message.created_at, time: null, body: message.body,
    photos: message.attachments, translated: null, unshown_files: 0, receipt: null, retryable: false, deliveries: message.deliveries,
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
  const [{ photos, deliveries }, authorized] = await Promise.all([
    readConversationEnrichment(db, ids, [], receiptQuery),
    queryFirst(db, `SELECT 1 FROM conversations c WHERE c.id = ? AND ${guard.sql}`, [conversation.id, ...guard.params]),
  ])
  if (!authorized) conversationAccessDenied()
  const attachments = (photos.get(message.id) ?? []).map(photo => ({
    id: photo.id, url: photo.url, thumbnail_url: photo.thumbnailUrl, width: photo.width, height: photo.height,
  }))
  const projectedDeliveries = conversation.kind === 'team'
    ? deliveries.map(({ id, channel, status, error, updated_at }) => ({ id, channel, status, error, updated_at }))
    : []
  const author = message.author_user_id === userId ? 'You' : senderName
  if (conversation.kind === 'team') return projectTeamConversationMessage({
    id: message.id, sequence: message.sequence, conversation_id: message.conversation_id, author_user_id: message.author_user_id,
    body: message.body ?? '', automatic: false, attachments, deliveries: projectedDeliveries, created_at: message.created_at,
  }, author)
  const receipt = role === 'member' && deliveries.length ? conversationDeliveryReceipt(deliveries, participantLabel(parseGuestRequest(conversation))) : null
  return {
    type: 'message', id: message.id, sequence: message.sequence, author_user_id: message.author_user_id, author,
    side: role === 'guest' ? 'guest' : 'business', automatic: false, sent_at: message.occurred_at, time: null,
    label: null, body: message.body, photos: attachments, translated: null, unshown_files: 0, receipt,
    retryable: receipt === 'Not delivered' && !attachments.length && Boolean(message.body?.trim()), deliveries: projectedDeliveries,
  }
}

/** The same cursor window and wire projection serve every Messages surface. */
export async function loadConversationPage(
  db: DbClient,
  input: { conversation: ConversationRow; userId: string; role: ConversationViewerRole; principal: MemberAccessPrincipal | null; readThrough: number | null },
  window: ConversationWindow,
): Promise<ConversationPage> {
  const { conversation, userId, role, principal, readThrough } = input
  const { id, organization_id: organizationId } = conversation
  const guard = participantGuard('c', userId, role)
  if (role === 'member' && !principal) conversationAccessDenied()
  if (conversation.kind === 'team') {
    if (!principal) conversationAccessDenied()
    const [thread, history] = await Promise.all([
      getTeamThread(db, principal, id, false),
      loadTeamMessageWindow(db, id, window, guard),
    ])
    const { participants, last_message: _lastMessage, ...header } = thread
    if (!participants.some(person => person.id === userId)) conversationAccessDenied()
    const names = new Map(participants.map(person => [person.id, person.name]))
    const title = header.name ?? participants.filter(person => person.id !== userId).map(person => person.name).join(', ')
    return {
      conversation: {
        ...header, kind: 'team', title: title || 'You', organization_id: organizationId,
        participants: participants.map(person => ({ ...person, role: 'member', can_remove: false })),
      },
      entries: history.messages.map(message => projectTeamConversationMessage(
        message,
        message.automatic ? 'Sent automatically' : message.author_user_id === userId ? 'You' : names.get(message.author_user_id ?? '') ?? 'Former member',
      )),
      page: {
        before: history.before, oldest: history.messages[0]?.sequence ?? null, newest: history.messages.at(-1)?.sequence ?? null,
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
    getInboxThread(db, id, organizationId, role === 'member' && principal
      ? { audience: 'member', userId, principal, conversation, guard }
      : { audience: 'buyer', userId, conversation, guard }, new Date(), window),
    readConversationParticipants(db, conversation, userId, role),
  ])
  if (!thread?.page || thread.kind === 'team' || !participants.some(person => person.id === userId && person.role === role)) conversationAccessDenied()
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
