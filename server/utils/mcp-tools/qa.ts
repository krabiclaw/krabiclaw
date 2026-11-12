import { HTTPError } from 'nitro'
import { findAuthUsersByIds } from '~/server/utils/auth'
import type { McpToolDefinition } from './shared'
import { pageInfoObject, paginationInputSchema, qaItemObject, organizationTool } from './shared'
import type { McpExecutorContext } from './execution'
import { queryAll } from '~/server/db'
import { listLocationQa, listQa, createQa, updateQa, deleteQa, reorderQa, normalizePagePath } from '~/server/utils/location-qa'
import { paginateMcpCollection } from '~/server/utils/mcp-pagination'
import { NOT_HANDLED, requiredString, assertDomainSuccess } from './execution'

const qaScope = {
  location_id: { type: ['string', 'null'], description: 'Location scope; omit or use null for site or page Q&A. A location ID cannot be combined with a non-null page_path.' },
  page_path: { type: ['string', 'null'], description: 'Page scope such as /about; omit or use null for general site or location Q&A.' },
  allOf: [{ not: { required: ['location_id', 'page_path'], properties: { location_id: { type: 'string' }, page_path: { type: 'string' } } } }],
} as const
const qaFields = {
  question: { type: 'string', description: 'Required non-empty question; at most 500 characters after trimming.' },
  answer: { type: ['string', 'null'] }, question_author: { type: ['string', 'null'] },
  is_owner_answer: { type: 'boolean' }, sort_order: { type: 'integer' }, status: { type: 'string', enum: ['published', 'hidden'] },
} as const

export const QA_TOOLS: McpToolDefinition[] = [
  organizationTool({ name: 'create_qa', description: 'Create authored Q&A in the explicit site, page or location scope. Omitted sort_order appends. This creates a new record on every call and is not idempotent: do not automatically retry an uncertain response. Imported Google content remains managed in Google.', domain: 'qa', minimumRole: 'admin', inputSchema: { ...qaScope, ...qaFields }, required: ['question'], outputSchema: { type: 'object', properties: { id: { type: 'string' }, created: { type: 'boolean' } }, required: ['id', 'created'] } }),
  organizationTool({ name: 'update_qa', description: 'Update at least one authored Q&A field in its explicit scope. Omitted fields retain their values. Imported Google records and translations cannot be edited through this tool.', domain: 'qa', minimumRole: 'admin', inputSchema: { ...qaScope, ...qaFields, qa_id: { type: 'string' }, anyOf: Object.keys(qaFields).map(field => ({ required: [field] })) }, required: ['qa_id'], outputSchema: { type: 'object', properties: { qa_id: { type: 'string' }, updated: { type: 'boolean' } }, required: ['qa_id', 'updated'] } }),
  organizationTool({ name: 'delete_qa', description: 'Delete authored Q&A and its content document tree in its explicit scope. Imported Google records are protected.', domain: 'qa', minimumRole: 'admin', inputSchema: { ...qaScope, qa_id: { type: 'string' } }, required: ['qa_id'], outputSchema: { type: 'object', properties: { qa_id: { type: 'string' }, deleted: { type: 'boolean' } }, required: ['qa_id', 'deleted'] } }),
  organizationTool({ name: 'reorder_qa', description: 'Set sort positions of authored Q&A records in one explicit scope. Every id must be distinct, manual and in scope; otherwise no record is reordered. Imported Google records are protected.', domain: 'qa', minimumRole: 'admin', inputSchema: { ...qaScope, updates: { type: 'array', minItems: 1, items: { type: 'object', properties: { id: { type: 'string', minLength: 1 }, sort_order: { type: 'integer' } }, required: ['id', 'sort_order'], additionalProperties: false } } }, required: ['updates'], outputSchema: { type: 'object', properties: { updated: { type: 'integer' } }, required: ['updated'] } }),
  organizationTool({
    name: 'list_organization_qa',
    description: 'Read the site’s general Q&A, or the Q&A of one page when page_path is provided. This tool lists authored and imported Q&A. Authored Q&A can be managed through the CMS and authored Q&A tools; imported Google question and answer content is managed in Google.',
    domain: 'qa',
    minimumRole: 'admin',
    inputSchema: { page_path: { type: ['string', 'null'], description: 'Public route path such as /about, /pricing, or /blog. Omit for general site Q&A.' }, ...paginationInputSchema },
    outputSchema: {
      type: 'object',
      properties: { items: { type: 'array', items: qaItemObject }, page_info: pageInfoObject },
      required: ['items', 'page_info'],
    },
  }),
  organizationTool({
      name: 'list_location_qa',
      description: 'Read Q&A for an explicit location. This tool lists authored and imported Q&A. Authored Q&A can be managed through the CMS and authored Q&A tools; imported Google question and answer content is managed in Google.',
      domain: 'qa',
      minimumRole: 'admin',
      inputSchema: { location_id: { type: 'string' }, ...paginationInputSchema },
      required: ['location_id'],
      outputSchema: {
        type: 'object',
        properties: { items: { type: 'array', items: qaItemObject }, page_info: pageInfoObject },
        required: ['items', 'page_info'],
      },
    }),
]

