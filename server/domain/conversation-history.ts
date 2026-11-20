import { roleMatchesSql, workspaceOperationsRoles } from '~/utils/organization-access'
import { HTTPError } from 'nitro'
import { executeBatch, queryFirst, type DbClient } from '~/server/db'
import { PLATFORM_MESSAGE_AUTHOR_KINDS_SQL, isPlatformMessageAuthor, type ConversationEntriesPage, type ConversationEntry, type ConversationHeader, type ConversationMessage, type ConversationPage, type ConversationViewerRole } from '~/shared/messages-contract'
import { accountActivityPath } from '~/shared/account-activity'
import { formatFormAnswer } from '~/shared/form-questions'
import type { ProductKind } from '~/shared/product-details'
import { formatCalendarRange } from '~/utils/timezone'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import { assignedMemberSql, bookingOperationsScope, roleAllows } from '~/server/utils/member-access'
import {
  conversationAccessDenied, conversationAccessFromRow, conversationAccessQuery, conversationParticipantsSql, guestVisibleSql, isEventMessage, MEMBER_REPLY_EVENT, messageRole,
  MIRRORED_EVENT, OPENING_EVENT, parseMessagePayload, participantGuard, SCHEDULED_MESSAGE_EVENT, SUBMISSION_EVENT, SUPPORT_CONVERSATION_SQL,
  type ConversationAccessRow, type ConversationParticipantRow, type ConversationRow, type ConversationWindow, type MessageRow,
} from './conversations'
import { conversationDeliveryReceipt, conversationGuestName } from './guest-threads/inbox'
import { conversationGroupCapabilities } from './team-messages'
import { calendarDate, firstName, providerInstant, transcriptDays } from './guest-threads/presentation'
import { conversationHistorySql, conversationMessage, groupConversationEntries, projectConversationHistory, type ConversationHistory, type HistoryRow } from './conversation-history-data'
import { readConversationEnrichment, threadDeliveriesQuery } from './guest-threads/deliveries'
import { bookingDay, parseGuestRequest, participantLabel } from './requests'
import { jobBookingIdSql, jobPostMatchSql, taskScopeSql } from './tasks'

type TranscriptViewer = { conversationId: string; userId: string; organizationId?: string }
type MessageContext = Pick<ConversationHistory, 'photos' | 'deliveriesByMessage'>
type HistoryContext = { organization_name: string; timezone: string; record_title: string | null; place_product_id: string | null; place_location_id: string | null; booking_type: 'booking' | 'stay' | null; booking_assigned: number; support: number; airbnb: number; roster: string | null; jobs: string | null; review: number | null; reservation: string | null }

type ConversationJob = { task_id: string; version: number; message_id: string | null }

type ReservationFacts = {
  created_at: string; starts_at: string; ends_at: string; timezone: string; party_size: number; status: string; stay: 0 | 1; product_kind: ProductKind; vertical: string | null
  confirmation: { at: string; message_id: string; event: 'booking.confirm' | 'payment.payment_captured' } | null
}

function reservationInThread(context: HistoryContext, viewer: { conversation: ConversationRow; role: ConversationViewerRole }, now: Date): ConversationHeader['reservation'] {
  if (!context.reservation) return undefined
  const facts = JSON.parse(context.reservation) as ReservationFacts
  const { role, conversation } = viewer
  const at = facts.confirmation?.at ?? facts.created_at
  const dayFormat = transcriptDays(context.timezone, now)
  const instant = new Date(at)
  const day = dayFormat.date(instant)
  let confirmation = null
  if (facts.status === 'confirmed' && conversation.kind === 'booking') {
    const from = bookingDay(facts.starts_at, facts.timezone)
    const dates = facts.stay ? formatCalendarRange(from, bookingDay(facts.ends_at, facts.timezone), 'en-US') : calendarDate(from)
    // A stay is a reservation of guests; anything else is named as its business names it: a law firm's consultation of clients.
    const words = facts.stay ? null : resolveBookingPresentation(facts.product_kind, facts.vertical)
    const party = words ? words.formatCount(facts.party_size) : `${facts.party_size} ${facts.party_size === 1 ? 'guest' : 'guests'}`
    const subject = role === 'guest' ? `Your ${words?.noun ?? 'reservation'} is confirmed` : `${words?.label ?? 'Reservation'} confirmed`
    confirmation = { message_id: facts.confirmation?.event === 'booking.confirm' ? facts.confirmation.message_id : null, text: `${subject} for ${party} on ${dates}.` }
  }
  return { at, day: { type: 'day', id: `day:${day.key}`, label: dayFormat.label(instant, day) }, confirmation }
}

