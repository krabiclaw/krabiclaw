import { HTTPError } from 'nitro'
import { TASK_VIEW_SCHEMA } from '~/server/utils/mcp-tools/tasks'
import { createTeamThread, getTeamThread, listTeamMembers, listTeamMessages, operateTeamGroup, sendTeamMessage, teamAccessFor } from '~/server/domain/team-messages'
import { assertConversationAccess, findMessageByDedupeKey, markConversationRead, markConversationUnread, type ConversationRow } from '~/server/domain/conversations'
import { archiveConversation, countUnreadConversations, listConversations } from '~/server/domain/guest-threads/repository'
import { getGuestThreadDetail } from '~/server/domain/guest-threads/detail'
import { executeGuestThreadOperation, guestReplyDestination, operationDedupeKey } from '~/server/domain/guest-threads/operations'
import { parseGuestRequest } from '~/server/domain/requests'
import type { InboxThreadKind } from '~/server/domain/guest-threads/types'
import { memberAccessPrincipal, resolveMemberId, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { publishConversationAck, publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import { renderStructuredResponse } from '~/server/utils/mcp-render'
import { mcpPageInfo, mcpPageWindow } from '~/server/utils/mcp-pagination'
import { MAX_IMAGE_BYTES } from '~/server/utils/media-mime'
import { formAnswerSnapshotsJsonSchema } from '~/shared/form-questions'
import { chatgptFileInput, organizationTool, pageInfoObject, paginationInputSchema, type McpToolDefinition } from './shared'
import { NOT_HANDLED, optionalString, requiredString, resolveUserUploadedMediaFile, toolFileReference, type McpExecutorContext } from './execution'

/*
  One conversation toolset for every conversation a member sees: a guest's
  (a contact, a booking, Airbnb Support) and the team's own. The list is the
  inbox's one list, unread is the inbox's one statement, and reading never
  marks anything read.
*/

const text = { type: 'string' }, nullableText = { type: ['string', 'null'] }
const conversationId = { type: 'string', minLength: 1, description: 'A conversation_id from list_conversations, start_conversation or a booking read.' }
const participant = { type: 'object', properties: { id: text, member_id: text, name: text, image: nullableText }, required: ['id', 'member_id', 'name', 'image'] }
const listRow = { type: 'object', properties: {
  conversation_id: text,
  kind: { type: 'string', enum: ['guest', 'support', 'team'], description: 'guest: a contact or a booking’s guest; support: Airbnb Support; team: members of this business.' },
  title: { ...text, description: 'Who the conversation is with: the guest, Airbnb Support, or the team conversation’s name or people.' },
  channel: { type: 'string', enum: ['airbnb', 'direct'] },
  home: nullableText, when: nullableText, preview: text, preview_from: nullableText, time: text,
  unread: { type: 'boolean', description: 'A message from someone else you have not read, as Messages shows it.' },
}, required: ['conversation_id', 'kind', 'title', 'channel', 'home', 'when', 'preview', 'preview_from', 'time', 'unread'], additionalProperties: false }
const unreadCounts = { type: 'object', properties: { all: { type: 'integer' }, guests: { type: 'integer' }, support: { type: 'integer' }, team: { type: 'integer' } }, required: ['all', 'guests', 'support', 'team'] }
const changeSide = { type: 'object', properties: { when_label: text, party_size: { type: 'integer' }, assigned_member_id: nullableText, assigned_member_name: nullableText }, required: ['when_label', 'party_size', 'assigned_member_id', 'assigned_member_name'] }
const bookingChange = { type: ['object', 'null'], description: 'Canonical proposal details and current response state. A pending proposal does not change the operational record.', properties: { status: { type: 'string', enum: ['pending', 'accepted', 'declined', 'withdrawn', 'stale', 'expired'] }, before: changeSide, after: changeSide, location_title: text, original_location_title: text, message: text }, required: ['status', 'before', 'after', 'location_title', 'original_location_title'] }
const guestConversation = { type: 'object', description: 'A guest conversation: its guest, answers, booking and every message.', properties: {
  type: { type: 'string', enum: ['contact', 'booking', 'stay'] }, needs_reply: { type: 'boolean' }, archived: { type: 'boolean', description: 'Archived by you.' }, last_message_at: text,
  participant_label: text, reply_channel: { type: ['string', 'null'], enum: ['airbnb', 'email', 'account', null], description: 'Where send_message sends: Airbnb’s conversation, the guest’s email, or their KrabiClaw account inbox. Null when the guest cannot be replied to; reply_not_possible says why.' }, reply_not_possible: nullableText,
  guest: { type: 'object', properties: { name: nullableText, email: nullableText, phone: nullableText }, required: ['name', 'email', 'phone'] },
  answers: formAnswerSnapshotsJsonSchema(),
  operational_record: { type: ['object', 'null'], description: 'The booking the conversation is about. unit nights is a stay: check_in_date and check_out_date are its nights in its home’s clock, and starts_at/ends_at hold a day alone where the home has no check-in or checkout time.', properties: { id: text, unit: { type: 'string', enum: ['slot', 'nights'] }, product_kind: text, status: text, starts_at: text, ends_at: text, timezone: text, party_size: { type: 'integer' }, check_in_date: nullableText, check_out_date: nullableText }, required: ['id', 'unit', 'product_kind', 'status', 'starts_at', 'ends_at', 'timezone', 'party_size', 'check_in_date', 'check_out_date'] },
  messages: { type: 'array', items: { type: 'object', properties: { id: text, author: { type: 'string', enum: ['guest', 'member', 'krabiclaw'], description: 'krabiclaw: written by KrabiClaw — an automatic message, a booking’s opening, Airbnb Support relayed, or an event such as a cancellation or payment.' }, actor: nullableText, channel: nullableText, body: nullableText, event: nullableText, occurred_at: text, provider_timestamp: nullableText, payload: { type: ['object', 'null'] }, booking_change: bookingChange,
    deliveries: { type: 'array', items: { type: 'object', properties: { id: text, channel: text, provider: { ...text, description: 'log_only records the message locally without sending it through a provider.' }, purpose: text, status: text }, required: ['id', 'channel', 'provider', 'purpose', 'status'] } },
    attachments: { type: 'array', items: { type: 'object', properties: { id: text, url: text, alt: nullableText, width: { type: ['integer', 'null'] }, height: { type: ['integer', 'null'] } }, required: ['id', 'url', 'alt', 'width', 'height'] } },
  }, required: ['id', 'author', 'actor', 'channel', 'body', 'event', 'occurred_at', 'provider_timestamp', 'booking_change', 'deliveries', 'attachments'] } },
}, required: ['type', 'needs_reply', 'archived', 'last_message_at', 'participant_label', 'reply_channel', 'reply_not_possible', 'guest', 'answers', 'operational_record', 'messages'] }
const teamThread = { type: 'object', description: 'A team conversation: its people, what it is about and its newest message.', properties: {
  id: text, created_at: text, last_message_at: text, booking_id: { ...nullableText, description: 'The booking the conversation is about: a stay (see stay) or a class, consultation or table (see record).' }, location_id: nullableText,
  name: { ...nullableText, description: 'A group’s name; a stay conversation is titled by the home the guest sleeps in.' }, is_group: { type: 'boolean' }, created_by_user_id: nullableText, can_manage: { type: 'boolean' }, can_leave: { type: 'boolean' },
  participants: { type: 'array', items: participant }, unread: { type: 'boolean' },
  stay: { type: ['object', 'null'], properties: { id: text, product_id: text, name: text, check_in_date: text, check_out_date: text, status: { type: 'string', enum: ['pending', 'confirmed', 'cancelled'] } }, required: ['id', 'product_id', 'name', 'check_in_date', 'check_out_date', 'status'] },
  job: { ...TASK_VIEW_SCHEMA, type: ['object', 'null'], description: 'The job for the conversation’s booked record (a turnover or home-ready job for a stay, the prep or follow-up for a booking) as list_tasks presents it; null when there is none the caller may see.' },
  location: { type: ['object', 'null'], properties: { id: text, title: text, slug: text, timezone: text }, required: ['id', 'title', 'slug', 'timezone'] },
  record: { type: ['object', 'null'], description: 'The booking (a class, consultation or table) the conversation is about: who booked, else what.', properties: { id: text, title: text }, required: ['id', 'title'] },
  last_message: { type: ['object', 'null'], properties: { id: text, author_user_id: nullableText, body: text, attachment_count: { type: 'integer' }, created_at: text }, required: ['id', 'author_user_id', 'body', 'attachment_count', 'created_at'] },
}, required: ['id', 'created_at', 'last_message_at', 'booking_id', 'location_id', 'record', 'name', 'is_group', 'created_by_user_id', 'can_manage', 'can_leave', 'participants', 'unread', 'stay', 'job', 'location', 'last_message'] }
const teamMessage = { type: 'object', properties: {
  id: text, conversation_id: text, author_user_id: { ...nullableText, description: 'The sender; null for an automatic message, or once a person’s account was deleted.' }, automatic: { type: 'boolean', description: 'Written by KrabiClaw (a cleaning job, a reminder, a move), not by a member. It is unread until read, like any message from someone else.' }, body: text, created_at: text,
  attachments: { type: 'array', items: { type: 'object', properties: { id: text, url: text, width: { type: ['number', 'null'] }, height: { type: ['number', 'null'] } }, required: ['id', 'url', 'width', 'height'] } },
  deliveries: { type: 'array', items: { type: 'object', properties: { id: text, channel: { type: 'string', enum: ['email', 'whatsapp', 'push'] }, status: text, error: nullableText, updated_at: text }, required: ['id', 'channel', 'status', 'error', 'updated_at'] } },
}, required: ['id', 'conversation_id', 'author_user_id', 'automatic', 'body', 'created_at', 'attachments', 'deliveries'] }
const readState = { type: 'object', properties: { conversation_id: text, unread: { type: 'boolean' }, last_read_message_id: nullableText }, required: ['conversation_id', 'unread', 'last_read_message_id'], additionalProperties: false }

export const CONVERSATION_TOOLS: McpToolDefinition[] = [
  organizationTool({ name: 'list_conversations', domain: 'conversations', minimumRole: 'member', description: 'Read Messages: every conversation you can see, newest first — guests (contacts and bookings: classes, consultations, tables and stays), Airbnb Support and your team conversations — with unread counts per kind as the filter menu shows them. Filter by kind, current/past/blocked, unread, type and words. Follow page_info. Read one with get_conversation.',
    inputSchema: {
      kind: { type: 'string', enum: ['all', 'guests', 'support', 'team'] }, mailbox: { type: 'string', enum: ['current', 'past', 'blocked'] },
      unread: { type: 'boolean', description: 'Only conversations with a message from someone else you have not read.' },
      type: { type: 'string', enum: ['contact', 'booking', 'stay'], description: 'Guest conversations of this kind only.' },
      q: { type: 'string', minLength: 1, maxLength: 200, description: 'Words in the guest’s name, the home or the messages.' },
      location_id: { type: 'string', minLength: 1 }, ...paginationInputSchema,
    },
    outputSchema: { type: 'object', properties: { conversations: { type: 'array', items: listRow }, unread: unreadCounts, page_info: pageInfoObject }, required: ['conversations', 'unread', 'page_info'] },
  }),
  organizationTool({ name: 'get_conversation', domain: 'conversations', minimumRole: 'member', description: 'Read one conversation. A guest conversation returns the guest, their answers to the business’s questions, the booking and every message with proposals, attachments and delivery receipts. A team conversation returns its people and context and its messages newest first (default 20, maximum 100; page back with before and before_id from the oldest loaded message’s created_at and id). Reading does not mark the conversation read: use mark_conversation_read.',
    inputSchema: { conversation_id: conversationId, limit: { type: 'integer', minimum: 1, maximum: 100 }, before: { ...text, minLength: 1 }, before_id: { ...text, minLength: 1 } }, required: ['conversation_id'],
    outputSchema: { type: 'object', properties: { conversation_id: text, kind: { type: 'string', enum: ['contact', 'booking', 'team'] }, guest: { ...guestConversation, type: ['object', 'null'] }, team: { type: ['object', 'null'], properties: { thread: teamThread, messages: { type: 'array', items: teamMessage }, has_more: { type: 'boolean' } }, required: ['thread', 'messages', 'has_more'] } }, required: ['conversation_id', 'kind', 'guest', 'team'] },
  }),
  organizationTool({ name: 'send_message', domain: 'conversations', minimumRole: 'member', description: 'Send text and/or one photo in a conversation, as you. In a guest conversation it is your reply through its reply_channel (get_conversation): Airbnb replies accept text or one photo, sent separately; email replies accept text, a photo or both; a guest with neither email nor account is refused with GUEST_UNREACHABLE. In a team conversation it reaches its participants by their notification choices. Reuse the same idempotency_key for an identical retry. A failed Airbnb attempt may retry only when retry_with_same_idempotency_key is true; a realtime failure may report committed:true and must retry that same request. A saved message does not prove delivery.',
    inputSchema: { conversation_id: conversationId, message: { ...text, minLength: 1, maxLength: 5000, pattern: '^[\\s\\S]*\\S[\\s\\S]*$' }, file: { ...chatgptFileInput, description: 'Optional photo supplied as a ChatGPT file attachment.' }, idempotency_key: { ...text, minLength: 1, maxLength: 200 }, anyOf: [{ required: ['message'] }, { required: ['file'] }] }, required: ['conversation_id', 'idempotency_key'], fileParams: ['file'],
    outputSchema: { type: 'object', properties: { conversation_id: text, outcome: { type: 'object' }, message_id: nullableText, created: { type: 'boolean' } }, required: ['conversation_id', 'outcome', 'message_id', 'created'] },
  }),
  organizationTool({ name: 'mark_conversation_read', domain: 'conversations', minimumRole: 'member', description: 'Mark a conversation read for you, through its newest message or through message_id (the newest one you were shown). Needs a message from someone else (409 NOTHING_TO_MARK). Changes only your own read position; sends nothing and changes nobody else’s unread state.',
    inputSchema: { conversation_id: conversationId, message_id: { ...text, minLength: 1 } }, required: ['conversation_id'], outputSchema: readState,
  }),
  organizationTool({ name: 'mark_conversation_unread', domain: 'conversations', minimumRole: 'member', description: 'Mark a conversation unread for you: its newest message from someone else is unread again. Needs a message from someone else (409 NOTHING_TO_MARK). Changes only your own read position.',
    inputSchema: { conversation_id: conversationId }, required: ['conversation_id'], outputSchema: readState,
  }),
  organizationTool({ name: 'set_conversation_archived', domain: 'conversations', minimumRole: 'member', description: 'Archive a conversation for yourself (it moves to Past until someone else writes in it) or restore it. Archiving a guest conversation also dismisses its open reply task. It cancels no booking, sends nothing and leaves everyone else’s Messages unchanged. A conversation quiet for 30 days stays in Past; a blocked one is in Blocked.',
    inputSchema: { conversation_id: conversationId, archived: { type: 'boolean' } }, required: ['conversation_id', 'archived'],
    outputSchema: { type: 'object', properties: { conversation_id: text, archived: { type: 'boolean' } }, required: ['conversation_id', 'archived'], additionalProperties: false },
  }),
  organizationTool({ name: 'list_conversation_recipients', domain: 'conversations', minimumRole: 'member', description: 'Read the current organization members you can start a team conversation with. Select actual user IDs from these results; current_user_id identifies you. It does not include guests.',
    outputSchema: { type: 'object', properties: { current_user_id: text, members: { type: 'array', items: { ...participant, properties: { ...participant.properties, email: text, role: text }, required: [...participant.required, 'email', 'role'] } } }, required: ['current_user_id', 'members'] },
  }),
  organizationTool({ name: 'start_conversation', domain: 'conversations', minimumRole: 'member', description: 'Start a team conversation with explicitly selected workspace members. Direct and booking/location conversations reuse the same participants and context. A manual conversation with at least three people is a distinct group, can have a name, and requires a stable idempotency_key; reuse that key only for an identical retry. Maximum 50 people including you. This sends no message and invites nobody. Choose actual users from list_conversation_recipients. Guests are never added; a guest conversation starts when the guest writes or books.',
    inputSchema: { member_user_ids: { type: 'array', minItems: 1, maxItems: 49, uniqueItems: true, items: { ...text, minLength: 1 } }, name: { ...text, minLength: 1, maxLength: 100, description: 'Optional name for a manually created group of at least three people; unavailable for direct or booking/location conversations.' }, idempotency_key: { ...text, minLength: 1, maxLength: 200, description: 'Required for a manually created group. Keep the same key for an identical retry.' }, booking_id: { ...text, minLength: 1, description: 'Optional booking ID you may read, a stay’s included.' }, location_id: { ...text, minLength: 1, description: 'Optional explicit location context you may read.' } }, required: ['member_user_ids'],
    outputSchema: { type: 'object', properties: { conversation_id: text, created: { type: 'boolean' } }, required: ['conversation_id', 'created'] },
  }),
  organizationTool({ name: 'update_conversation_group', domain: 'conversations', minimumRole: 'member', description: 'Rename, add people to, remove someone from, or leave a manually created team group. The creator and participating workspace owners/admins can manage it; any participant can leave. Read can_manage/can_leave from get_conversation. Direct chats, guest conversations and booking/location conversations are protected. No action deletes the conversation or its messages. New members can read its history; removed members lose access. Use a stable idempotency_key and retry exactly the same action if committed:true is returned.',
    inputSchema: { conversation_id: conversationId, action: { type: 'string', enum: ['rename', 'add', 'remove', 'leave'] }, idempotency_key: { ...text, minLength: 1, maxLength: 200 }, name: { type: ['string', 'null'], minLength: 1, maxLength: 100, description: 'Rename only: a name, or null to clear it.' }, member_user_ids: { type: 'array', minItems: 1, maxItems: 49, uniqueItems: true, items: { ...text, minLength: 1 }, description: 'Add only: current workspace users to add.' }, user_id: { ...text, minLength: 1, description: 'Remove only: the participant to remove. Use leave to remove yourself.' }, oneOf: [
      { properties: { action: { const: 'rename' } }, required: ['name'] },
      { properties: { action: { const: 'add' } }, required: ['member_user_ids'] },
      { properties: { action: { const: 'remove' } }, required: ['user_id'] },
      { properties: { action: { const: 'leave' } } },
    ] }, required: ['conversation_id', 'action', 'idempotency_key'],
    outputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['updated', 'left'] }, conversation_id: text }, required: ['status', 'conversation_id'] },
  }),
]

