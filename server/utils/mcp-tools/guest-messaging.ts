import { organizationTool, paginationInputSchema, pageInfoObject, type McpToolDefinition } from './shared'
import { NOT_HANDLED, requiredString, type McpExecutorContext } from './execution'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { assertConversationAccess } from '~/server/domain/conversations'
import { stayAccessFor, updateStayHome } from '~/server/domain/stays'
import { cancelScheduledGuestMessage, deleteMessageTemplate, guestThreadMessagingContext, listMessageTemplates, listScheduledGuestMessages, saveMessageTemplate } from '~/server/domain/guest-messaging'
import { scheduleGuestReply } from '~/server/domain/scheduled-guest-messages'
import { mcpPageInfo, mcpPageWindow } from '~/server/utils/mcp-pagination'
import { CHANNEL_PUSH_SCHEMA } from '~/shared/channel-push'
import { AIRBNB_UNSYNCED_SCHEMA, STAY_ARRIVAL_SCHEMA } from './stays'

const text = { type: 'string', minLength: 1 }, nullableText = { type: ['string', 'null'] }
const scope = { product_ids: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { ...text, description: 'A canonical product ID of a home, experience, consultation or restaurant table product (list_products); never a provider property ID.' },
  description: 'The offerings whose bookings get this message.' } }
const event = { type: 'string', enum: ['check_in', 'check_out'], description: 'check_in is when the booking starts: a stay’s check-in, or a consultation’s, class’s or table booking’s start time. check_out is when it ends.' }
const schedule = { oneOf: [
  { type: 'object', description: 'Five minutes after KrabiClaw receives a new booking.', properties: { trigger: { const: 'booking_received' }, delay_minutes: { const: 5 }, ...scope }, required: ['trigger', 'delay_minutes', 'product_ids'], additionalProperties: false },
  { type: 'object', description: 'A number of days before or after the start or end, at a local time in the booking’s own timezone (the home’s, location’s, or an online consultation’s attorney’s).', properties: { trigger: event, offset_days: { type: 'integer', minimum: -7, maximum: 7 }, local_time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }, ...scope }, required: ['trigger', 'offset_days', 'local_time', 'product_ids'], additionalProperties: false },
  { type: 'object', description: 'A number of hours before (negative) or after (positive) the start or end itself. A home needs its check-in or checkout time.', properties: { trigger: event, offset_hours: { type: 'integer', minimum: -72, maximum: 72 }, ...scope }, required: ['trigger', 'offset_hours', 'product_ids'], additionalProperties: false },
] }
const templateFields = { id: text, organization_id: text, title: text, body: text, schedule, version: { type: 'integer', minimum: 1 }, created_at: text, updated_at: text }
const templateObject = { type: 'object', properties: templateFields, required: Object.keys(templateFields) }
const templateResult = { type: 'object', properties: { template: templateObject }, required: ['template'] }
const templateInput = { title: { ...text, maxLength: 100 }, body: { ...text, maxLength: 5000 }, schedule }
const messageFields = { id: text, organization_id: text, product_id: nullableText, booking_id: { ...nullableText, description: 'The booking an automatic message is about, a stay’s included; null for a send-later reply.' }, conversation_id: nullableText,
  author_user_id: { ...nullableText, description: 'The member whose own send-later reply this is; null for an automatic message the business sends.' }, template_id: nullableText, template_title: { ...nullableText, description: 'The automatic message’s title; null for a send-later reply.' },
  template_version: { type: ['integer', 'null'], minimum: 1 }, body: text, due_at: nullableText, timezone: { ...nullableText, description: 'The booking’s timezone for an automatic message; null for a send-later reply.' },
  status: { type: 'string', enum: ['pending', 'sending', 'sent', 'failed', 'needs_review', 'cancelled', 'skipped'] }, reason: nullableText, error_code: nullableText,
  error_field: nullableText, message_id: nullableText, started_at: nullableText, sent_at: nullableText, created_at: text, updated_at: text }
const messagingRecord = { type: ['object', 'null'], description: 'The stay or booking (a class, consultation or table) the conversation is about, as its guest reads it; null for an inquiry. starts and ends are local to timezone: a date, or a date and time.',
  properties: { unit: { type: 'string', enum: ['slot', 'nights'], description: 'nights is a stay at a home; slot is a class, consultation or table.' }, status: text, name: nullableText, location: nullableText, address: nullableText, phone: nullableText,
    party_size: { type: 'integer' }, timezone: text, starts: text, ends: text, no_show_at: nullableText },
  required: ['unit', 'status', 'name', 'location', 'address', 'phone', 'party_size', 'timezone', 'starts', 'ends', 'no_show_at'] }