function presentMessage(message: Pick<MessageRow, 'id' | 'sequence' | 'event_name' | 'author_kind'>, context: MessageContext, input: {
  author: string; viewerRole: ConversationViewerRole; guestName: string; authorUserId: string | null
  side: ConversationMessage['side']; body: string | null; sentAt: string; automatic: boolean; showAlerts: boolean
  unshownFiles?: number
}): ConversationMessage {
  const deliveries = input.viewerRole === 'member' ? context.deliveriesByMessage.get(message.id) : undefined
  const projected = conversationMessage({
    id: message.id, sequence: message.sequence, authorUserId: input.authorUserId, authorKind: message.author_kind, side: input.side, author: input.author,
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
  // An agreement's record reads as its actor's own act: "Eva signed the rental agreement".
  if (name.startsWith('agreement.')) {
    const act = entryText(message.body)
    if (!act) throw new HTTPError({ statusCode: 500, message: `The agreement activity ${name} has nothing to say`, data: { code: 'INVALID_CONVERSATION_EVENT', field: 'body', entry_id: message.id } })
    return `${actor} ${act.charAt(0).toLowerCase()}${act.slice(1)}`
  }
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
    const automatic = scheduled || (message.event_name === null && isPlatformMessageAuthor(message.author_kind))
    const opening = message.event_name === OPENING_EVENT || message.event_name === SUBMISSION_EVENT
    const authorKind = messageRole(message, conversation.user_id)
    const name = message.author_user_id === null ? null : history.actors.get(message.author_user_id) ?? null
    const mine = message.author_user_id === userId
    if (isEventMessage(message)) {
      // Every party to an agreement signs as themselves, so its record names each one.
      const actor = message.event_name?.startsWith('agreement.') ? mine ? 'You' : name ? firstName(name) : authorKind === 'guest' ? guestName : context.organization_name
        : authorKind === 'guest' ? guestViewer ? 'You' : guestName
        : mine ? 'You' : !guestViewer && name ? firstName(name) : context.organization_name
      items.push({ type: 'event', id: message.id, sequence: message.sequence, sent_at: message.occurred_at,
        text: eventText(message, actor, guestName, guestViewer, Boolean(airbnb)), ...(message.event_name === 'agreement.sent' ? { agreement: true as const } : {}) })
      continue
    }
    const payload = parseMessagePayload(message)
    const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : null
    const support = mirrored && isPlatformMessageAuthor(authorKind)
    const providerName = mirrored && meta ? entryText(Reflect.get(meta, 'name')) : null
    const side = authorKind === 'guest' || opening || support ? 'guest' : 'business'
    const authorUserId = guestViewer && (!mine || authorKind !== 'guest') ? null : message.author_user_id
    const author = support ? providerName || 'Airbnb Support'
      : side === 'guest' ? guestViewer && (mine || opening) ? 'You' : providerName || (message.author_user_id !== conversation.user_id && name) || guestName
        : guestViewer ? context.organization_name
          : scheduled ? 'Automatic'
            : mine || mirrored ? 'You' : name ? (conversation.kind === 'team' ? name : firstName(name)) : isPlatformMessageAuthor(message.author_kind) ? 'Sent automatically' : 'Deleted account'
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
    projected.job = isPlatformMessageAuthor(message.author_kind) && typeof payload.key === 'string' && payload.key.startsWith('job:')
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
export async function loadConversationPage(db: DbClient, viewer: TranscriptViewer, window: ConversationWindow & { before: number }, now?: Date): Promise<ConversationEntriesPage>
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
        CASE WHEN c.viewer_role = 'member' THEN ${SUPPORT_CONVERSATION_SQL('c')} ELSE 0 END AS support,
        CASE WHEN c.viewer_role = 'member' AND c.kind = 'booking'
          THEN EXISTS (SELECT 1 FROM channel_threads t WHERE t.conversation_id = c.id) OR COALESCE(b.owner = 'channel', 0)
          ELSE 0 END AS airbnb,
        ${head ? `CASE WHEN c.viewer_role = 'guest' AND b.owner = 'app' AND b.user_id = ? AND c.user_id = ?
          THEN CASE WHEN b.product_session_id IS NULL THEN 'stay' ELSE 'booking' END END` : 'NULL'} AS booking_type,
        ${head ? `(c.viewer_role = 'member' AND EXISTS (SELECT 1 FROM product_booking_configs cfg
          WHERE cfg.organization_id = b.organization_id AND cfg.product_id = b.product_id AND ${assignedMemberSql('cfg')}))` : '0'} AS booking_assigned,
        ${head ? `(SELECT json_group_array(json_object('id', p.id, 'name', p.name, 'image', p.image, 'role', p.role, 'title', p.title, 'invitation_id', p.invitation_id))
          FROM (${conversationParticipantsSql('c', 'c.viewer_role')}) p)` : 'NULL'} AS roster,
        -- What a team conversation about a booking is titled by: the home or offering, as its row in the list is.
        ${head ? `CASE WHEN c.kind = 'team' THEN (SELECT COALESCE(sc.internal_name, p.name) FROM bookings about JOIN products p ON p.organization_id = about.organization_id AND p.id = about.product_id
          LEFT JOIN product_stay_configs sc ON sc.organization_id = p.organization_id AND sc.product_id = p.id
          WHERE about.organization_id = c.organization_id AND about.id = c.booking_id) END` : 'NULL'} AS record_title,
        -- A job action belongs to its latest assignment post in the current team's conversation.
        ${head ? `CASE WHEN c.viewer_role = 'member' AND (c.booking_id IS NOT NULL OR (c.kind = 'team' AND c.location_id IS NOT NULL)) THEN (
          SELECT json_group_array(json_object('task_id', job.task_id, 'version', job.version, 'message_id', job.message_id))
          FROM (
            SELECT t.id AS task_id, t.version, CASE WHEN c.kind = 'team' AND EXISTS (
              SELECT 1 FROM conversation_participants seat JOIN member assigned
                ON assigned.id = t.assigned_member_id AND assigned.organizationId = seat.organization_id AND assigned.userId = seat.user_id
              WHERE seat.conversation_id = c.id AND seat.role = 'member'
            ) THEN (SELECT m.id FROM messages m WHERE m.conversation_id = c.id AND m.author_kind IN (${PLATFORM_MESSAGE_AUTHOR_KINDS_SQL})
              AND ${jobPostMatchSql('t', 'm')} ORDER BY m.sequence DESC LIMIT 1) END AS message_id
            FROM tasks t WHERE t.organization_id = c.organization_id AND t.status = 'open'
              -- A booking's jobs, or a repair in its place's team conversation.
              AND ((t.kind IN ('turnover', 'consultation_follow_up', 'consultation_prep') AND (${jobBookingIdSql('t')}) = c.booking_id)
                OR (t.kind = 'maintenance' AND c.kind = 'team' AND c.booking_id IS NULL AND t.location_id = c.location_id))
              AND (c.kind = 'team' OR c.member_id = t.assigned_member_id OR (t.assigned_member_id IS NULL AND c.member_role IN ('owner', 'admin')))
              AND ${taskScopeSql('t', () => ({
                organization: 'c.organization_id', user: '?', member: 'c.member_id', organizationWide: roleMatchesSql('c.member_role', workspaceOperationsRoles),
              }))}
            ORDER BY t.created_at, t.id
          ) job
        ) END` : 'NULL'} AS jobs,
        ${head ? `CASE WHEN c.viewer_role = 'member' AND c.kind = 'booking' THEN COALESCE(b.status = 'pending', 0) OR EXISTS (SELECT 1 FROM tasks ch
          WHERE ch.organization_id = c.organization_id AND ch.kind = 'booking_change' AND ch.status = 'open' AND ch.subject_id = c.booking_id) END` : 'NULL'} AS review,
        ${head ? `CASE WHEN b.id IS NOT NULL THEN json_object(
          'created_at', b.created_at, 'starts_at', b.starts_at, 'ends_at', b.ends_at, 'timezone', b.timezone,
          'party_size', b.party_size, 'status', b.status, 'stay', b.product_session_id IS NULL, 'vertical', o.vertical,
          'product_kind', (SELECT booked.kind FROM products booked WHERE booked.id = b.product_id AND booked.organization_id = b.organization_id),
          'confirmation', CASE WHEN c.kind = 'booking' AND b.status = 'confirmed' THEN
            (SELECT json_object('at', m.occurred_at, 'message_id', m.id, 'event', m.event_name) FROM messages m
              WHERE m.organization_id = c.organization_id AND m.conversation_id = c.id AND m.author_kind IN (${PLATFORM_MESSAGE_AUTHOR_KINDS_SQL})
                AND m.event_name IN ('booking.confirm', 'payment.payment_captured')
              ORDER BY m.sequence DESC LIMIT 1) END
        ) END` : 'NULL'} AS reservation,
        -- Where a guest's report of something broken is: the booked listing and its location, else the conversation's location.
        ${head ? 'b.product_id' : 'NULL'} AS place_product_id,
        ${head ? `COALESCE(b.location_id, (SELECT sc.location_id FROM product_stay_configs sc WHERE sc.organization_id = b.organization_id AND sc.product_id = b.product_id), c.location_id)` : 'NULL'} AS place_location_id
      FROM authorized c
      JOIN organization o ON o.id = c.organization_id
      LEFT JOIN business_locations l ON l.id = c.location_id AND l.organization_id = c.organization_id
      LEFT JOIN bookings b ON c.kind IN ('booking', 'team') AND b.id = c.booking_id AND b.organization_id = c.organization_id`,
    params: [...(access.params ?? []), ...(head ? [userId, userId, userId, userId, userId, userId, userId] : [])],
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
  const jobs = context.jobs === null ? [] : JSON.parse(context.jobs) as ConversationJob[]
  const job = jobs[0]
  const jobActions = Object.fromEntries(jobs.flatMap(({ message_id, task_id }) => message_id === null ? [] : [[message_id, task_id] as const]))
  const managesBookingGuests = context.booking_type !== null || (role === 'member' && conversation.kind === 'booking' && conversation.booking_id !== null)
  const activityPath = context.booking_type ? accountActivityPath(context.booking_type, conversation.id) : null
  const [groupCapabilities, bookingScope, createsTasks] = await Promise.all([
    conversationGroupCapabilities(membership, conversation),
    membership && conversation.booking_id ? bookingOperationsScope(membership) : null,
    membership && conversation.kind !== 'team' ? roleAllows({ ...membership, permissions: { task: ['create'] } }) : false,
  ])
  const canReadBooking = activityPath !== null || bookingScope === 'manage' || (bookingScope === 'assigned' && context.booking_assigned === 1)
  const title = role === 'guest' ? context.organization_name : conversation.name || (conversation.kind === 'team' ? context.record_title : guestName)
    || roster.filter(person => person.id !== userId).map(person => person.name).join(', ') || 'You'
  return {
    conversation: {
      id: conversation.id, organization_id: conversation.organization_id, title, kind: conversation.kind === 'team' ? 'team' : context.support ? 'support' : 'guest',
      name: conversation.name, is_group: conversation.is_group === 1,
      created_by_user_id: role === 'member' ? conversation.created_by_user_id : null,
      booking_id: canReadBooking ? conversation.booking_id : null,
      activity_path: activityPath,
      reservation: canReadBooking ? reservationInThread(context, { conversation, role }, now) : undefined,
      participants: roster.map(({ invitation_id, ...person }) => {
        const can_remove = managesBookingGuests && person.role === 'guest' && (invitation_id !== null
          || (role === 'member' && person.id !== null && person.id !== conversation.user_id))
        return { ...person, can_remove, ...(can_remove && invitation_id !== null ? { invitation_id } : {}) }
      }),
      composer: { channel: conversation.kind === 'team' ? 'team' : context.airbnb ? 'airbnb' : 'email' },
    },
    ...result, viewer_role: role,
    capabilities: { ...groupCapabilities, can_invite_guest: managesBookingGuests && conversation.blocked_at === null },
    work: job ? { type: 'done' as const, task_id: job.task_id, version: job.version } : context.review ? { type: 'review' as const } : null,
    ...(Object.keys(jobActions).length ? { job_actions: jobActions } : {}),
    // A guest's message can become a maintenance job for whoever creates tasks.
    ...(createsTasks ? { maintenance: { product_id: context.place_product_id, location_id: context.place_location_id, guest: firstName(guestName) } } : {}),
  }
}
