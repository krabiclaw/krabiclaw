import { organizationTool, paginationInputSchema, pageInfoObject, type McpToolDefinition } from './shared'
import { NOT_HANDLED, requiredString, type McpExecutorContext } from './execution'
import { memberAccessPrincipal, assertAssignedBookingAccess } from '~/server/utils/member-access'
import { stayAccessFor, updateStayHome } from '~/server/domain/stays'
import { cancelScheduledGuestMessage, deleteMessageTemplate, guestThreadMessagingContext, listMessageTemplates, listScheduledGuestMessages, saveMessageTemplate } from '~/server/domain/guest-messaging'
import { mcpPageInfo, mcpPageWindow } from '~/server/utils/mcp-pagination'
import { CHANNEL_PUSH_SCHEMA } from '~/shared/channel-push'
import { AIRBNB_UNSYNCED_SCHEMA, STAY_ARRIVAL_SCHEMA } from './stays'

const text = { type: 'string', minLength: 1 }, nullableText = { type: ['string', 'null'] }
const products = { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { ...text, description: 'Canonical home product ID, never a provider property ID.' } }
const schedule = { oneOf: [
  { type: 'null' },
  { type: 'object', properties: { trigger: { const: 'booking_received' }, delayMinutes: { const: 5 }, productIds: products }, required: ['trigger', 'delayMinutes', 'productIds'], additionalProperties: false },
  { type: 'object', properties: { trigger: { type: 'string', enum: ['check_in', 'check_out'] }, offsetDays: { type: 'integer', minimum: -7, maximum: 7 }, localTime: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }, productIds: products }, required: ['trigger', 'offsetDays', 'localTime', 'productIds'], additionalProperties: false },
] }
const templateFields = { id: text, organizationId: text, title: text, body: text, schedule, version: { type: 'integer', minimum: 1 }, createdAt: text, updatedAt: text }
const templateObject = { type: 'object', properties: templateFields, required: Object.keys(templateFields) }
const templateResult = { type: 'object', properties: { template: templateObject }, required: ['template'] }
const templateInput = { title: { ...text, maxLength: 100 }, body: { ...text, maxLength: 5000 }, schedule }
const messageFields = { id: text, organizationId: text, productId: text, stayId: text, requestId: nullableText, templateId: nullableText, title: text,
  templateVersion: { type: 'integer', minimum: 1 }, body: text, dueAt: nullableText, timezone: text,
  status: { type: 'string', enum: ['pending', 'sending', 'sent', 'failed', 'needs_review', 'cancelled', 'skipped'] }, reason: nullableText, errorCode: nullableText,
  errorField: nullableText, entryId: nullableText, startedAt: nullableText, sentAt: nullableText, createdAt: text, updatedAt: text }
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
  organizationTool({ name: 'list_message_templates', domain: 'guest_messaging', minimumRole: 'member', description: 'Read the workspace’s saved guest replies and their explicit automatic-delivery schedules. Follow page_info for every page.',
    inputSchema: paginationInputSchema, outputSchema: { type: 'object', properties: { templates: { type: 'array', items: templateObject }, page_info: pageInfoObject }, required: ['templates', 'page_info'] } }),
  organizationTool({ name: 'create_message_template', domain: 'guest_messaging', minimumRole: 'admin', description: 'Save a guest reply. schedule:null saves a quick reply without automatic delivery. An explicit schedule plans only eligible future events at the named homes in their own timezones; ambiguous or nonexistent local times fail visibly.',
    inputSchema: templateInput, required: ['title', 'body', 'schedule'], outputSchema: templateResult }),
  organizationTool({ name: 'update_message_template', domain: 'guest_messaging', minimumRole: 'admin', description: 'Replace a saved guest reply and its schedule using the current version. Completed, failed, skipped, cancelled and uncertain deliveries are never recreated by an edit.',
    inputSchema: { template_id: text, expected_version: { type: 'integer', minimum: 1 }, ...templateInput }, required: ['template_id', 'expected_version', 'title', 'body', 'schedule'], outputSchema: templateResult }),
  organizationTool({ name: 'delete_message_template', domain: 'guest_messaging', minimumRole: 'admin', description: 'Delete a saved reply using its current version and cancel its pending messages. Earlier delivery snapshots remain recorded; an in-flight send cannot be recalled.',
    inputSchema: { template_id: text, expected_version: { type: 'integer', minimum: 1 } }, required: ['template_id', 'expected_version'], outputSchema: { type: 'object', properties: { template_id: text, status: { const: 'deleted' } }, required: ['template_id', 'status'] } }),
  organizationTool({ name: 'get_guest_messaging_context', domain: 'guest_messaging', minimumRole: 'member', description: 'Read the actual home and optional stay behind a canonical guest conversation, including private check-in instructions the host may choose to share. Contact conversations may have no home or stay; channel inquiries can have a home without a booked stay.',
    inputSchema: { request_id: text }, required: ['request_id'], outputSchema: { type: 'object', properties: { requestId: text, home: messagingHome, stay: messagingStay }, required: ['requestId', 'home', 'stay'] } }),
  organizationTool({ name: 'update_stay_arrival_guide', domain: 'guest_messaging', minimumRole: 'admin', description: 'Save one home\'s private arrival guide: check-in method and instructions, wifi, directions, house manual and checkout instructions. Fields left out keep their values; null removes one. Saving does not send anything to a guest or publish it on the site. For a connected Airbnb home, supplied check-in, wifi, directions and house-manual fields return editor links in airbnb_unsynced for the host to check and edit in Airbnb. Checkout instructions are saved only in KrabiClaw.',
    inputSchema: { anyOf: Object.keys(STAY_ARRIVAL_SCHEMA).map(key => ({ required: [key] })), product_id: text, ...STAY_ARRIVAL_SCHEMA }, required: ['product_id'], outputSchema: arrivalGuideResult }),
  organizationTool({ name: 'list_scheduled_guest_messages', domain: 'guest_messaging', minimumRole: 'member', description: 'Read scheduled guest-message snapshots and visible failure reasons, optionally for one canonical guest conversation. Members see only assigned homes. Read provider delivery receipts through get_guest_conversation; no provider result is inferred from a scheduled time.',
    inputSchema: { request_id: text, ...paginationInputSchema }, outputSchema: { type: 'object', properties: { messages: { type: 'array', items: messageObject }, page_info: pageInfoObject }, required: ['messages', 'page_info'] } }),
  organizationTool({ name: 'cancel_scheduled_guest_message', domain: 'guest_messaging', minimumRole: 'admin', description: 'Cancel one pending automatic guest message. A message already sending, sent or requiring review cannot be cancelled or resent by this operation.',
    inputSchema: { message_id: text }, required: ['message_id'], outputSchema: { type: 'object', properties: { message: { type: 'object', properties: { id: text, status: { const: 'cancelled' } }, required: ['id', 'status'], additionalProperties: false } }, required: ['message'] } }),
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
    case 'create_message_template': return { template: await saveMessageTemplate(db, access, null, { title: args.title, body: args.body, schedule: args.schedule }) }
    case 'update_message_template': return { template: await saveMessageTemplate(db, access, requiredString(args, 'template_id'), { title: args.title, body: args.body, schedule: args.schedule, expectedVersion: args.expected_version }) }
    case 'delete_message_template': {
      await deleteMessageTemplate(db, access, requiredString(args, 'template_id'), args.expected_version)
      return { template_id: requiredString(args, 'template_id'), status: 'deleted' }
    }
    case 'get_guest_messaging_context': {
      const saved = await guestThreadMessagingContext(db, principal, requiredString(args, 'request_id'))
      return { requestId: saved.requestId, home: saved.home === null ? null : Object.fromEntries(Object.keys(messagingHome.properties).map(key => [key, saved.home![key as keyof NonNullable<typeof saved.home>]])), stay: saved.stay === null ? null : Object.fromEntries(Object.keys(messagingStay.properties).map(key => [key, saved.stay![key as keyof NonNullable<typeof saved.stay>]])) }
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
      const saved = await cancelScheduledGuestMessage(db, access, requiredString(args, 'message_id'))
      return { message: { id: saved.id, status: saved.status } }
    }
    default: return NOT_HANDLED
  }
}
