import { HTTPError } from 'nitro'
import { executeBatch, queryFirst, type DbClient } from '~/server/db'
import type { ConversationEntriesPage, ConversationEntry, ConversationMessage, ConversationPage, ConversationViewerRole } from '~/shared/messages-contract'
import { accountActivityPath } from '~/shared/account-activity'
import { formatFormAnswer } from '~/shared/form-questions'
import {
  conversationAccessDenied, conversationAccessFromRow, conversationAccessQuery, conversationParticipantsSql, guestVisibleSql, isEventMessage, MEMBER_REPLY_EVENT, messageRole,
  MIRRORED_EVENT, OPENING_EVENT, parseMessagePayload, participantGuard, SCHEDULED_MESSAGE_EVENT, SUBMISSION_EVENT, SUPPORT_CONVERSATION_SQL,
  type ConversationAccessRow, type ConversationParticipantRow, type ConversationRow, type ConversationWindow, type MessageRow,
} from './conversations'
import { conversationDeliveryReceipt, conversationGuestName } from './guest-threads/inbox'
import { conversationGroupCapabilities } from './team-messages'
import { firstName, providerInstant } from './guest-threads/presentation'
import { conversationHistorySql, conversationMessage, groupConversationEntries, projectConversationHistory, type ConversationHistory, type HistoryRow } from './conversation-history-data'
import { readConversationEnrichment, threadDeliveriesQuery } from './guest-threads/deliveries'
import { parseGuestRequest, participantLabel } from './requests'

type TranscriptViewer = { conversationId: string; userId: string; organizationId?: string }
type MessageContext = Pick<ConversationHistory, 'photos' | 'deliveriesByMessage'>
type HistoryContext = { organization_name: string; timezone: string; booking_type: 'booking' | 'stay' | null; support: number; airbnb: number; roster: string | null }

function presentMessage(message: Pick<MessageRow, 'id' | 'sequence' | 'event_name'>, context: MessageContext, input: {
  author: string; viewerRole: ConversationViewerRole; guestName: string; authorUserId: string | null
  side: ConversationMessage['side']; body: string | null; sentAt: string; automatic: boolean; showAlerts: boolean
  unshownFiles?: number
}): ConversationMessage {
  const deliveries = input.viewerRole === 'member' ? context.deliveriesByMessage.get(message.id) : undefined
  const projected = conversationMessage({
    id: message.id, sequence: message.sequence, authorUserId: input.authorUserId, side: input.side, author: input.author,
    automatic: input.automatic, sentAt: input.sentAt, body: input.body, attachments: context.photos.get(message.id) ?? [],
    deliveries: input.showAlerts ? deliveries?.filter(delivery => delivery.purpose === 'owner_alert') : undefined,
    unshownFiles: input.unshownFiles,
  })
  if (deliveries) {
    projected.receipt = conversationDeliveryReceipt(deliveries, input.guestName)
    projected.retryable = projected.receipt === 'Not delivered' && message.event_name === MEMBER_REPLY_EVENT
      && !projected.photos.length && Boolean(projected.body?.trim())
  }
  return projected
}

/** Settle the optimistic send from the same projection used by history. */
export async function projectSentConversationMessage(
  db: DbClient,
  input: { message: MessageRow; userId: string; role: ConversationViewerRole; conversation: ConversationRow },
  senderName: string,
): Promise<ConversationMessage> {
  const { message, conversation, role, userId } = input
  if (message.conversation_id !== conversation.id || message.organization_id !== conversation.organization_id) conversationAccessDenied()
  const guard = participantGuard('c', userId, role)
  const ids = [message.id]
  const [photosAndDeliveries, authorized] = await Promise.all([
    readConversationEnrichment(db, ids, [], role === 'member' ? threadDeliveriesQuery(conversation.id, ids) : null),
    queryFirst(db, `SELECT 1 FROM conversations c WHERE c.id = ? AND ${guard.sql}`, [conversation.id, ...guard.params]),
  ])
  if (!authorized) conversationAccessDenied()
  return presentMessage(message, photosAndDeliveries, {
    author: message.author_user_id === userId ? 'You' : senderName, viewerRole: role,
    guestName: role === 'member' && conversation.kind !== 'team' ? participantLabel(parseGuestRequest(conversation)) : senderName,
    authorUserId: message.author_user_id, body: message.body, side: message.author_kind === 'guest' ? 'guest' : 'business',
    sentAt: message.occurred_at, automatic: false, showAlerts: conversation.kind === 'team',
  })
}

