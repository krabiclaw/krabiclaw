import { HTTPError } from 'nitro'
import { getGuestThreadDetail } from '~/server/domain/guest-threads/detail'
import { listOrganizationGuestThreads } from '~/server/domain/guest-threads/repository'
import { executeGuestThreadOperation, guestReplyDestination } from '~/server/domain/guest-threads/operations'
import { getGuestRequest } from '~/server/domain/requests'
import { assertMemberScope, assertAssignedBookingAccess, roleAllows, assertRoleAllows, memberAccessPrincipal } from '~/server/utils/member-access'
import { publishGuestInboxThreadEvent } from '~/server/cloudflare/guest-inbox-events'
import { renderStructuredResponse } from '~/server/utils/mcp-render'
import { mcpPageInfo, mcpPageWindow } from '~/server/utils/mcp-pagination'
import type { McpToolDefinition } from './shared'
import { organizationTool, paginationInputSchema, pageInfoObject, chatgptFileInput, PHONE_FORMAT } from './shared'
import type { McpExecutorContext } from './execution'
import { NOT_HANDLED, optionalString, requiredString, resolveUserUploadedMediaFile, toolFileReference  } from './execution'
import { MAX_IMAGE_BYTES } from '~/server/utils/media-mime'
import { formAnswerInputJsonSchema, formAnswerSnapshotsJsonSchema } from '~/shared/form-questions'
import { createInquiry } from '~/server/domain/inquiries'
import { setConversationRead } from '~/server/utils/notification-acknowledgement'

const nullableString = { type: ['string', 'null'] }
const changeSide = { type: 'object', properties: { whenLabel: { type: 'string' }, partySize: { type: 'integer' }, assignedMemberId: nullableString, assignedMemberName: nullableString }, required: ['whenLabel', 'partySize', 'assignedMemberId', 'assignedMemberName'] }
const bookingChange = { type: ['object', 'null'], description: 'Canonical proposal details and current response state. A pending proposal does not change the operational record.', properties: { status: { type: 'string', enum: ['pending', 'accepted', 'declined', 'withdrawn', 'stale', 'expired'] }, before: changeSide, after: changeSide, locationTitle: { type: 'string' }, originalLocationTitle: { type: 'string' }, message: { type: 'string' } }, required: ['status', 'before', 'after', 'locationTitle', 'originalLocationTitle'] }
const conversationResult = { type: 'object', properties: { conversation: { type: 'object', properties: {
  request_id: { type: 'string' }, type: { type: 'string', enum: ['contact', 'booking', 'stay'] }, needs_reply: { type: 'boolean' }, archived: { type: 'boolean' }, updated_at: { type: 'string' },
  participant_label: { type: 'string' }, reply_channel: { type: ['string', 'null'], enum: ['airbnb', 'email', 'account', null], description: 'Where reply_to_guest sends: Airbnb’s conversation, the guest’s email, or their KrabiClaw account inbox. Null when the guest cannot be replied to; reply_not_possible says why.' }, reply_not_possible: nullableString,
  guest: { type: 'object', properties: { name: nullableString, email: nullableString, phone: nullableString }, required: ['name', 'email', 'phone'] },
  answers: formAnswerSnapshotsJsonSchema(),
  inquiry_message: { type: 'string', description: 'The original contact-form message. Present for contact inquiries; later messages are in entries.' },
  operational_record: { type: ['object', 'null'], description: 'For a stay, check_in_date and check_out_date are its nights and id is the stay for get_stay; its starts_at and ends_at only order and archive the conversation.', properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['booking', 'stay'] }, status: { type: 'string' }, starts_at: { type: 'string' }, ends_at: { type: 'string' }, timezone: { type: 'string' }, party_size: { type: 'integer' }, check_in_date: nullableString, check_out_date: nullableString }, required: ['id', 'kind', 'status', 'starts_at', 'ends_at', 'timezone', 'party_size', 'check_in_date', 'check_out_date'] },
  entries: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string' }, actor: nullableString, channel: nullableString, body: nullableString, event: nullableString, occurred_at: { type: 'string' }, provider_timestamp: nullableString, payload: { type: ['object', 'null'] }, booking_change: bookingChange,
    deliveries: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, channel: { type: 'string' }, provider: { type: 'string', description: 'log_only records the message locally without sending it through a provider.' }, purpose: { type: 'string' }, status: { type: 'string' } }, required: ['id', 'channel', 'provider', 'purpose', 'status'] } },
    attachments: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, url: { type: 'string' }, alt: nullableString, width: { type: ['integer', 'null'] }, height: { type: ['integer', 'null'] } }, required: ['id', 'url', 'alt', 'width', 'height'] } },
  }, required: ['id', 'kind', 'actor', 'channel', 'body', 'event', 'occurred_at', 'provider_timestamp', 'booking_change', 'deliveries', 'attachments'] } },
}, required: ['request_id', 'type', 'needs_reply', 'archived', 'updated_at', 'participant_label', 'reply_channel', 'reply_not_possible', 'guest', 'answers', 'operational_record', 'entries'] } }, required: ['conversation'] }
const conversationMutationResult = { type: 'object', properties: {
  outcome: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] },
  conversation: { type: 'object', properties: { request_id: { type: 'string' }, needs_reply: { type: 'boolean' }, archived: { type: 'boolean' }, updated_at: { type: 'string' } }, required: ['request_id', 'needs_reply', 'archived', 'updated_at'], additionalProperties: false },
}, required: ['outcome', 'conversation'], additionalProperties: false }

