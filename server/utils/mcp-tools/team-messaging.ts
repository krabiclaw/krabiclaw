import { HTTPError } from 'nitro'
import { createTeamThread, listTeamMembers, listTeamMessages, listTeamThreads, markTeamThreadRead, sendTeamMessage, teamAccessFor } from '~/server/domain/team-messages'
import { memberAccessPrincipal, resolveMemberId } from '~/server/utils/member-access'
import { paginateMcpCollection } from '~/server/utils/mcp-pagination'
import { MAX_IMAGE_BYTES } from '~/server/utils/media-mime'
import { chatgptFileInput, organizationTool, pageInfoObject, paginationInputSchema, type McpToolDefinition } from './shared'
import { NOT_HANDLED, optionalString, requiredString, resolveUserUploadedMediaFile, toolFileReference, type McpExecutorContext } from './execution'

const text = { type: 'string' }, nullableText = { type: ['string', 'null'] }
const participant = { type: 'object', properties: { id: text, memberId: text, name: text, image: nullableText }, required: ['id', 'memberId', 'name', 'image'] }
const conversation = { type: 'object', properties: {
  id: text, createdAt: text, lastMessageAt: text, stayId: nullableText, locationId: nullableText,
  participants: { type: 'array', items: participant }, unread: { type: 'boolean' }, unreadCount: { type: 'integer' },
  stay: { type: ['object', 'null'], properties: { id: text, productId: text, homeName: text, checkInDate: text, checkOutDate: text, status: { type: 'string', enum: ['pending', 'confirmed', 'cancelled'] } }, required: ['id', 'productId', 'homeName', 'checkInDate', 'checkOutDate', 'status'] },
  location: { type: ['object', 'null'], properties: { id: text, title: text, slug: text, timezone: text }, required: ['id', 'title', 'slug', 'timezone'] },
  lastMessage: { type: ['object', 'null'], properties: { id: text, senderId: nullableText, body: text, attachmentCount: { type: 'integer' }, createdAt: text }, required: ['id', 'senderId', 'body', 'attachmentCount', 'createdAt'] },
}, required: ['id', 'createdAt', 'lastMessageAt', 'stayId', 'locationId', 'participants', 'unread', 'unreadCount', 'stay', 'location', 'lastMessage'] }
const message = { type: 'object', properties: {
  id: text, threadId: text, senderId: nullableText, body: text, createdAt: text,
  attachments: { type: 'array', items: { type: 'object', properties: { id: text, url: text, width: { type: ['number', 'null'] }, height: { type: ['number', 'null'] } }, required: ['id', 'url', 'width', 'height'] } },
  deliveries: { type: 'array', items: { type: 'object', properties: { id: text, channel: { const: 'push' }, status: text, error: nullableText, updatedAt: text }, required: ['id', 'channel', 'status', 'error', 'updatedAt'] } },
}, required: ['id', 'threadId', 'senderId', 'body', 'createdAt', 'attachments', 'deliveries'] }
const threadId = { type: 'string', minLength: 1, description: 'Team conversation ID from list_team_conversations or start_team_conversation; never a guest request or Better Auth Team ID.' }

