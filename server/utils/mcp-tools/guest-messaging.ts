import { organizationTool, paginationInputSchema, pageInfoObject, type McpToolDefinition } from './shared'
import { NOT_HANDLED, requiredString, type McpExecutorContext } from './execution'
import { memberAccessPrincipal, assertAssignedBookingAccess } from '~/server/utils/member-access'
import { stayAccessFor, updateStayHome } from '~/server/domain/stays'
import { cancelScheduledGuestMessage, deleteMessageTemplate, guestThreadMessagingContext, listMessageTemplates, listScheduledGuestMessages, saveMessageTemplate } from '~/server/domain/guest-messaging'
import { cancelSendLaterMessage, createSendLaterMessage, listSendLaterMessages } from '~/server/domain/send-later'
import { mcpPageInfo, mcpPageWindow } from '~/server/utils/mcp-pagination'
import { CHANNEL_PUSH_SCHEMA } from '~/shared/channel-push'
import { AIRBNB_UNSYNCED_SCHEMA, STAY_ARRIVAL_SCHEMA } from './stays'

const text = { type: 'string', minLength: 1 }, nullableText = { type: ['string', 'null'] }
const scope = { productIds: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { ...text, description: 'A canonical product ID of a home, experience, consultation or restaurant table product (list_products); never a provider property ID.' },
  description: 'The offerings whose bookings get this message.' } }
const event = { type: 'string', enum: ['check_in', 'check_out'], description: 'check_in is when the booking starts: a stay’s check-in, or a consultation’s, class’s or table booking’s start time. check_out is when it ends.' }
const schedule = { oneOf: [
  { type: 'object', description: 'Five minutes after KrabiClaw receives a new booking.', properties: { trigger: { const: 'booking_received' }, delayMinutes: { const: 5 }, ...scope }, required: ['trigger', 'delayMinutes', 'productIds'], additionalProperties: false },
  { type: 'object', description: 'A number of days before or after the start or end, at a local time in the booking’s own timezone (the home’s, location’s, or an online consultation’s attorney’s).', properties: { trigger: event, offsetDays: { type: 'integer', minimum: -7, maximum: 7 }, localTime: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }, ...scope }, required: ['trigger', 'offsetDays', 'localTime', 'productIds'], additionalProperties: false },
  { type: 'object', description: 'A number of hours before (negative) or after (positive) the start or end itself. A home needs its check-in or checkout time.', properties: { trigger: event, offsetHours: { type: 'integer', minimum: -72, maximum: 72 }, ...scope }, required: ['trigger', 'offsetHours', 'productIds'], additionalProperties: false },
] }
const templateFields = { id: text, organizationId: text, title: text, body: text, schedule, version: { type: 'integer', minimum: 1 }, createdAt: text, updatedAt: text }
const templateObject = { type: 'object', properties: templateFields, required: Object.keys(templateFields) }
const templateResult = { type: 'object', properties: { template: templateObject }, required: ['template'] }
const templateInput = { title: { ...text, maxLength: 100 }, body: { ...text, maxLength: 5000 }, schedule }
const messageFields = { id: text, organizationId: text, productId: text, bookingId: { ...text, description: 'The booking the message is about, a stay’s included.' }, requestId: nullableText, templateId: nullableText, title: text,
  templateVersion: { type: 'integer', minimum: 1 }, body: text, dueAt: nullableText, timezone: text,
  status: { type: 'string', enum: ['pending', 'sending', 'sent', 'failed', 'needs_review', 'cancelled', 'skipped'] }, reason: nullableText, errorCode: nullableText,
  errorField: nullableText, entryId: nullableText, startedAt: nullableText, sentAt: nullableText, createdAt: text, updatedAt: text }
const messagingRecord = { type: ['object', 'null'], description: 'The stay or booking (a class, consultation or table) the conversation is about, as its guest reads it; null for an inquiry. starts and ends are local to timezone: a date, or a date and time.',
  properties: { unit: { type: 'string', enum: ['slot', 'nights'], description: 'nights is a stay at a home; slot is a class, consultation or table.' }, status: text, offering: nullableText, location: nullableText, address: nullableText, phone: nullableText,
    partySize: { type: 'integer' }, timezone: text, starts: text, ends: text, noShow: { type: 'boolean' } },
  required: ['unit', 'status', 'offering', 'location', 'address', 'phone', 'partySize', 'timezone', 'starts', 'ends', 'noShow'] }