async function readConversation(ctx: McpExecutorContext, requestId: string) {
  const { db, organizationId } = ctx.organization
  const detail = await getGuestThreadDetail(db, requestId, organizationId)
  if (!detail) {
    throw new HTTPError({
      statusCode: 404,
      message: `Guest conversation '${requestId}' not found in this organization. Call list_guest_conversations to find valid conversation request IDs.`,
      data: { code: 'CONVERSATION_NOT_FOUND', request_id: requestId, hint: 'Call list_guest_conversations to find valid conversation request IDs.' },
    })
  }
  const request = await getGuestRequest(db, requestId, organizationId)
  if (!request) {
    throw new HTTPError({
      statusCode: 404,
      message: `Guest conversation '${requestId}' not found in this organization. Call list_guest_conversations to find valid conversation request IDs.`,
      data: { code: 'CONVERSATION_NOT_FOUND', request_id: requestId, hint: 'Call list_guest_conversations to find valid conversation request IDs.' },
    })
  }
  // Where reply_to_guest would send, by the reply operation's own rule.
  const destination = await guestReplyDestination(db, request)
  return { request_id: detail.id, type: detail.submissionType, needs_reply: detail.needsReply, archived: detail.manuallyArchived, updated_at: detail.updatedAt,
    participant_label: detail.participantLabel, reply_channel: destination.channel, reply_not_possible: destination.channel === null ? destination.reason : null,
    guest: { name: detail.guestName, email: detail.guestEmail, phone: detail.guestPhone }, answers: detail.source.fields.answers,
    ...(request.kind === 'contact' ? { inquiry_message: request.payload.message } : {}), operational_record: detail.operationalRecord,
    entries: detail.entries.map(entry => ({ id: entry.id, kind: entry.kind, actor: entry.actorLabel, channel: entry.channel, body: entry.body, event: entry.eventName, payload: entry.payload, booking_change: entry.bookingChange, occurred_at: entry.occurredAt, provider_timestamp: entry.providerTimestamp, deliveries: entry.deliveries, attachments: entry.attachments })),
  }
}