const messageObject = { type: 'object', properties: messageFields, required: Object.keys(messageFields) }
const arrivalGuideFields = {
  check_in_method: nullableText, check_in_instructions: nullableText, wifi_network: nullableText, wifi_password: nullableText,
  directions: nullableText, house_manual: nullableText,
  checkout_instructions: { type: ['array', 'null'], items: { type: 'object', properties: { task: text, details: nullableText }, required: ['task', 'details'], additionalProperties: false } },
}
const arrivalGuideResult = { type: 'object', properties: {
  product_id: text, guide: { type: 'object', properties: arrivalGuideFields, additionalProperties: false },
  channel_push: CHANNEL_PUSH_SCHEMA, airbnb_unsynced: AIRBNB_UNSYNCED_SCHEMA,
}, required: ['product_id', 'guide', 'channel_push', 'airbnb_unsynced'], additionalProperties: false }
const messagingHome = { type: ['object', 'null'], properties: { product_id: text, name: text, timezone: text, ...arrivalGuideFields }, required: ['product_id', 'name', 'timezone', ...Object.keys(arrivalGuideFields)], additionalProperties: false }
const messagingStay = { type: ['object', 'null'], properties: { id: text, product_id: text, status: text, check_in_date: text, check_out_date: text, guest_name: nullableText, adults: { type: 'integer' }, children: { type: 'integer' }, infants: { type: 'integer' } }, required: ['id', 'product_id', 'status', 'check_in_date', 'check_out_date', 'guest_name', 'adults', 'children', 'infants'], additionalProperties: false }

export const GUEST_MESSAGING_TOOLS: McpToolDefinition[] = [
  organizationTool({ name: 'list_message_templates', domain: 'guest_messaging', minimumRole: 'member', description: 'Read the workspace’s automatic guest messages: text the server sends every guest or client booked on the named homes, experiences, consultations or restaurant table products, on its own schedule. Follow page_info for every page.',
    inputSchema: paginationInputSchema, outputSchema: { type: 'object', properties: { templates: { type: 'array', items: templateObject }, page_info: pageInfoObject }, required: ['templates', 'page_info'] } }),
  organizationTool({ name: 'create_message_template', domain: 'guest_messaging', minimumRole: 'admin', description: 'Create an automatic guest message, sent into the conversation of every stay, product booking (experience, consultation or restaurant table) on the named offerings, at the scheduled time in each booking’s own timezone. A cancelled booking’s pending messages are cancelled and a moved one’s follow it. It plans only eligible future events; ambiguous or nonexistent local times fail visibly. Every confirmed stay is already sent its home’s check-in instructions at 10:00 the day before arrival, so the name “Check-in instructions” is reserved.',
    inputSchema: templateInput, required: ['title', 'body', 'schedule'], outputSchema: templateResult }),
  organizationTool({ name: 'update_message_template', domain: 'guest_messaging', minimumRole: 'admin', description: 'Replace an automatic message and its schedule using the current version. Completed, failed, skipped, cancelled and uncertain deliveries are never recreated by an edit.',
    inputSchema: { template_id: text, version: { type: 'integer', minimum: 1 }, ...templateInput }, required: ['template_id', 'version', 'title', 'body', 'schedule'], outputSchema: templateResult }),
  organizationTool({ name: 'delete_message_template', domain: 'guest_messaging', minimumRole: 'admin', description: 'Delete an automatic message using its current version and cancel its pending messages. Earlier delivery snapshots remain recorded; an in-flight send cannot be recalled.',
    inputSchema: { template_id: text, version: { type: 'integer', minimum: 1 } }, required: ['template_id', 'version'], outputSchema: { type: 'object', properties: { template_id: text, status: { const: 'deleted' } }, required: ['template_id', 'status'] } }),
  organizationTool({ name: 'get_guest_messaging_context', domain: 'guest_messaging', minimumRole: 'member', description: 'Read what a canonical guest conversation is about: its booked record (a stay or booking: what, where, for how many and when, in its own timezone), and for a home its listing and stay, including private check-in instructions the host may choose to share. An inquiry has no record; a channel inquiry can have a home without a booked stay.',
    inputSchema: { conversation_id: text }, required: ['conversation_id'], outputSchema: { type: 'object', properties: { conversation_id: text, home: messagingHome, stay: messagingStay, record: messagingRecord }, required: ['conversation_id', 'home', 'stay', 'record'] } }),
  organizationTool({ name: 'update_stay_arrival_guide', domain: 'guest_messaging', minimumRole: 'admin', description: 'Save one home\'s private arrival guide: check-in method and instructions, wifi, directions, house manual and checkout instructions. Fields left out keep their values; null removes one. Saving does not send anything to a guest or publish it on the site. For a connected Airbnb home, supplied check-in, wifi, directions and house-manual fields return editor links in airbnb_unsynced for the host to check and edit in Airbnb. Checkout instructions are saved only in KrabiClaw.',
    inputSchema: { anyOf: Object.keys(STAY_ARRIVAL_SCHEMA).map(key => ({ required: [key] })), product_id: text, ...STAY_ARRIVAL_SCHEMA }, required: ['product_id'], outputSchema: arrivalGuideResult }),
  organizationTool({ name: 'list_scheduled_guest_messages', domain: 'guest_messaging', minimumRole: 'member', description: 'Read the outbox, newest first, optionally for one canonical guest conversation: your own send-later replies (author_user_id is you), and for workspace managers every automatic guest-message snapshot with its visible failure reason for every booking (booking_id names it, a stay’s included), including each stay’s built-in check-in message (template_id null, template_title “Check-in instructions”). Teammates’ send-later replies are not visible. Read provider delivery receipts through get_conversation; no provider result is inferred from a scheduled time.',
    inputSchema: { conversation_id: text, ...paginationInputSchema }, outputSchema: { type: 'object', properties: { messages: { type: 'array', items: messageObject }, page_info: pageInfoObject }, required: ['messages', 'page_info'] } }),
  organizationTool({ name: 'cancel_scheduled_guest_message', domain: 'guest_messaging', minimumRole: 'member', description: 'Cancel one pending outbox message: one of your own send-later replies, or, for a workspace manager, an automatic guest message. A message already sending, sent or requiring review cannot be cancelled or resent by this operation.',
    inputSchema: { scheduled_message_id: text }, required: ['scheduled_message_id'], outputSchema: { type: 'object', properties: { message: { type: 'object', properties: { id: text, status: { const: 'cancelled' } }, required: ['id', 'status'], additionalProperties: false } }, required: ['message'] } }),
  organizationTool({ name: 'schedule_guest_reply', domain: 'guest_messaging', minimumRole: 'member', description: 'Send your own text reply in a guest conversation later, at due_at (an ISO 8601 instant within the next year). It is sent through the conversation’s reply_channel as your reply, if you can still reach the conversation then. Only you see it pending, in list_scheduled_guest_messages; cancel it with cancel_scheduled_guest_message. Text only: send photos now with send_message.',
    inputSchema: { conversation_id: text, body: { ...text, maxLength: 5000, pattern: '^[\\s\\S]*\\S[\\s\\S]*$' }, due_at: { type: 'string', format: 'date-time' } }, required: ['conversation_id', 'body', 'due_at'], outputSchema: { type: 'object', properties: { message: messageObject }, required: ['message'] } }),
]