export async function handleQaTools(ctx: McpExecutorContext): Promise<unknown> {
  const { toolName, args, organization } = ctx
  const scope = {
    organizationId: organization.organizationId,
    locationId: (args.location_id ?? null) as string | null,
    pagePath: (args.page_path ?? null) as string | null,
  }
  const authoredWrite = toolName === 'create_qa' || toolName === 'update_qa' || toolName === 'reorder_qa'
  const actor = authoredWrite ? (await findAuthUsersByIds(organization.env, [organization.userId])).get(organization.userId) ?? null : null
  if (authoredWrite && !actor) throw new HTTPError({ statusCode: 401, statusMessage: 'The authenticated Q&A author was not found' })
  switch (toolName) {
    case 'create_qa': {
      const result = await createQa(organization.db, scope, { ...args, question: args.question }, actor)
      assertDomainSuccess(result)
      return result.data
    }
    case 'update_qa':
      return await updateQa(organization.db, scope, requiredString(args, 'qa_id'), args, actor)
    case 'delete_qa': {
      const result = await deleteQa(organization.db, scope, requiredString(args, 'qa_id'))
      assertDomainSuccess(result)
      return result.data
    }
    case 'reorder_qa':
      return await reorderQa(organization.db, scope, args.updates as Array<{ id: string; sort_order: number }>, actor)
    case "list_organization_qa":
      {
        const pagePath = typeof args.page_path === "string" ? args.page_path : null;
        const items = await listQa(organization.db, organization.organizationId, null, false, pagePath);
        if (pagePath) {
          const normalized = normalizePagePath(pagePath)
          const faqBlocks = await queryAll<{ id: string; data_json: string }>(organization.db, `
            SELECT cb.id, cb.data_json
            FROM content_blocks cb
            JOIN content_documents cd ON cd.id = cb.document_id
            WHERE cd.organization_id = ? AND cd.kind = 'page' AND cd.path = ? AND cb.type = 'faq'
          `, [organization.organizationId, normalized])
          for (const block of faqBlocks) {
            try {
              const data = JSON.parse(block.data_json) as Record<string, unknown>
              if (Array.isArray(data.items)) {
                for (const [index, item] of (data.items as Array<Record<string, unknown>>).entries()) {
                  if (item && typeof item === 'object') {
                    const q = typeof item.title === 'string' ? item.title : typeof item.question === 'string' ? item.question : ''
                    const a = typeof item.description === 'string' ? item.description : typeof item.answer === 'string' ? item.answer : null
                    const id = typeof item.id === 'string' && item.id ? item.id : `${block.id}-q${index}`
                    if (q && !items.some(existing => existing.id === id || existing.question === q)) {
                      items.push({
                        id,
                        organization_id: organization.organizationId,
                        location_id: null,
                        page_path: pagePath,
                        question: q,
                        question_author: null,
                        question_date: null,
                        answer: a,
                        answer_author: null,
                        answer_date: null,
                        is_owner_answer: 1,
                        upvote_count: 0,
                        source: 'manual',
                        status: 'published',
                        sort_order: items.length,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                      })
                    }
                  }
                }
              }
            } catch {
              // Ignore invalid JSON in block data
            }
          }
        }
        const page = paginateMcpCollection(items, args, { resource: `organization-qa:${organization.organizationId}:${pagePath ?? ''}` });
        return { items: page.items, page_info: page.page_info };
      }
    case "list_location_qa":
      {
        const locationId = requiredString(args, "location_id");
        const items = await listLocationQa(
          organization.db,
          organization.organizationId,
          locationId,
        );
        const page = paginateMcpCollection(items, args, { resource: `location-qa:${organization.organizationId}:${locationId}` });
        return { items: page.items, page_info: page.page_info };
      }
    default:
      return NOT_HANDLED
  }
}
