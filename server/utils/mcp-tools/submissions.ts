import { HTTPError } from 'nitro'
import { getGuestThreadDetail } from '~/server/domain/guest-threads/detail'
import { listOrganizationGuestThreads } from '~/server/domain/guest-threads/repository'
import { executeGuestThreadOperation } from '~/server/domain/guest-threads/operations'
import { getGuestRequest } from '~/server/domain/requests'
import { assertMemberScope, assertAssignedBookingAccess, roleAllows, assertRoleAllows, memberAccessPrincipal } from '~/server/utils/member-access'
import { publishGuestInboxThreadEvent } from '~/server/cloudflare/guest-inbox-events'
import { renderStructuredResponse } from '~/server/utils/mcp-render'
import { mcpPageInfo, mcpPageWindow } from '~/server/utils/mcp-pagination'
import type { McpToolDefinition } from './shared'
import { reservationSubmissionObject, organizationTool, paginationInputSchema, pageInfoObject, chatgptFileInput  } from './shared'
import type { McpExecutorContext } from './execution'
import { countReservationSubmissions, getReservationSubmissionsByStatus, listReservationSubmissions } from '~/server/utils/mcp-workflows'
import { NOT_HANDLED, optionalDaysWindow, optionalString, requiredString, resolveUserUploadedMediaFile, toolFileReference  } from './execution'
import { MAX_IMAGE_BYTES } from '~/server/utils/media-mime'

const nullableString = { type: ['string', 'null'] }
const conversationResult = { type: 'object', properties: { conversation: { type: 'object', properties: {
  request_id: { type: 'string' }, type: { type: 'string', enum: ['contact', 'reservation', 'booking', 'stay'] }, state: nullableString, archived: { type: 'boolean' }, updated_at: { type: 'string' },
  participant_label: { type: 'string' }, reply_channel: { type: 'string', enum: ['email', 'airbnb'] },
  guest: { type: 'object', properties: { name: nullableString, email: nullableString, phone: nullableString }, required: ['name', 'email', 'phone'] },
  operational_record: { type: ['object', 'null'], description: 'For a stay, check_in_date and check_out_date are its nights and id is the stay for get_stay; its starts_at and ends_at only order and archive the conversation.', properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['booking', 'reservation', 'stay'] }, status: { type: 'string' }, starts_at: { type: 'string' }, ends_at: { type: 'string' }, timezone: { type: 'string' }, party_size: { type: 'integer' }, check_in_date: nullableString, check_out_date: nullableString }, required: ['id', 'kind', 'status', 'starts_at', 'ends_at', 'timezone', 'party_size', 'check_in_date', 'check_out_date'] },
  entries: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string' }, actor: nullableString, channel: nullableString, body: nullableString, event: nullableString, occurred_at: { type: 'string' }, provider_timestamp: nullableString, payload: { type: ['object', 'null'] },
    deliveries: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, channel: { type: 'string' }, purpose: { type: 'string' }, status: { type: 'string' } }, required: ['id', 'channel', 'purpose', 'status'] } },
    attachments: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, url: { type: 'string' }, alt: nullableString, width: { type: ['integer', 'null'] }, height: { type: ['integer', 'null'] } }, required: ['id', 'url', 'alt', 'width', 'height'] } },
  }, required: ['id', 'kind', 'actor', 'channel', 'body', 'event', 'occurred_at', 'provider_timestamp', 'deliveries', 'attachments'] } },
}, required: ['request_id', 'type', 'state', 'archived', 'updated_at', 'participant_label', 'reply_channel', 'guest', 'operational_record', 'entries'] } }, required: ['conversation'] }
const conversationMutationResult = { type: 'object', properties: {
  outcome: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] },
  conversation: { type: 'object', properties: { request_id: { type: 'string' }, state: nullableString, archived: { type: 'boolean' }, updated_at: { type: 'string' } }, required: ['request_id', 'state', 'archived', 'updated_at'], additionalProperties: false },
}, required: ['outcome', 'conversation'], additionalProperties: false }