export async function handleGuestMessagingTools(ctx: McpExecutorContext): Promise<unknown> {
  const { args, organization, toolName } = ctx, { db, env } = organization
  const principal = memberAccessPrincipal(organization.membership, { env }), access = await stayAccessFor(principal)
  switch (toolName) {
    case 'list_message_templates': {
      const resource = `message-templates:${access.organizationId}`, window = mcpPageWindow(args, { resource })
      const page = await listMessageTemplates(db, access, window)
      return { templates: page.templates, page_info: mcpPageInfo(window, page.templates.length, page.pagination.has_more, { resource }) }
    }
    case 'create_message_template': return { template: await saveMessageTemplate(db, env, access, null, { title: args.title, body: args.body, schedule: args.schedule }) }
    case 'update_message_template': return { template: await saveMessageTemplate(db, env, access, requiredString(args, 'template_id'), { title: args.title, body: args.body, schedule: args.schedule, version: args.version }) }
    case 'delete_message_template': {
      await deleteMessageTemplate(db, env, access, requiredString(args, 'template_id'), args.version)
      return { template_id: requiredString(args, 'template_id'), status: 'deleted' }
    }
    case 'get_guest_messaging_context': {
      const saved = await guestThreadMessagingContext(db, principal, requiredString(args, 'conversation_id'))
      return { conversation_id: saved.conversation_id, record: saved.record, home: saved.home === null ? null : Object.fromEntries(Object.keys(messagingHome.properties).map(key => [key, saved.home![key as keyof NonNullable<typeof saved.home>]])), stay: saved.stay === null ? null : Object.fromEntries(Object.keys(messagingStay.properties).map(key => [key, saved.stay![key as keyof NonNullable<typeof saved.stay>]])) }
    }
    case 'update_stay_arrival_guide': {
      const { product_id: _productId, ...guide } = args
      const saved = await updateStayHome(env, db, access, requiredString(args, 'product_id'), guide)
      return { product_id: saved.home.product_id, guide: Object.fromEntries(Object.keys(guide).map(key => [key, saved.home[key as keyof typeof saved.home]])), channel_push: saved.channel_push, airbnb_unsynced: saved.airbnb_unsynced }
    }
    case 'list_scheduled_guest_messages': {
      const conversationId = typeof args.conversation_id === 'string' ? args.conversation_id : null
      if (conversationId !== null) await assertConversationAccess(db, principal, conversationId)
      const resource = `scheduled-guest-messages:${access.organizationId}:${conversationId}`, window = mcpPageWindow(args, { resource })
      const page = await listScheduledGuestMessages(db, access, window, conversationId)
      return { messages: page.messages, page_info: mcpPageInfo(window, page.messages.length, page.pagination.has_more, { resource }) }
    }
    case 'cancel_scheduled_guest_message': {
      const saved = await cancelScheduledGuestMessage(db, env, access, requiredString(args, 'scheduled_message_id'))
      return { message: { id: saved.id, status: saved.status } }
    }
    case 'schedule_guest_reply': return { message: await scheduleGuestReply(db, principal, requiredString(args, 'conversation_id'), { body: args.body, due_at: args.due_at }) }
    default: return NOT_HANDLED
  }
}