function entryText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function eventText(message: Pick<MessageRow, 'event_name' | 'body' | 'id'>, actor: string, guestName: string, buyer: boolean, airbnb: boolean): string {
  const name = message.event_name ?? ''
  const action = name.split('.').at(-1)
  const noun = name.startsWith('stay.') || airbnb ? 'reservation' : 'booking'
  if (name.startsWith('booking_change.') && (action === 'accepted' || action === 'declined' || action === 'withdrawn')) {
    return `${buyer ? 'Your' : `${guestName}’s`} change was ${action}${airbnb ? ' on Airbnb' : ''}`
  }
  if (action === 'guest_cancelled') return `${buyer ? 'You' : guestName} canceled the ${noun}`
  if (action === 'cancel' || action === 'cancelled') return `${actor} canceled the ${noun}`
  if (action === 'confirm' || action === 'confirmed') return `${actor} confirmed the ${noun}`
  if (action === 'reject') return `${actor} declined the ${noun}`
  if (action === 'no_show') return `${actor} marked the ${noun} as a no-show`
  if (name === 'review.requested') return 'Review invitation sent'
  const firstLine = entryText(message.body)?.split('\n')[0]?.trim()
  if (firstLine) return firstLine
  throw new HTTPError({ statusCode: 500, message: `The conversation activity ${name} has nothing to say`, data: { code: 'INVALID_CONVERSATION_EVENT', field: 'event_name', entry_id: message.id } })
}

function presentEntries(
  viewer: { conversation: ConversationRow; userId: string; role: ConversationViewerRole }, history: ConversationHistory,
  context: HistoryContext & { guestName: string; contactAnswers: string[] }, now: Date,
): ConversationEntry[] {
  const { conversation, userId, role } = viewer
  const { guestName, airbnb, contactAnswers } = context
  const guestViewer = role === 'guest'
  const items: Exclude<ConversationEntry, { type: 'day' }>[] = []
  let newestBusiness: ConversationMessage | undefined
  for (const message of history.entries) {
    const mirrored = message.event_name === MIRRORED_EVENT
    const scheduled = message.event_name === SCHEDULED_MESSAGE_EVENT
    const automatic = scheduled || (message.event_name === null && message.author_kind === 'krabiclaw')
    const opening = message.event_name === OPENING_EVENT || message.event_name === SUBMISSION_EVENT
    const authorKind = messageRole(message, conversation.user_id)
    const name = message.author_user_id === null ? null : history.actors.get(message.author_user_id) ?? null
    const mine = message.author_user_id === userId
    if (isEventMessage(message)) {
      const actor = authorKind === 'guest' ? guestViewer ? 'You' : guestName
        : mine ? 'You' : !guestViewer && name ? firstName(name) : context.organization_name
      items.push({ type: 'event', id: message.id, sequence: message.sequence, sent_at: message.occurred_at,
        text: eventText(message, actor, guestName, guestViewer, Boolean(airbnb)) })
      continue
    }
    const payload = parseMessagePayload(message)
    const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : null
    const support = mirrored && authorKind === 'krabiclaw'
    const providerName = mirrored && meta ? entryText(Reflect.get(meta, 'name')) : null
    const side = authorKind === 'guest' || opening || support ? 'guest' : 'business'
    const authorUserId = guestViewer && (!mine || authorKind !== 'guest') ? null : message.author_user_id
    const author = support ? providerName || 'Airbnb Support'
      : side === 'guest' ? guestViewer && (mine || opening) ? 'You' : providerName || (message.author_user_id !== conversation.user_id && name) || guestName
        : guestViewer ? context.organization_name
          : scheduled ? 'Automatic'
            : mine || mirrored ? 'You' : name ? (conversation.kind === 'team' ? name : firstName(name)) : message.author_kind === 'krabiclaw' ? 'Sent automatically' : 'Deleted account'
    const photos = history.photos.get(message.id)?.length ?? 0
    const links = mirrored && Array.isArray(payload.attachments) ? payload.attachments.length : 0
    const unshownFiles = Math.max(links - photos, 0) + (Array.isArray(payload.unshownFiles) ? payload.unshownFiles.length : 0)
    const body = message.event_name === SUBMISSION_EVENT && contactAnswers.length
      ? [entryText(message.body), ...contactAnswers].filter(Boolean).join('\n\n') || null
      : message.body
    if (!entryText(body) && !photos && !unshownFiles) continue
    const sentAt = mirrored && typeof payload.provider_inserted_at === 'string' ? providerInstant(payload.provider_inserted_at) : message.occurred_at
    const projected = presentMessage(message, history, { author, viewerRole: role, guestName, authorUserId, side, sentAt, body,
      automatic, showAlerts: conversation.kind === 'team', unshownFiles })
    if (side === 'business') {
      if (newestBusiness && newestBusiness.receipt !== 'Not delivered') newestBusiness.receipt = null
      newestBusiness = projected
    }
    items.push(projected)
  }
  return groupConversationEntries(items, context.timezone, now)
}

