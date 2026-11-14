import { HTTPError } from 'nitro'
import { queryFirst, type DbClient } from '~/server/db'
import type { ConversationEntriesPage, ConversationEntry, ConversationMessage, ConversationPage, ConversationViewerRole } from '~/shared/messages-contract'
import type { MemberAccessPrincipal } from '~/server/utils/member-access'
import { accountActivityPath } from '~/shared/account-activity'
import { formatFormAnswer } from '~/shared/form-questions'
import {
  conversationAccessDenied, conversationParticipantsQuery, isEventMessage, MEMBER_REPLY_EVENT, messageRole,
  MIRRORED_EVENT, OPENING_EVENT, parseMessagePayload, participantGuard, SCHEDULED_MESSAGE_EVENT, SUBMISSION_EVENT,
  type ConversationParticipantRow, type ConversationRow, type ConversationWindow, type MessageRow,
} from './conversations'
import { conversationDeliveryReceipt, guestConversationNames } from './guest-threads/inbox'
import { conversationGroupCapabilities } from './team-messages'
import { guestNameColumns, type ThreadWideFacts } from './guest-threads/detail'
import { guestReplyAccountQuery, guestReplyDestination, type GuestReplyAccount } from './guest-threads/operations'
import { guestThreadChannelQuery, parseGuestThreadChannel, type GuestThreadChannelRow } from './guest-threads/channel-messages'
import { firstName, providerInstant } from './guest-threads/presentation'
import { conversationMessage, groupConversationEntries, readConversationHistory, type ConversationHistory } from './conversation-history-data'
import { readConversationEnrichment, threadDeliveriesQuery } from './guest-threads/deliveries'
import { parseGuestRequest, participantLabel } from './requests'

type ConversationViewer = { conversation: ConversationRow; userId: string; role: ConversationViewerRole; principal: MemberAccessPrincipal | null; readThrough: number | null }
type MessageContext = Pick<ConversationHistory, 'photos' | 'deliveriesByMessage'>
type HistoryContext = ThreadWideFacts & { name: string; timezone: string; booking_type: 'booking' | 'stay' | null }

function presentMessage(message: MessageRow, context: MessageContext, input: {
  author: string; viewerRole: ConversationViewerRole; guestName: string; authorUserId: string | null
  side: ConversationMessage['side']; body: string | null; sentAt: string; automatic: boolean; canReply: boolean; showAlerts: boolean
  label?: string | null; unshownFiles?: number
}): ConversationMessage {
  const deliveries = input.viewerRole === 'member' ? context.deliveriesByMessage.get(message.id) : undefined
  const projected = conversationMessage({
    id: message.id, sequence: message.sequence, authorUserId: input.authorUserId, side: input.side, author: input.author,
    automatic: input.automatic, sentAt: input.sentAt, body: input.body, attachments: context.photos.get(message.id) ?? [],
    deliveries: input.showAlerts ? deliveries?.filter(delivery => delivery.purpose === 'owner_alert') : undefined,
    label: input.label, unshownFiles: input.unshownFiles,
  })
  if (deliveries) {
    projected.receipt = conversationDeliveryReceipt(deliveries, input.guestName)
    projected.retryable = input.canReply && projected.receipt === 'Not delivered' && message.event_name === MEMBER_REPLY_EVENT
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
    sentAt: message.occurred_at, automatic: false, canReply: true, showAlerts: conversation.kind === 'team',
  })
}

function entryText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function eventText(message: MessageRow, actor: string, guestName: string, buyer: boolean, airbnb: boolean): string {
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
  viewer: ConversationViewer, history: ConversationHistory,
  context: HistoryContext & { guestName: string; airbnb: boolean; canReply: boolean; contactAnswers: string[] }, now: Date,
): ConversationEntry[] {
  const { conversation, userId, role } = viewer
  const { guestName, airbnb, canReply, contactAnswers } = context
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
        : mine ? 'You' : !guestViewer && name ? firstName(name) : context.name
      items.push({ type: 'event', id: message.id, sequence: message.sequence, sent_at: message.occurred_at,
        text: eventText(message, actor, guestName, guestViewer, airbnb) })
      continue
    }
    const payload = parseMessagePayload(message)
    const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : null
    const support = mirrored && authorKind === 'krabiclaw'
    const side = authorKind === 'guest' || opening || support ? 'guest' : 'business'
    const authorUserId = guestViewer && (!mine || authorKind !== 'guest') ? null : message.author_user_id
    const author = support ? (meta && entryText(Reflect.get(meta, 'name'))) || 'Airbnb Support'
      : side === 'guest' ? guestViewer && (mine || opening) ? 'You' : (message.author_user_id !== conversation.user_id && name) || guestName
        : guestViewer ? context.name
          : scheduled ? history.automaticOwner ? `${firstName(history.automaticOwner)} · Automatic` : 'Automatic'
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
      automatic, canReply, showAlerts: conversation.kind === 'team',
      label: scheduled ? history.templateTitles.get(message.id) : undefined, unshownFiles })
    if (side === 'business') {
      if (newestBusiness && newestBusiness.receipt !== 'Not delivered') newestBusiness.receipt = null
      newestBusiness = projected
    }
    items.push(projected)
  }
  return groupConversationEntries(items, context.timezone, now)
}

