import { HTTPError } from 'nitro'
import { createTeamThread, listTeamMembers, operateTeamGroup } from '~/server/domain/team-messages'
import { assertConversationAccess, conversationAccessDenied, conversationAccessSql, markConversationRead, markConversationUnread, resolveConversationAccess } from '~/server/domain/conversations'
import { archiveConversation, countUnreadConversations, listConversations } from '~/server/domain/guest-threads/repository'
import { loadConversationPage, loadEarlierConversationEntries } from '~/server/domain/conversation-history'
import { sendConversationMessage } from '~/server/domain/send-conversation-message'
import { queryFirst } from '~/server/db'
import type { InboxThreadKind } from '~/server/domain/guest-threads/types'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { publishConversationAck } from '~/server/cloudflare/guest-inbox-events'
import { mcpPageInfo, mcpPageWindow } from '~/server/utils/mcp-pagination'
import { MAX_IMAGE_BYTES } from '~/server/utils/media-mime'
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
const cursor = { type: ['integer', 'null'], minimum: 1 }
const messageEntries = { type: 'array', items: { type: 'object', properties: { id: text, type: { type: 'string', enum: ['message', 'day', 'event'] } }, required: ['id', 'type'] } }
const messageWindow = { type: 'object', properties: { before: cursor, oldest: cursor, newest: cursor }, required: ['before', 'oldest', 'newest'] }
const messagePage = { type: 'object', properties: {
  conversation: { type: 'object', properties: { id: text, organization_id: text, title: text, kind: { type: 'string', enum: ['guest', 'support', 'team'] }, participants: { type: 'array' } }, required: ['id', 'organization_id', 'title', 'kind', 'participants'] },
  entries: messageEntries,
  page: messageWindow,
  viewer_role: { const: 'member' },
}, required: ['conversation', 'entries', 'page', 'viewer_role'] }
const earlierPage = { type: 'object', properties: { conversation_id: text, entries: messageEntries, page: messageWindow }, required: ['conversation_id', 'entries', 'page'] }
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
  organizationTool({ name: 'get_conversation', domain: 'conversations', minimumRole: 'member', description: 'Read the latest page of a conversation you participate in. Entries are in sequence order. Pass page.before to read older messages. Reading does not acknowledge messages.',
    inputSchema: { conversation_id: conversationId, before: { type: 'integer', minimum: 1 } }, required: ['conversation_id'],
    outputSchema: { type: 'object', anyOf: [messagePage, earlierPage] },
  }),
  organizationTool({ name: 'send_message', domain: 'conversations', minimumRole: 'member', description: 'Send text and/or one photo in a conversation, as you. In a guest conversation it is your reply through its reply_channel (get_conversation): Airbnb replies accept text or one photo, sent separately; email replies accept text, a photo or both; a guest with neither email nor account is refused with GUEST_UNREACHABLE. In a team conversation it reaches its participants by their notification choices. Reuse the same idempotency_key for an identical retry. A failed Airbnb attempt may retry only when retry_with_same_idempotency_key is true; a realtime failure may report committed:true and must retry that same request. A saved message does not prove delivery.',
    inputSchema: { conversation_id: conversationId, message: { ...text, minLength: 1, maxLength: 5000, pattern: '^[\\s\\S]*\\S[\\s\\S]*$' }, file: { ...chatgptFileInput, description: 'Optional photo supplied as a ChatGPT file attachment.' }, idempotency_key: { ...text, minLength: 8, maxLength: 128, pattern: '^[a-zA-Z0-9_-]{8,128}$' }, anyOf: [{ required: ['message'] }, { required: ['file'] }] }, required: ['conversation_id', 'idempotency_key'], fileParams: ['file'],
    outputSchema: { type: 'object', properties: { conversation_id: text, message: { type: 'object', properties: { id: text, sequence: { type: 'integer', minimum: 1 } }, required: ['id', 'sequence'] } }, required: ['conversation_id', 'message'] },
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
      const conversations = rows.slice(0, window.limit).map(row => ({ conversation_id: row.id, kind: row.kind, title: row.title, channel: row.channel, home: row.home, when: row.when, preview: row.preview, preview_from: row.preview_from, time: row.time, unread: row.unread }))
      return { conversations, unread, page_info: mcpPageInfo(window, conversations.length, rows.length > window.limit, resource) }
    }
    case 'list_conversation_recipients': return { current_user_id: userId, members: await listTeamMembers(env, principal) }
    case 'start_conversation': {
      const thread = await createTeamThread(env, db, principal, args)
      return { conversation_id: thread.id, created: thread.created }
    }
  }
  const conversationId = requiredString(args, 'conversation_id')
  if (toolName === 'get_conversation') {
    const before = args.before ?? null
    if (before !== null && (typeof before !== 'number' || !Number.isSafeInteger(before) || before < 1)) throw new HTTPError({ statusCode: 400, message: 'Invalid transcript cursor', data: { code: 'INVALID_TRANSCRIPT_CURSOR', field: 'before' } })
    const access = await resolveConversationAccess(db, userId, conversationId)
    if (access.role !== 'member' || access.conversation.organization_id !== organizationId) conversationAccessDenied()
    const viewer = { ...access, userId, principal }
    return before === null ? loadConversationPage(db, viewer, { before, limit: 40 })
      : loadEarlierConversationEntries(db, viewer, { before, limit: 40 })
  }
  const conversation = await assertConversationAccess(db, principal, conversationId)
  switch (toolName) {
    case 'mark_conversation_read':
    case 'mark_conversation_unread': {
      const guard = await conversationAccessSql('c', principal)
      const position = toolName === 'mark_conversation_read'
        ? await markConversationRead(db, { organizationId, conversationId: conversation.id, userId, guard, throughMessageId: optionalString(args, 'message_id') })
        : await markConversationUnread(db, { organizationId, conversationId: conversation.id, userId, guard })
      await publishConversationAck(env, { organizationId, conversationId: conversation.id, targetUserId: userId })
      return { conversation_id: conversation.id, unread: !position.read, last_read_message_id: position.last_read_message_id }
    }
    case 'set_conversation_archived': {
      if (typeof args.archived !== 'boolean') throw new HTTPError({ statusCode: 400, message: 'archived must be true or false', data: { code: 'VALIDATION_ERROR', field: 'archived' } })
      const result = await archiveConversation(db, { organizationId, conversationId: conversation.id, userId, guard: await conversationAccessSql('c', principal), archived: args.archived })
      await publishConversationAck(env, { organizationId, conversationId: conversation.id, targetUserId: userId })
      return { conversation_id: conversation.id, archived: result.archived }
    }
    case 'update_conversation_group': {
      return await operateTeamGroup(env, db, principal, conversation.id, { ...args, action: args.action, idempotency_key: args.idempotency_key })
    }
    case 'send_message': {
      const file = args.file === undefined ? null : toolFileReference(args.file, 'file')
      const photo = file ? { sourceIds: [file.file_id], resolve: async () => {
        const resolved = await resolveUserUploadedMediaFile(file, MAX_IMAGE_BYTES)
        if (resolved.kind !== 'image') throw new HTTPError({ statusCode: 422, statusMessage: 'Messages accept only photo attachments', data: { code: 'INVALID_PHOTO', field: 'file' } })
        return [{ bytes: resolved.buffer, filename: resolved.filename }]
      } } : null
      const idempotencyKey = requiredString(args, 'idempotency_key')
      const sender = await queryFirst<{ name: string }>(db, 'SELECT name FROM user WHERE id = ?', [userId])
      if (!sender) throw new Error('Message sender account is missing')
      const message = await sendConversationMessage(env, { conversation, role: 'member', userId, senderName: sender.name, body: optionalString(args, 'message') ?? '', photos: photo ?? [], idempotencyKey })
      return { conversation_id: conversation.id, message: { id: message.id, sequence: message.sequence } }
    }
    default: return NOT_HANDLED
  }
}