const messageObject = { type: 'object', properties: messageFields, required: Object.keys(messageFields) }
const replyFields = { id: text, organizationId: text, threadId: text, body: text, sendAt: text,
  status: { type: 'string', enum: ['pending', 'sending', 'sent', 'failed', 'needs_review', 'cancelled'] }, reason: nullableText, errorCode: nullableText,
  errorField: nullableText, entryId: nullableText, version: { type: 'integer', minimum: 1 }, sentAt: nullableText, createdAt: text, updatedAt: text }
const replyObject = { type: 'object', properties: replyFields, required: Object.keys(replyFields) }
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
    inputSchema: { template_id: text, expected_version: { type: 'integer', minimum: 1 }, ...templateInput }, required: ['template_id', 'expected_version', 'title', 'body', 'schedule'], outputSchema: templateResult }),
  organizationTool({ name: 'delete_message_template', domain: 'guest_messaging', minimumRole: 'admin', description: 'Delete an automatic message using its current version and cancel its pending messages. Earlier delivery snapshots remain recorded; an in-flight send cannot be recalled.',
    inputSchema: { template_id: text, expected_version: { type: 'integer', minimum: 1 } }, required: ['template_id', 'expected_version'], outputSchema: { type: 'object', properties: { template_id: text, status: { const: 'deleted' } }, required: ['template_id', 'status'] } }),
  organizationTool({ name: 'get_guest_messaging_context', domain: 'guest_messaging', minimumRole: 'member', description: 'Read what a canonical guest conversation is about: its booked record (a stay or booking: what, where, for how many and when, in its own timezone), and for a home its listing and stay, including private check-in instructions the host may choose to share. An inquiry has no record; a channel inquiry can have a home without a booked stay.',
    inputSchema: { request_id: text }, required: ['request_id'], outputSchema: { type: 'object', properties: { requestId: text, home: messagingHome, stay: messagingStay, record: messagingRecord }, required: ['requestId', 'home', 'stay', 'record'] } }),
  organizationTool({ name: 'update_stay_arrival_guide', domain: 'guest_messaging', minimumRole: 'admin', description: 'Save one home\'s private arrival guide: check-in method and instructions, wifi, directions, house manual and checkout instructions. Fields left out keep their values; null removes one. Saving does not send anything to a guest or publish it on the site. For a connected Airbnb home, supplied check-in, wifi, directions and house-manual fields return editor links in airbnb_unsynced for the host to check and edit in Airbnb. Checkout instructions are saved only in KrabiClaw.',
    inputSchema: { anyOf: Object.keys(STAY_ARRIVAL_SCHEMA).map(key => ({ required: [key] })), product_id: text, ...STAY_ARRIVAL_SCHEMA }, required: ['product_id'], outputSchema: arrivalGuideResult }),
  organizationTool({ name: 'list_scheduled_guest_messages', domain: 'guest_messaging', minimumRole: 'admin', description: 'Read automatic guest-message snapshots and visible failure reasons for every booking (bookingId names it, a stay’s included), optionally for one canonical guest conversation, including each stay’s built-in check-in message (templateId null, title “Check-in instructions”). Read provider delivery receipts through get_guest_conversation; no provider result is inferred from a scheduled time.',
    inputSchema: { request_id: text, ...paginationInputSchema }, outputSchema: { type: 'object', properties: { messages: { type: 'array', items: messageObject }, page_info: pageInfoObject }, required: ['messages', 'page_info'] } }),
  organizationTool({ name: 'cancel_scheduled_guest_message', domain: 'guest_messaging', minimumRole: 'admin', description: 'Cancel one pending automatic guest message. A message already sending, sent or requiring review cannot be cancelled or resent by this operation.',
    inputSchema: { message_id: text }, required: ['message_id'], outputSchema: { type: 'object', properties: { message: { type: 'object', properties: { id: text, status: { const: 'cancelled' } }, required: ['id', 'status'], additionalProperties: false } }, required: ['message'] } }),
  organizationTool({ name: 'schedule_guest_reply', domain: 'guest_messaging', minimumRole: 'member', description: 'Send your own text reply in a guest conversation later, at send_at (an ISO 8601 instant within the next year). It is sent through the conversation’s reply_channel as your reply, if you can still reach the conversation then. Only you see it pending; cancel it with cancel_scheduled_reply. Text only: send photos now with reply_to_guest.',
    inputSchema: { request_id: text, message: { ...text, maxLength: 5000, pattern: '^[\\s\\S]*\\S[\\s\\S]*$' }, send_at: { type: 'string', format: 'date-time' } }, required: ['request_id', 'message', 'send_at'], outputSchema: { type: 'object', properties: { reply: replyObject }, required: ['reply'] } }),
  organizationTool({ name: 'list_scheduled_replies', domain: 'guest_messaging', minimumRole: 'member', description: 'Read your own replies scheduled with schedule_guest_reply that have not been sent, and any that failed, optionally for one conversation. Teammates’ scheduled replies are not visible.',
    inputSchema: { request_id: text }, outputSchema: { type: 'object', properties: { replies: { type: 'array', items: replyObject } }, required: ['replies'] } }),
  organizationTool({ name: 'cancel_scheduled_reply', domain: 'guest_messaging', minimumRole: 'member', description: 'Cancel one of your own scheduled replies before it starts sending.',
    inputSchema: { message_id: text }, required: ['message_id'], outputSchema: { type: 'object', properties: { reply: replyObject }, required: ['reply'] } }),
]