async function readPage(db: DbClient, viewer: ConversationViewer, window: ConversationWindow, header: boolean, now: Date) {
  const { conversation, userId, role, principal } = viewer
  const { id, organization_id: organizationId } = conversation
  if ((role === 'member' && (!principal || principal.userId !== userId || principal.organizationId !== organizationId))
    || (role === 'guest' && conversation.kind === 'team')) conversationAccessDenied()
  const guard = participantGuard('c', userId, role)
  const thread = conversation.kind === 'team' ? null : parseGuestRequest(conversation)
  const routeReply = thread !== null && role === 'member'
  const channelQuery = routeReply && conversation.kind === 'booking' ? guestThreadChannelQuery(id, organizationId) : null
  const accountId = routeReply && !thread.payload.guest.email?.trim() ? thread.user_id : null
  const buyerBooking = header && role === 'guest' && conversation.kind === 'booking'
    && conversation.user_id === userId && conversation.booking_id !== null
  const history = await readConversationHistory(db, id, { guestUserId: role === 'guest' ? userId : null, guard }, window, [{
    query: `SELECT o.name, COALESCE(l.timezone, o.timezone) AS timezone,
        ${channelQuery ? guestNameColumns('c') : '0 AS support, NULL AS channel_guest_name'},
        ${buyerBooking ? `(SELECT CASE WHEN b.product_session_id IS NULL THEN 'stay' ELSE 'booking' END FROM bookings b
          WHERE b.id = c.booking_id AND b.organization_id = c.organization_id AND b.user_id = c.user_id AND b.owner = 'app')` : 'NULL'} AS booking_type
      FROM conversations c
      JOIN organization o ON o.id = c.organization_id
      LEFT JOIN business_locations l ON l.id = c.location_id AND l.organization_id = c.organization_id
      WHERE c.id = ? AND c.organization_id = ? AND ${guard.sql}`,
    params: [id, organizationId, ...guard.params],
  }, ...(channelQuery ? [channelQuery] : []), ...(accountId ? [guestReplyAccountQuery(accountId)] : []),
  ...(header ? [conversationParticipantsQuery(conversation, userId, role)] : [])])
  const context = history.context[0]?.results[0] as HistoryContext | undefined
  if (!context) conversationAccessDenied()
  const roster = (header ? history.context.at(-1)?.results : undefined) as ConversationParticipantRow[] | undefined
  const channelRow = channelQuery ? history.context[1]?.results[0] as GuestThreadChannelRow | undefined : null
  if (channelQuery && !channelRow) conversationAccessDenied()
  const account = accountId ? history.context[channelQuery ? 2 : 1]?.results[0] as GuestReplyAccount | undefined : null
  const channelFacts = channelRow ? parseGuestThreadChannel(channelRow) : { productId: null, mapping: null, connected: false, booking: null }
  const channel: ConversationPage['conversation']['channel'] = channelFacts.productId !== null ? 'airbnb' : 'direct'
  const names = thread ? guestConversationNames(thread, context, channel) : null
  const destination = routeReply ? await guestReplyDestination(db, thread, channelFacts, account ?? null) : null
  const activityPath = context.booking_type ? accountActivityPath(context.booking_type, id) : null
  const canReply = !routeReply || (destination !== null && destination.channel !== null)
  const contactAnswers = thread?.kind === 'contact' && history.entries.some(entry => entry.event_name === SUBMISSION_EVENT)
    ? thread.payload.answers.map(answer => `${answer.label} ${formatFormAnswer(answer, { yes: 'Yes', no: 'No' })}`) : []
  return {
    entries: presentEntries(viewer, history, { ...context, guestName: names?.title ?? context.name, airbnb: channel === 'airbnb', canReply, contactAnswers }, now),
    page: { ...history.page, read_through: viewer.readThrough },
    context, roster, names, channel, destination, activityPath, canReply,
  }
}

export async function loadEarlierConversationEntries(db: DbClient, viewer: ConversationViewer, window: ConversationWindow): Promise<ConversationEntriesPage> {
  const { entries, page } = await readPage(db, viewer, window, false, new Date())
  return { conversation_id: viewer.conversation.id, entries, page }
}

/** One authorization, cursor, and message projection serve every conversation. */
export async function loadConversationPage(
  db: DbClient,
  viewer: ConversationViewer,
  window: ConversationWindow = { before: null, limit: 40 },
  now = new Date(),
): Promise<ConversationPage> {
  const { conversation, userId, role, principal } = viewer
  const { entries, page, context, roster, names, channel, destination, activityPath, canReply } = await readPage(db, viewer, window, true, now)
  if (!roster?.some(person => person.id === userId && person.role === role)) conversationAccessDenied()
  const bookingHost = role === 'member' && conversation.kind === 'booking' && conversation.booking_id !== null
  const groupCapabilities = await conversationGroupCapabilities(principal, conversation)
  const title = role === 'guest' ? context.name : conversation.name || names?.title
    || roster.filter(person => person.id !== userId).map(person => person.name).join(', ') || 'You'
  return {
    conversation: {
      id: conversation.id, organization_id: conversation.organization_id, title, kind: names?.kind ?? 'team',
      name: conversation.name, channel, is_group: conversation.is_group === 1,
      created_by_user_id: role === 'member' ? conversation.created_by_user_id : null,
      booking_id: role === 'member' || activityPath !== null ? conversation.booking_id : null,
      location_id: role === 'member' ? conversation.location_id : null,
      activity_path: activityPath,
      participants: roster.map(({ membership_role: _, ...person }) => ({
        ...person, can_remove: bookingHost && person.role === 'guest' && person.id !== conversation.user_id,
      })),
      composer: {
        channel: conversation.kind === 'team' ? 'team' : channel === 'airbnb' ? 'airbnb' : 'email',
        reason: destination?.channel === null ? destination.reason : null,
      },
    },
    entries, page, viewer_role: role,
    capabilities: { ...groupCapabilities, can_send: canReply, can_invite_guest: bookingHost && conversation.blocked_at === null },
  }
}
