import { HTTPError } from 'nitro'
import { renderStructuredResponse } from '~/server/utils/mcp-render'
import type { McpToolDefinition } from './shared'
import { organizationTool, PHONE_FORMAT } from './shared'
import type { McpExecutorContext } from './execution'
import { NOT_HANDLED, requiredString } from './execution'
import { formAnswerInputJsonSchema, formAnswerSnapshotsJsonSchema } from '~/shared/form-questions'
import { createInquiry } from '~/server/domain/inquiries'

export const SUBMISSIONS_TOOLS: McpToolDefinition[] = [
  organizationTool({ name: 'create_inquiry', domain: 'submissions', minimumRole: 'admin', description: 'Record an inquiry, quote request or lead in the inbox for a named person, as the website\'s inquiry form does: their contact details, an optional message, and answers to the organization\'s inquiry questions (get_organization_settings → inquiry_questions). No appointment, capacity or payment is involved; to book a time use create_product_booking. Legal practices also require the person\'s consent acknowledgement. Reuse the same idempotency key for an identical retry; read the saved answers with get_conversation.',
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
]

export async function handleSubmissionsTools(ctx: McpExecutorContext): Promise<unknown> {
  const { toolName, args, organization } = ctx
  if (toolName !== 'create_inquiry') return NOT_HANDLED
  if (!ctx.event) throw new HTTPError({ statusCode: 500, message: 'Inquiry creation requires the request context' })
  const outcome = await createInquiry(ctx.event, { organizationId: organization.organizationId, body: args,
    operator: { userId: organization.userId, idempotencyKey: requiredString(args, 'idempotency_key'), source: requiredString(args, 'source') } })
  return renderStructuredResponse({ ...outcome.body, http_status: outcome.status }, undefined, undefined, outcome.status >= 400)
}