export const TEAM_MESSAGING_TOOLS: McpToolDefinition[] = [
  organizationTool({ name: 'list_team_conversation_recipients', domain: 'team_messaging', minimumRole: 'member', description: 'Read the current organization members available for internal conversations. Select actual user IDs from these results; current_user_id identifies you. This is not Better Auth Team/group management and does not include guests.',
    outputSchema: { type: 'object', properties: { current_user_id: text, members: { type: 'array', items: { ...participant, properties: { ...participant.properties, email: text, role: text }, required: [...participant.required, 'email', 'role'] } } }, required: ['current_user_id', 'members'] },
  }),
  organizationTool({ name: 'list_team_conversations', domain: 'team_messaging', minimumRole: 'member', description: 'Read only your internal team conversations, newest activity first. Optional stay_id or location_id filters narrow their explicit context. Follow page_info; guest conversations use list_guest_conversations instead.',
    inputSchema: { stay_id: { ...text, minLength: 1 }, location_id: { ...text, minLength: 1 }, ...paginationInputSchema },
    outputSchema: { type: 'object', properties: { conversations: { type: 'array', items: conversation }, page_info: pageInfoObject }, required: ['conversations', 'page_info'] },
  }),
  organizationTool({ name: 'start_team_conversation', domain: 'team_messaging', minimumRole: 'member', description: 'Start an internal conversation with the selected organization members, or reuse the existing conversation with exactly those participants and optional stay/location context. This does not send a message, invite a person, create a Better Auth Team or manage participants. Choose at least one other user from list_team_conversation_recipients.',
    inputSchema: { member_user_ids: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: { ...text, minLength: 1 } }, stay_id: { ...text, minLength: 1, description: 'Optional canonical stay ID you may read; never a guest request ID.' }, location_id: { ...text, minLength: 1, description: 'Optional explicit location context you may read.' } }, required: ['member_user_ids'],
    outputSchema: { type: 'object', properties: { id: text, created: { type: 'boolean' } }, required: ['id', 'created'] },
  }),
  organizationTool({ name: 'get_team_conversation', domain: 'team_messaging', minimumRole: 'member', description: 'Read messages and photo/push receipts from one of your internal conversations, newest first. Defaults to 20, maximum 100. When hasMore is true, page back with both before and before_id from the oldest loaded message’s createdAt and id. Reading does not mark the conversation read.',
    inputSchema: { thread_id: threadId, limit: { type: 'integer', minimum: 1, maximum: 100 }, before: { ...text, minLength: 1 }, before_id: { ...text, minLength: 1 }, oneOf: [{ required: ['before', 'before_id'] }, { not: { anyOf: [{ required: ['before'] }, { required: ['before_id'] }] } }] }, required: ['thread_id'],
    outputSchema: { type: 'object', properties: { messages: { type: 'array', items: message }, hasMore: { type: 'boolean' } }, required: ['messages', 'hasMore'] },
  }),
  organizationTool({ name: 'send_team_message', domain: 'team_messaging', minimumRole: 'member', description: 'Send the text and/or supplied photo to an internal team conversation you belong to. Sends as the authenticated member and records push outcomes; a saved message does not prove delivery to a participant’s device. Reuse the same idempotency_key for an identical retry; a failed realtime publication may report committed:true and must retry that same request. This never replies to a guest.',
    inputSchema: { thread_id: threadId, message: { ...text, minLength: 1, maxLength: 5000 }, file: { ...chatgptFileInput, description: 'Optional photo supplied as a ChatGPT file attachment.' }, idempotency_key: { ...text, minLength: 1, maxLength: 200 }, anyOf: [{ required: ['message'] }, { required: ['file'] }] }, required: ['thread_id', 'idempotency_key'], fileParams: ['file'],
    outputSchema: { type: 'object', properties: { message, created: { type: 'boolean' } }, required: ['message', 'created'] },
  }),
  organizationTool({ name: 'mark_team_conversation_read', domain: 'team_messaging', minimumRole: 'member', description: 'Mark one of your internal conversations read through now. Changes only your own read position; does not send a message or change another participant’s unread state.',
    inputSchema: { thread_id: threadId }, required: ['thread_id'],
    outputSchema: { type: 'object', properties: { status: { const: 'read' }, lastReadAt: text }, required: ['status', 'lastReadAt'] },
  }),
]

export async function handleTeamMessagingTools(ctx: McpExecutorContext): Promise<unknown> {
  const { toolName, args, organization } = ctx
  if (!TEAM_MESSAGING_TOOLS.some(tool => tool.name === toolName)) return NOT_HANDLED
  const memberId = await resolveMemberId({ env: organization.env, organizationId: organization.organizationId, userId: organization.userId })
  if (!memberId) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization membership not found' })
  const access = await teamAccessFor(memberAccessPrincipal(organization.membership, { env: organization.env, event: ctx.event }), memberId,
    toolName === 'start_team_conversation' || toolName === 'send_team_message' ? 'send' : 'read')
  const { env, db } = organization
  switch (toolName) {
    case 'list_team_conversation_recipients': return { current_user_id: organization.userId, members: await listTeamMembers(env, access) }
    case 'list_team_conversations': {
      const filter = { stayId: optionalString(args, 'stay_id') ?? undefined, locationId: optionalString(args, 'location_id') ?? undefined }
      const page = paginateMcpCollection(await listTeamThreads(env, db, access, filter), args, {
        resource: `team-conversations:${JSON.stringify([organization.organizationId, organization.userId, filter])}`,
      })
      return { conversations: page.items, page_info: page.page_info }
    }
    case 'start_team_conversation': return await createTeamThread(env, db, access, { memberIds: args.member_user_ids, stayId: args.stay_id, locationId: args.location_id })
    case 'get_team_conversation': return await listTeamMessages(db, access, requiredString(args, 'thread_id'), { limit: args.limit, before: args.before, beforeId: args.before_id })
    case 'mark_team_conversation_read': return await markTeamThreadRead(db, access, requiredString(args, 'thread_id'))
    case 'send_team_message': {
      const sender = (await listTeamMembers(env, access)).find(member => member.id === organization.userId)
      if (!sender) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization membership not found' })
      const file = args.file === undefined ? null : toolFileReference(args.file, 'file')
      return await sendTeamMessage(env, db, access, requiredString(args, 'thread_id'), {
        body: args.message, photos: file ? { sourceIds: [file.file_id], resolve: async () => {
          const resolved = await resolveUserUploadedMediaFile(file, MAX_IMAGE_BYTES)
          if (resolved.kind !== 'image') throw new HTTPError({ statusCode: 422, statusMessage: 'Team messages accept only photo attachments', data: { code: 'INVALID_PHOTO', field: 'file' } })
          return [{ bytes: resolved.buffer, filename: resolved.filename }]
        } } : [],
        idempotencyKey: requiredString(args, 'idempotency_key'), senderName: sender.name,
      })
    }
    default: return NOT_HANDLED
  }
}