/** One authorization snapshot, indexed window and roster for web, native and MCP. */
export async function loadConversationPage(db: DbClient, viewer: TranscriptViewer, window: ConversationWindow & { before: null }, now?: Date): Promise<ConversationPage>
export async function loadConversationPage(db: DbClient, viewer: TranscriptViewer, window: ConversationWindow, now?: Date): Promise<ConversationPage | ConversationEntriesPage>
export async function loadConversationPage(
  db: DbClient, { conversationId, userId, organizationId }: TranscriptViewer, window: ConversationWindow, now = new Date(),
): Promise<ConversationPage | ConversationEntriesPage> {
  const head = window.before === null
  const access = conversationAccessQuery(userId, conversationId, organizationId)
  const historyQuery = conversationHistorySql(window, {
    query: `m.conversation_id = (SELECT id FROM authorized)
      AND ((SELECT viewer_role FROM authorized) = 'member' OR ${guestVisibleSql('m', '(SELECT user_id FROM authorized) = ?')})`,
    params: [userId],
  }, true)
  const [headerRows, messageRows] = await executeBatch(db, [{
    query: `WITH authorized AS MATERIALIZED (${access.query})
      SELECT c.*, o.name AS organization_name, COALESCE(l.timezone, o.timezone) AS timezone,
        ${head ? `CASE WHEN c.viewer_role = 'member' THEN ${SUPPORT_CONVERSATION_SQL('c')} ELSE 0 END` : '0'} AS support,
        CASE WHEN c.viewer_role = 'member' AND c.kind = 'booking'
          THEN EXISTS (SELECT 1 FROM channel_threads t WHERE t.conversation_id = c.id) OR COALESCE(b.owner = 'channel', 0)
          ELSE 0 END AS airbnb,
        ${head ? `CASE WHEN c.viewer_role = 'guest' AND b.owner = 'app' AND b.user_id = ? AND c.user_id = ?
          THEN CASE WHEN b.product_session_id IS NULL THEN 'stay' ELSE 'booking' END END` : 'NULL'} AS booking_type,
        ${head ? `(SELECT json_group_array(json_object('id', p.id, 'name', p.name, 'image', p.image, 'role', p.role))
          FROM (${conversationParticipantsSql('c', 'c.viewer_role')}) p)` : 'NULL'} AS roster
      FROM authorized c
      JOIN organization o ON o.id = c.organization_id
      LEFT JOIN business_locations l ON l.id = c.location_id AND l.organization_id = c.organization_id
      LEFT JOIN bookings b ON c.kind = 'booking' AND b.id = c.booking_id AND b.organization_id = c.organization_id`,
    params: [...(access.params ?? []), ...(head ? [userId, userId, userId, userId] : [])],
  }, {
    query: `WITH authorized AS MATERIALIZED (${access.query}), ${historyQuery.query.slice('WITH '.length)}`,
    params: [...(access.params ?? []), ...(historyQuery.params ?? [])],
  }], { operation: 'Read conversation' })
  const context = headerRows!.results[0] as (ConversationAccessRow & HistoryContext) | undefined
  if (!context) conversationAccessDenied()
  const { conversation, role, readThrough, membership } = conversationAccessFromRow(context, userId)
  const history = projectConversationHistory(messageRows!.results as HistoryRow[], window.limit)
  const thread = conversation.kind === 'team' ? null : parseGuestRequest(conversation)
  const guestName = thread ? conversationGuestName(thread, Boolean(context.support), Boolean(context.airbnb)) : context.organization_name
  const contactAnswers = thread?.kind === 'contact' && history.entries.some(entry => entry.event_name === SUBMISSION_EVENT)
    ? thread.payload.answers.map(answer => `${answer.label} ${formatFormAnswer(answer, { yes: 'Yes', no: 'No' })}`) : []
  const result = {
    entries: presentEntries({ conversation, userId, role }, history, { ...context, guestName, contactAnswers }, now),
    page: { ...history.page, read_through: readThrough },
  }
  if (!head) return { conversation_id: conversation.id, ...result }
  if (context.roster === null) throw new Error('Conversation roster was not read')
  const roster = JSON.parse(context.roster) as ConversationParticipantRow[]
  const bookingHost = role === 'member' && conversation.kind === 'booking' && conversation.booking_id !== null
  const activityPath = context.booking_type ? accountActivityPath(context.booking_type, conversation.id) : null
  const groupCapabilities = await conversationGroupCapabilities(membership, conversation)
  const title = role === 'guest' ? context.organization_name : conversation.name || (conversation.kind === 'team' ? null : guestName)
    || roster.filter(person => person.id !== userId).map(person => person.name).join(', ') || 'You'
  return {
    conversation: {
      id: conversation.id, organization_id: conversation.organization_id, title, kind: conversation.kind === 'team' ? 'team' : context.support ? 'support' : 'guest',
      name: conversation.name, is_group: conversation.is_group === 1,
      created_by_user_id: role === 'member' ? conversation.created_by_user_id : null,
      booking_id: role === 'member' || activityPath !== null ? conversation.booking_id : null,
      activity_path: activityPath,
      participants: roster.map(person => ({
        ...person, can_remove: bookingHost && person.role === 'guest' && person.id !== conversation.user_id,
      })),
      composer: { channel: conversation.kind === 'team' ? 'team' : context.airbnb ? 'airbnb' : 'email' },
    },
    ...result, viewer_role: role,
    capabilities: { ...groupCapabilities, can_invite_guest: bookingHost && conversation.blocked_at === null },
  }
}