export const SUBMISSIONS_TOOLS: McpToolDefinition[] = [
  organizationTool({ name: 'list_guest_conversations', domain: 'submissions', minimumRole: 'member', description: 'Read the business inbox for contacts, bookings (classes, consultations and restaurant tables) and stay conversations. Filter by type, current/past and whether a reply is needed. Follow page_info. Use request_id with get_guest_conversation to read messages and guest contact details.',
    inputSchema: { type: { type: 'string', enum: ['contact', 'booking', 'stay'] }, needs_reply: { type: 'boolean', description: 'Only conversations with an open reply task: a guest question nobody has answered yet.' }, mailbox: { type: 'string', enum: ['current', 'past'] }, location_id: { type: 'string' }, ...paginationInputSchema },
    outputSchema: { type: 'object', properties: { conversations: { type: 'array', items: { type: 'object', properties: { request_id: { type: 'string' }, guest_name: nullableString, participant_label: { type: 'string' }, reply_channel: { type: ['string', 'null'], enum: ['airbnb', 'email', 'account', null], description: 'Where reply_to_guest sends; null when the guest cannot be replied to, and reply_not_possible says why.' }, reply_not_possible: nullableString, type: { type: 'string' }, needs_reply: { type: 'boolean' }, unread: { type: 'boolean', description: 'Unread for you, as the Messages list shows it.' }, operational_status: { type: ['string', 'null'] }, updated_at: { type: 'string' } }, required: ['request_id', 'guest_name', 'participant_label', 'reply_channel', 'reply_not_possible', 'type', 'needs_reply', 'unread', 'operational_status', 'updated_at'], additionalProperties: false } }, page_info: pageInfoObject }, required: ['conversations', 'page_info'] },
  }),
  organizationTool({ name: 'create_inquiry', domain: 'submissions', minimumRole: 'admin', description: 'Record an inquiry, quote request or lead in the inbox for a named person, as the website\'s inquiry form does: their contact details, an optional message, and answers to the organization\'s inquiry questions (get_organization_settings → inquiry_questions). No appointment, capacity or payment is involved; to book a time use create_product_booking. Legal practices also require the person\'s consent acknowledgement. Reuse the same idempotency key for an identical retry; read the saved answers with get_guest_conversation.',
    inputSchema: {
      name: { type: 'string', minLength: 1, maxLength: 100 }, email: { type: 'string', minLength: 3, maxLength: 200 }, phone: { type: 'string', description: `Optional. ${PHONE_FORMAT}` },
      message: { type: 'string', maxLength: 2000, description: 'What they wrote. Required (10+ characters) when the organization has no inquiry questions; optional otherwise.' },
      answers: formAnswerInputJsonSchema(), questions_revision: { type: 'string', description: 'inquiry_questions_revision the answers were collected against; required with answers.' },
      location_id: { type: 'string', description: 'Optional location the inquiry is about.' },
      locale: { type: 'string', description: 'The language the person wrote in; defaults to the website language. Answers are matched to the questions as worded in it.' },
      consent: { type: 'boolean', description: 'Legal practices only: the person acknowledged the contact and privacy notice.' },
      source: { type: 'string', minLength: 1, maxLength: 100, description: 'Where the inquiry came from, such as phone call or event.' },
      idempotency_key: { type: 'string', minLength: 1, maxLength: 200 },
    },
    required: ['name', 'email', 'source', 'idempotency_key'],
    outputSchema: { type: 'object', properties: { success: { const: true }, request_id: { type: 'string' }, replayed: { type: 'boolean' }, answers: formAnswerSnapshotsJsonSchema() }, required: ['success', 'request_id', 'replayed', 'answers'] },
  }),
  organizationTool({ name: 'get_guest_conversation', domain: 'submissions', minimumRole: 'member', description: 'Read the entire guest conversation, including the guest\'s answers to the tenant\'s questions, messages, booking, proposals, attachments and delivery receipts. Requires request_id from the inbox or booking read.',
    inputSchema: { request_id: { type: 'string' } }, required: ['request_id'], outputSchema: conversationResult,
  }),
  organizationTool({ name: 'reply_to_guest', domain: 'submissions', minimumRole: 'member', description: 'Reply through this conversation’s reply_channel and save the reply. Airbnb replies accept text or one photo, sent separately; email replies accept text, a photo or both. A stay guest without an email is reached in their KrabiClaw inbox when they have an account; with neither, the reply is refused with GUEST_UNREACHABLE. Reuse the same key for an identical retry. A failed Airbnb attempt may retry only when retry_with_same_idempotency_key is true. Sending, uncertain or review-required attempts need review and are never blindly resent. Returns saved conversation state; use get_guest_conversation for history and delivery receipts.',
    inputSchema: { anyOf: [{ required: ['message'] }, { required: ['file'] }], request_id: { type: 'string', description: 'Conversation request_id from list_guest_conversations or a booking read.' }, message: { type: 'string', minLength: 1, pattern: '^[\\s\\S]*\\S[\\s\\S]*$', description: 'Reply text; required when no photo is attached.' }, file: { ...chatgptFileInput, description: 'Photo attachment; required when no reply text is supplied.' }, idempotency_key: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['request_id', 'idempotency_key'], fileParams: ['file'], outputSchema: conversationMutationResult,
  }),
  organizationTool({ name: 'set_guest_conversation_archived', domain: 'submissions', minimumRole: 'admin', description: 'Archive or restore the inbox conversation identified by request_id from list_guest_conversations or a booking read. Returns its saved archive state without conversation history. Does not cancel a booking and does not send the guest a message.',
    inputSchema: { request_id: { type: 'string', description: 'Conversation request_id from list_guest_conversations or a booking read.' }, archived: { type: 'boolean' }, idempotency_key: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['request_id', 'archived', 'idempotency_key'], outputSchema: conversationMutationResult,
  }),
  organizationTool({ name: 'set_guest_conversation_read', domain: 'submissions', minimumRole: 'member', description: 'Mark the inbox conversation identified by request_id read or unread for you, as swiping it in Messages does, without reading it. Changes only your own unread state; does not message the guest or change anyone else\'s. Marking unread needs an alert from the conversation that you can see; otherwise it is refused with NO_CONVERSATION_ALERT.',
    inputSchema: { request_id: { type: 'string', description: 'Conversation request_id from list_guest_conversations or a booking read.' }, read: { type: 'boolean' } }, required: ['request_id', 'read'],
    outputSchema: { type: 'object', properties: { request_id: { type: 'string' }, unread: { type: 'boolean' } }, required: ['request_id', 'unread'], additionalProperties: false },
  }),
]

export async function handleSubmissionsTools(ctx: McpExecutorContext): Promise<unknown> {
  const { toolName, args, organization } = ctx
  switch (toolName) {
    case 'create_inquiry': {
      if (!ctx.event) throw new HTTPError({ statusCode: 500, message: 'Inquiry creation requires the request context' })
      const outcome = await createInquiry(ctx.event, { organizationId: organization.organizationId, body: args,
        operator: { userId: organization.userId, idempotencyKey: requiredString(args, 'idempotency_key'), source: requiredString(args, 'source') } })
      return renderStructuredResponse({ ...outcome.body, http_status: outcome.status }, undefined, undefined, outcome.status >= 400)
    }
    case 'list_guest_conversations': {
      const principal = memberAccessPrincipal(organization.membership, { env: organization.env, event: ctx.event })
      if (await roleAllows({ ...principal, permissions: { operations: ['read'] } })) await assertMemberScope(organization.db, { ...principal, locationId: optionalString(args, 'location_id') })
      else await assertRoleAllows({ ...principal, permissions: { operations: ['assigned'] } })
      const resource = { resource: `guest-conversations:${JSON.stringify([organization.organizationId, args.type, args.needs_reply, args.mailbox, args.location_id, organization.userId])}` }
      const window = mcpPageWindow(args, resource)
      const rows = await listOrganizationGuestThreads(organization.db, { organizationId: organization.organizationId, principal, userId: organization.userId,
        type: args.type as 'contact' | 'booking' | 'stay' | undefined, needsReply: args.needs_reply === true ? true : undefined, mailbox: args.mailbox as 'current' | 'past' | undefined, locationId: optionalString(args, 'location_id'), limit: window.limit + 1, offset: window.offset })
      // Where reply_to_guest would send each one, by the reply operation's own rule, as get_guest_conversation reads it.
      const conversations = await Promise.all(rows.slice(0, window.limit).map(async row => {
        const request = await getGuestRequest(organization.db, row.id, organization.organizationId)
        if (!request) throw new HTTPError({ statusCode: 404, message: 'Guest conversation not found' })
        const destination = await guestReplyDestination(organization.db, request)
        return { request_id: row.id, guest_name: row.guestName, participant_label: row.participantLabel, reply_channel: destination.channel, reply_not_possible: destination.channel === null ? destination.reason : null,
          type: row.submissionType, needs_reply: row.needsReply, unread: row.unread, operational_status: row.operationalStatus, updated_at: row.lastActivityAt }
      }))
      return { conversations, page_info: mcpPageInfo(window, conversations.length, rows.length > window.limit, resource) }
    }
    case 'get_guest_conversation':
    case 'reply_to_guest':
    case 'set_guest_conversation_read':
    case 'set_guest_conversation_archived': {
      const requestId = requiredString(args, 'request_id')
      const thread = await getGuestRequest(organization.db, requestId, organization.organizationId)
      if (!thread) {
        throw new HTTPError({
          statusCode: 404,
          message: `Guest conversation '${requestId}' not found in this organization. Call list_guest_conversations to find valid conversation request IDs.`,
          data: { code: 'CONVERSATION_NOT_FOUND', request_id: requestId, hint: 'Call list_guest_conversations to find valid conversation request IDs.' },
        })
      }
      const principal = memberAccessPrincipal(organization.membership, { env: organization.env, event: ctx.event })
      await assertAssignedBookingAccess(organization.db, { ...principal, requestId: thread.id })
      if (toolName === 'set_guest_conversation_read') {
        if (typeof args.read !== 'boolean') throw new HTTPError({ statusCode: 400, message: 'read must be true or false', data: { code: 'VALIDATION_ERROR', field: 'read' } })
        return { request_id: thread.id, ...await setConversationRead(principal, organization.db, thread, args.read) }
      }
      if (toolName === 'get_guest_conversation') return { conversation: await readConversation(ctx, requestId) }
      const file = toolName === 'reply_to_guest' && args.file !== undefined ? toolFileReference(args.file, 'file') : null
      const outcome = await executeGuestThreadOperation(organization.db, { threadId: requestId, organizationId: organization.organizationId,
        action: toolName === 'reply_to_guest' ? 'reply' : args.archived ? 'archive' : 'unarchive', body: optionalString(args, 'message') ?? undefined,
        ...(file ? { photos: { sourceIds: [file.file_id], resolve: async () => {
          const resolved = await resolveUserUploadedMediaFile(file, MAX_IMAGE_BYTES)
          if (resolved.kind !== 'image') throw new HTTPError({ statusCode: 400, message: 'Guest replies accept photo attachments' })
          return [{ bytes: resolved.buffer, filename: resolved.filename }]
        } } } : {}),
        actorUserId: organization.userId, idempotencyKey: requiredString(args, 'idempotency_key'), env: organization.env, financialWritesAllowed: false })
      if (outcome.ok || outcome.reason === 'delivery_failed') await publishGuestInboxThreadEvent(organization.env, organization.db, { threadId: requestId, type: 'thread.changed' })
      const saved = await readConversation(ctx, requestId)
      return renderStructuredResponse({ outcome: outcome.ok ? { ok: true } : outcome, conversation: { request_id: saved.request_id, needs_reply: saved.needs_reply, archived: saved.archived, updated_at: saved.updated_at } }, undefined, undefined, !outcome.ok)
    }
    default:
      return NOT_HANDLED
  }
}