async function readConversation(ctx: McpExecutorContext, requestId: string) {
  const { db, organizationId } = ctx.organization
  const detail = await getGuestThreadDetail(db, requestId, organizationId)
  if (!detail) throw new HTTPError({ statusCode: 404, message: 'Guest conversation not found' })
  return { request_id: detail.id, type: detail.submissionType, state: detail.conversationState, archived: detail.manuallyArchived, updated_at: detail.updatedAt,
    participant_label: detail.participantLabel, reply_channel: detail.replyChannel,
    guest: { name: detail.guestName, email: detail.guestEmail, phone: detail.guestPhone }, operational_record: detail.operationalRecord,
    entries: detail.entries.map(entry => ({ id: entry.id, kind: entry.kind, actor: entry.actorLabel, channel: entry.channel, body: entry.body, event: entry.eventName, payload: entry.payload, occurred_at: entry.occurredAt, provider_timestamp: entry.providerTimestamp, deliveries: entry.deliveries, attachments: entry.attachments })),
  }
}

export const SUBMISSIONS_TOOLS: McpToolDefinition[] = [
  organizationTool({ name: 'list_guest_conversations', domain: 'submissions', minimumRole: 'member', description: 'Read the business inbox for contacts, table reservations, bookings and stay conversations. Filter by type, current/past and whether a reply is needed. Follow page_info; use request_id to read the whole conversation.',
    inputSchema: { type: { type: 'string', enum: ['contact', 'reservation', 'booking', 'stay'] }, state: { type: 'string', enum: ['needs_attention', 'waiting_on_guest', 'resolved'] }, mailbox: { type: 'string', enum: ['current', 'past'] }, location_id: { type: 'string' }, ...paginationInputSchema },
    outputSchema: { type: 'object', properties: { conversations: { type: 'array', items: { type: 'object', properties: { request_id: { type: 'string' }, guest_name: nullableString, participant_label: { type: 'string' }, reply_channel: { type: 'string', enum: ['email', 'airbnb'] }, type: { type: 'string' }, state: { type: 'string' }, operational_status: { type: ['string', 'null'] }, preview: { type: ['string', 'null'] }, updated_at: { type: 'string' } }, required: ['request_id', 'guest_name', 'participant_label', 'reply_channel', 'type', 'state', 'operational_status', 'preview', 'updated_at'] } }, page_info: pageInfoObject }, required: ['conversations', 'page_info'] },
  }),
  organizationTool({ name: 'get_guest_conversation', domain: 'submissions', minimumRole: 'member', description: 'Read the entire guest conversation, including messages, booking/reservation, proposals, attachments and delivery receipts. Requires request_id from the inbox or booking read.',
    inputSchema: { request_id: { type: 'string' } }, required: ['request_id'], outputSchema: conversationResult,
  }),
  organizationTool({ name: 'reply_to_guest', domain: 'submissions', minimumRole: 'member', description: 'Reply through this conversation’s reply_channel and save the reply. Airbnb replies accept text; email replies accept text, a photo or both. A stay guest without an email is reached in their KrabiClaw inbox once they accept the host’s invite link; until then the reply is refused with GUEST_INVITE_REQUIRED and the host shares an invite from the KrabiClaw app. Reuse the same key for an identical retry. A pending or uncertain Airbnb send needs review and is never resent automatically. Returns saved conversation state; use get_guest_conversation for history and delivery receipts.',
    inputSchema: { anyOf: [{ required: ['message'] }, { required: ['file'] }], request_id: { type: 'string', description: 'Conversation request_id from list_guest_conversations or a booking read.' }, message: { type: 'string', minLength: 1, pattern: '\\S', description: 'Reply text; required when no photo is attached.' }, file: { ...chatgptFileInput, description: 'Photo attachment; required when no reply text is supplied.' }, idempotency_key: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['request_id', 'idempotency_key'], fileParams: ['file'], outputSchema: conversationMutationResult,
  }),
  organizationTool({ name: 'set_guest_conversation_archived', domain: 'submissions', minimumRole: 'admin', description: 'Archive or restore the inbox conversation identified by request_id from list_guest_conversations or a booking read. Returns its saved archive state without conversation history. Does not cancel a booking or reservation and does not send the guest a message.',
    inputSchema: { request_id: { type: 'string', description: 'Conversation request_id from list_guest_conversations or a booking read.' }, archived: { type: 'boolean' }, idempotency_key: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['request_id', 'archived', 'idempotency_key'], outputSchema: conversationMutationResult,
  }),
  organizationTool({
      name: 'list_table_reservations',
      description: "Read table reservations for the selected site, optionally filtered by location and creation window of up to 90 days. Returns guest contact details, reservation details and status counts. Use list_product_bookings to read product session bookings and consultations.",
      domain: 'submissions',
      minimumRole: 'admin',
      inputSchema: {
        ...paginationInputSchema,
        location_id: { type: 'string', description: 'Optional location id to list only that location\'s reservations.' },
        days: { type: 'number', description: 'Optional: only include reservations made in the last N days (max 90).' },
      },
      outputSchema: {
        type: 'object',
        properties: {
          submissions: { type: 'array', items: reservationSubmissionObject },
          page_info: pageInfoObject,
          summary: {
            type: 'object',
            properties: {
              total: { type: 'number' },
              by_status: { type: 'object', description: 'Count of reservations per status.' },
            },
            required: ['total', 'by_status'],
          },
        },
        required: ['submissions', 'summary', 'page_info'],
      },
    }),
]

export async function handleSubmissionsTools(ctx: McpExecutorContext): Promise<unknown> {
  const { toolName, args, organization } = ctx
  switch (toolName) {
    case 'list_guest_conversations': {
      const principal = memberAccessPrincipal(organization.membership, { env: organization.env, event: ctx.event })
      if (await roleAllows({ ...principal, permissions: { operations: ['read'] } })) await assertMemberScope(organization.db, { ...principal, locationId: optionalString(args, 'location_id') })
      else await assertRoleAllows({ ...principal, permissions: { operations: ['assigned'] } })
      const resource = { resource: `guest-conversations:${JSON.stringify([organization.organizationId, args.type, args.state, args.mailbox, args.location_id, organization.userId])}` }
      const window = mcpPageWindow(args, resource)
      const rows = await listOrganizationGuestThreads(organization.db, { organizationId: organization.organizationId, principal, userId: organization.userId,
        type: args.type as 'contact' | 'reservation' | 'booking' | 'stay' | undefined, conversationState: args.state as 'needs_attention' | 'waiting_on_guest' | 'resolved' | undefined, mailbox: args.mailbox as 'current' | 'past' | undefined, locationId: optionalString(args, 'location_id'), limit: window.limit + 1, offset: window.offset })
      const conversations = rows.slice(0, window.limit).map(row => ({ request_id: row.id, guest_name: row.guestName, participant_label: row.participantLabel, reply_channel: row.replyChannel, type: row.submissionType, state: row.conversationState, operational_status: row.operationalStatus, preview: row.preview?.text ?? null, updated_at: row.lastActivityAt }))
      return { conversations, page_info: mcpPageInfo(window, conversations.length, rows.length > window.limit, resource) }
    }
    case 'get_guest_conversation':
    case 'reply_to_guest':
    case 'set_guest_conversation_archived': {
      const requestId = requiredString(args, 'request_id')
      const thread = await getGuestRequest(organization.db, requestId, organization.organizationId)
      if (!thread) throw new HTTPError({ statusCode: 404, message: 'Guest conversation not found' })
      await assertAssignedBookingAccess(organization.db, { ...memberAccessPrincipal(organization.membership, { env: organization.env, event: ctx.event }), requestId: thread.id })
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
      return renderStructuredResponse({ outcome: outcome.ok ? { ok: true } : outcome, conversation: { request_id: saved.request_id, state: saved.state, archived: saved.archived, updated_at: saved.updated_at } }, undefined, undefined, !outcome.ok)
    }
    case "list_table_reservations": {
      const reservationFilter = {
        locationId: optionalString(args, "location_id") ?? null,
        sinceDays: optionalDaysWindow(args, "days"),
      };
      const resource = { resource: `reservation-inquiries:${JSON.stringify([organization.organizationId, reservationFilter])}` }
      const window = mcpPageWindow(args, resource)
      const [rows, total, byStatus] = await Promise.all([
        listReservationSubmissions(organization.db, organization.organizationId, reservationFilter, { limit: window.limit + 1, offset: window.offset }),
        countReservationSubmissions(organization.db, organization.organizationId, reservationFilter),
        getReservationSubmissionsByStatus(organization.db, organization.organizationId, reservationFilter),
      ]);
      const submissions = rows.slice(0, window.limit)
      return {
        submissions,
        page_info: mcpPageInfo(window, submissions.length, rows.length > window.limit, resource),
        summary: { total, by_status: byStatus },
      };
    }
    default:
      return NOT_HANDLED
  }
}