/** A guest conversation as get_conversation returns it. */
async function guestConversationView(ctx: McpExecutorContext, conversation: ConversationRow) {
  const { db, organizationId, userId } = ctx.organization
  const detail = await getGuestThreadDetail(db, conversation.id, organizationId, { memberUserId: userId })
  if (!detail) throw new HTTPError({ statusCode: 404, message: `Conversation '${conversation.id}' not found in this organization`, data: { code: 'THREAD_NOT_FOUND', field: 'conversation_id' } })
  // Where send_message would send, by the reply operation's own rule.
  const destination = await guestReplyDestination(db, parseGuestRequest({ ...conversation }))
  return {
    type: detail.submissionType, needs_reply: detail.needsReply, archived: detail.manuallyArchived, last_message_at: conversation.last_message_at,
    participant_label: detail.participantLabel, reply_channel: destination.channel, reply_not_possible: destination.channel === null ? destination.reason : null,
    guest: { name: detail.guestName, email: detail.guestEmail, phone: detail.guestPhone }, answers: detail.source.fields.answers,
    operational_record: detail.operationalRecord,
    messages: detail.entries.map(entry => ({ id: entry.id, author: entry.actorKind, actor: entry.actorLabel, channel: entry.channel, body: entry.body, event: entry.eventName, payload: entry.payload, booking_change: entry.bookingChange, occurred_at: entry.occurredAt, provider_timestamp: entry.providerTimestamp, deliveries: entry.deliveries, attachments: entry.attachments })),
  }
}