export async function handleGuestMessagingTools(ctx: McpExecutorContext): Promise<unknown> {
  const { args, organization, toolName } = ctx, { db, env } = organization
  const principal = memberAccessPrincipal(organization.membership, { env }), access = await stayAccessFor(principal)
  switch (toolName) {
    case 'list_message_templates': {
      const resource = `message-templates:${access.organizationId}`, window = mcpPageWindow(args, { resource })
      const page = await listMessageTemplates(db, access, window)
      return { templates: page.templates, page_info: mcpPageInfo(window, page.templates.length, page.pagination.hasMore, { resource }) }
    }
    case 'create_message_template': return { template: await saveMessageTemplate(db, env, access, null, { title: args.title, body: args.body, schedule: args.schedule }) }
    case 'update_message_template': return { template: await saveMessageTemplate(db, env, access, requiredString(args, 'template_id'), { title: args.title, body: args.body, schedule: args.schedule, expectedVersion: args.expected_version }) }
    case 'delete_message_template': {
      await deleteMessageTemplate(db, env, access, requiredString(args, 'template_id'), args.expected_version)
      return { template_id: requiredString(args, 'template_id'), status: 'deleted' }
    }
    case 'get_guest_messaging_context': {
      const saved = await guestThreadMessagingContext(db, principal, requiredString(args, 'request_id'))
      return { requestId: saved.requestId, record: saved.record, home: saved.home === null ? null : Object.fromEntries(Object.keys(messagingHome.properties).map(key => [key, saved.home![key as keyof NonNullable<typeof saved.home>]])), stay: saved.stay === null ? null : Object.fromEntries(Object.keys(messagingStay.properties).map(key => [key, saved.stay![key as keyof NonNullable<typeof saved.stay>]])) }
    }
    case 'update_stay_arrival_guide': {
      const { product_id: _productId, ...guide } = args
      const saved = await updateStayHome(env, db, access, requiredString(args, 'product_id'), guide)
      return { product_id: saved.home.product_id, guide: Object.fromEntries(Object.keys(guide).map(key => [key, saved.home[key as keyof typeof saved.home]])), channel_push: saved.channel_push, airbnb_unsynced: saved.airbnb_unsynced }
    }
    case 'list_scheduled_guest_messages': {
      const requestId = typeof args.request_id === 'string' ? args.request_id : null
      if (requestId !== null) await assertAssignedBookingAccess(db, { ...principal, requestId })
      const resource = `scheduled-guest-messages:${access.organizationId}:${requestId}`, window = mcpPageWindow(args, { resource })
      const page = await listScheduledGuestMessages(db, access, window, requestId)
      return { messages: page.messages, page_info: mcpPageInfo(window, page.messages.length, page.pagination.hasMore, { resource }) }
    }
    case 'cancel_scheduled_guest_message': {
      const saved = await cancelScheduledGuestMessage(db, env, access, requiredString(args, 'message_id'))
      return { message: { id: saved.id, status: saved.status } }
    }
    case 'schedule_guest_reply': return { reply: await createSendLaterMessage(db, principal, requiredString(args, 'request_id'), { body: args.message, sendAt: args.send_at }) }
    case 'list_scheduled_replies': return { replies: await listSendLaterMessages(db, principal, typeof args.request_id === 'string' ? args.request_id : null) }
    case 'cancel_scheduled_reply': return { reply: await cancelSendLaterMessage(db, principal, requiredString(args, 'message_id')) }
    default: return NOT_HANDLED
  }
}
