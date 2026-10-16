import { organizationTool, paginationInputSchema, pageInfoObject, type McpToolDefinition } from './shared'
import { NOT_HANDLED, requiredString, type McpExecutorContext } from './execution'
import { memberAccessPrincipal, assertAssignedBookingAccess } from '~/server/utils/member-access'
import { stayAccessFor, updateStayHome } from '~/server/domain/stays'
import { cancelScheduledGuestMessage, deleteMessageTemplate, guestThreadMessagingContext, listMessageTemplates, listScheduledGuestMessages, saveMessageTemplate } from '~/server/domain/guest-messaging'
import { mcpPageInfo, mcpPageWindow } from '~/server/utils/mcp-pagination'
import { stayDetail, stayHomeObject } from './stays'

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

export const GUEST_MESSAGING_TOOLS: McpToolDefinition[] = [
  organizationTool({ name: 'list_message_templates', domain: 'guest_messaging', minimumRole: 'member', description: 'Read the workspace’s saved guest replies and their explicit automatic-delivery schedules. Follow page_info for every page.',
    inputSchema: paginationInputSchema, outputSchema: { type: 'object', properties: { templates: { type: 'array', items: templateObject }, page_info: pageInfoObject }, required: ['templates', 'page_info'] } }),
  organizationTool({ name: 'create_message_template', domain: 'guest_messaging', minimumRole: 'admin', description: 'Save a guest reply. schedule:null saves a quick reply without automatic delivery. An explicit schedule plans only eligible future events at the named homes in their own timezones; ambiguous or nonexistent local times fail visibly.',
    inputSchema: templateInput, required: ['title', 'body', 'schedule'], outputSchema: templateResult }),
  organizationTool({ name: 'update_message_template', domain: 'guest_messaging', minimumRole: 'admin', description: 'Replace a saved guest reply and its schedule using the current version. Completed, failed, skipped, cancelled and uncertain deliveries are never recreated by an edit.',
    inputSchema: { template_id: text, expected_version: { type: 'integer', minimum: 1 }, ...templateInput }, required: ['template_id', 'expected_version', 'title', 'body', 'schedule'], outputSchema: templateResult }),
  organizationTool({ name: 'delete_message_template', domain: 'guest_messaging', minimumRole: 'admin', description: 'Delete a saved reply using its current version and cancel its pending messages. Earlier delivery snapshots remain recorded; an in-flight send cannot be recalled.',
    inputSchema: { template_id: text, expected_version: { type: 'integer', minimum: 1 } }, required: ['template_id', 'expected_version'], outputSchema: { type: 'object', properties: { status: { const: 'deleted' } }, required: ['status'] } }),
  organizationTool({ name: 'get_guest_messaging_context', domain: 'guest_messaging', minimumRole: 'member', description: 'Read the actual home and optional stay behind a canonical guest conversation, including private check-in instructions the host may choose to share. Contact conversations may have no home or stay; channel inquiries can have a home without a booked stay.',
    inputSchema: { request_id: text }, required: ['request_id'], outputSchema: { type: 'object', properties: { requestId: text, home: { ...stayHomeObject, type: ['object', 'null'] }, stay: { ...stayDetail, type: ['object', 'null'] } }, required: ['requestId', 'home', 'stay'] } }),
  organizationTool({ name: 'set_stay_check_in_instructions', domain: 'guest_messaging', minimumRole: 'admin', description: 'Save private check-in instructions for one home; null removes them. Saving does not send the instructions to a guest or publish them on the site.',
    inputSchema: { product_id: text, instructions: { type: ['string', 'null'], minLength: 1, maxLength: 5000 } }, required: ['product_id', 'instructions'], outputSchema: { type: 'object', properties: { home: stayHomeObject }, required: ['home'] } }),
  organizationTool({ name: 'list_scheduled_guest_messages', domain: 'guest_messaging', minimumRole: 'member', description: 'Read scheduled guest-message snapshots and visible failure reasons, optionally for one canonical guest conversation. Members see only assigned homes. Read provider delivery receipts through get_guest_conversation; no provider result is inferred from a scheduled time.',
    inputSchema: { request_id: text, ...paginationInputSchema }, outputSchema: { type: 'object', properties: { messages: { type: 'array', items: messageObject }, page_info: pageInfoObject }, required: ['messages', 'page_info'] } }),
  organizationTool({ name: 'cancel_scheduled_guest_message', domain: 'guest_messaging', minimumRole: 'admin', description: 'Cancel one pending automatic guest message. A message already sending, sent or requiring review cannot be cancelled or resent by this operation.',
    inputSchema: { message_id: text }, required: ['message_id'], outputSchema: { type: 'object', properties: { message: messageObject }, required: ['message'] } }),
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
      return { status: 'deleted' }
    }
    case 'get_guest_messaging_context': return guestThreadMessagingContext(db, principal, requiredString(args, 'request_id'))
    case 'set_stay_check_in_instructions': {
      const result = await updateStayHome(env, db, access, requiredString(args, 'product_id'), { check_in_instructions: args.instructions })
      return { home: result.home }
    }
    case 'list_scheduled_guest_messages': {
      const requestId = typeof args.request_id === 'string' ? args.request_id : null
      if (requestId !== null) await assertAssignedBookingAccess(db, { ...principal, requestId })
      const resource = `scheduled-guest-messages:${access.organizationId}:${requestId}`, window = mcpPageWindow(args, { resource })
      const page = await listScheduledGuestMessages(db, access, window, requestId)
      return { messages: page.messages, page_info: mcpPageInfo(window, page.messages.length, page.pagination.hasMore, { resource }) }
    }
    case 'cancel_scheduled_guest_message': return { message: await cancelScheduledGuestMessage(db, access, requiredString(args, 'message_id')) }
    default: return NOT_HANDLED
  }
}