async function teamAccess(ctx: McpExecutorContext, principal: MemberAccessPrincipal, action: 'read' | 'send') {
  const { organization } = ctx
  const memberId = await resolveMemberId({ env: organization.env, organizationId: organization.organizationId, userId: organization.userId })
  if (!memberId) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization membership not found' })
  return await teamAccessFor(principal, memberId, action)
}

export async function handleConversationTools(ctx: McpExecutorContext): Promise<unknown> {
  const { toolName, args, organization } = ctx
  if (!CONVERSATION_TOOLS.some(tool => tool.name === toolName)) return NOT_HANDLED
  const { env, db, organizationId, userId } = organization
  const principal = memberAccessPrincipal(organization.membership, { env, event: ctx.event })
  switch (toolName) {
    case 'list_conversations': {
      const kind: InboxThreadKind | null = args.kind === 'guests' ? 'guest' : args.kind === 'support' ? 'support' : args.kind === 'team' ? 'team' : null
      const filter = { kind, mailbox: (args.mailbox as 'current' | 'past' | 'blocked' | undefined) ?? null, unreadOnly: args.unread === true, type: (args.type as 'contact' | 'booking' | 'stay' | undefined) ?? null, q: optionalString(args, 'q'), locationId: optionalString(args, 'location_id') }
      const resource = { resource: `conversations:${JSON.stringify([organizationId, userId, filter])}` }
      const window = mcpPageWindow(args, resource)
      const options = { ...filter, principal, userId, limit: window.limit + 1, offset: window.offset }
      const [rows, unread] = await Promise.all([listConversations(db, organizationId, options), countUnreadConversations(db, organizationId, options)])
      const conversations = rows.slice(0, window.limit).map(row => ({ conversation_id: row.id, kind: row.kind, title: row.guestName, channel: row.channel, home: row.home, when: row.when, preview: row.preview, preview_from: row.previewFrom, time: row.time, unread: row.unread }))
      return { conversations, unread, page_info: mcpPageInfo(window, conversations.length, rows.length > window.limit, resource) }
    }
    case 'list_conversation_recipients': return { current_user_id: userId, members: await listTeamMembers(env, await teamAccess(ctx, principal, 'read')) }
    case 'start_conversation': {
      const thread = await createTeamThread(env, db, await teamAccess(ctx, principal, 'send'), args)
      return { conversation_id: thread.id, created: thread.created }
    }
  }
  const conversation = await assertConversationAccess(db, principal, requiredString(args, 'conversation_id'))
  switch (toolName) {
    case 'get_conversation': {
      if (conversation.kind !== 'team') return { conversation_id: conversation.id, kind: conversation.kind, guest: await guestConversationView(ctx, conversation), team: null }
      const access = await teamAccess(ctx, principal, 'read')
      const [thread, page] = await Promise.all([getTeamThread(env, db, access, conversation.id), listTeamMessages(db, access, conversation.id, { limit: args.limit, before: args.before, before_id: args.before_id })])
      return { conversation_id: conversation.id, kind: conversation.kind, guest: null, team: { thread, ...page } }
    }
    case 'mark_conversation_read':
    case 'mark_conversation_unread': {
      const position = toolName === 'mark_conversation_read'
        ? await markConversationRead(db, { organizationId, conversationId: conversation.id, userId, throughMessageId: optionalString(args, 'message_id') })
        : await markConversationUnread(db, { organizationId, conversationId: conversation.id, userId })
      await publishConversationAck(env, { organizationId, conversationId: conversation.id, targetUserId: userId })
      return { conversation_id: conversation.id, unread: !position.read, last_read_message_id: position.last_read_message_id }
    }
    case 'set_conversation_archived': {
      if (typeof args.archived !== 'boolean') throw new HTTPError({ statusCode: 400, message: 'archived must be true or false', data: { code: 'VALIDATION_ERROR', field: 'archived' } })
      const result = await archiveConversation(db, { organizationId, conversationId: conversation.id, userId, archived: args.archived })
      await publishConversationAck(env, { organizationId, conversationId: conversation.id, targetUserId: userId })
      return { conversation_id: conversation.id, archived: result.archived }
    }
    case 'update_conversation_group': {
      return await operateTeamGroup(env, db, await teamAccess(ctx, principal, 'send'), conversation.id, { ...args, action: args.action, idempotency_key: args.idempotency_key })
    }
    case 'send_message': {
      const file = args.file === undefined ? null : toolFileReference(args.file, 'file')
      const photo = file ? { sourceIds: [file.file_id], resolve: async () => {
        const resolved = await resolveUserUploadedMediaFile(file, MAX_IMAGE_BYTES)
        if (resolved.kind !== 'image') throw new HTTPError({ statusCode: 422, statusMessage: 'Messages accept only photo attachments', data: { code: 'INVALID_PHOTO', field: 'file' } })
        return [{ bytes: resolved.buffer, filename: resolved.filename }]
      } } : null
      const idempotencyKey = requiredString(args, 'idempotency_key')
      if (conversation.kind === 'team') {
        const access = await teamAccess(ctx, principal, 'send')
        const sender = (await listTeamMembers(env, access)).find(member => member.id === userId)
        if (!sender) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization membership not found' })
        const sent = await sendTeamMessage(env, db, access, conversation.id, { body: args.message, photos: photo ?? [], idempotency_key: idempotencyKey, senderName: sender.name })
        return { conversation_id: conversation.id, outcome: { ok: true }, message_id: sent.message.id, created: sent.created }
      }
      const outcome = await executeGuestThreadOperation(db, { threadId: conversation.id, organizationId, action: 'reply', body: optionalString(args, 'message') ?? undefined,
        ...(photo ? { photos: photo } : {}), actorUserId: userId, idempotencyKey, env, financialWritesAllowed: false })
      if (outcome.ok || outcome.reason === 'delivery_failed') await publishConversationEvent(env, db, { conversationId: conversation.id, type: 'MESSAGE_CREATE' })
      const messageId = outcome.ok ? (await findMessageByDedupeKey(db, operationDedupeKey({ threadId: conversation.id, idempotencyKey })))?.id ?? null : null
      return renderStructuredResponse({ conversation_id: conversation.id, outcome: outcome.ok ? { ok: true } : outcome, message_id: messageId, created: outcome.ok }, undefined, undefined, !outcome.ok)
    }
    default: return NOT_HANDLED
  }
}
