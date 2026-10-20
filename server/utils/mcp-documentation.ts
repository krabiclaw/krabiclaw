import { createHash } from 'node:crypto'
import { queryFirst, type DbClient } from '~/server/db'
import { canonicalCatalogSnapshot } from '~/server/utils/mcp-catalog'
import { getPlatformOrganization } from '~/server/utils/platform-organization'
import type { McpToolDefinition } from '~/server/utils/mcp-tools/shared'

/** An entire source-mode Markdown block opts a CMS article into the deployed reference. */
export const MCP_TOOL_REFERENCE_DIRECTIVE = '<!-- krabiclaw:mcp-tool-reference -->'

interface DocumentationBlock {
  type: string
  data: Record<string, unknown>
}

export interface McpDocumentationScope {
  organizationId: string
  platformOrganizationId: string
  kind: string
  collection: string | null
}

export function mcpDocumentationToolContract(tool: McpToolDefinition) {
  return {
    ...canonicalCatalogSnapshot([tool])[0]!,
    domain: tool.domain,
    minimumRole: tool.minimumRole,
    requiredEntitlement: tool.requiredEntitlement ?? null,
    fileParams: tool.fileParams ?? [],
    uiResourceUri: tool.uiResourceUri ?? null,
  }
}

/** Includes permissions and entitlements as well as the public JSON Schemas. */
export function mcpDocumentationFingerprint(tools: McpToolDefinition[]) {
  const contracts = [...tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map(mcpDocumentationToolContract)
  return `sha256:${createHash('sha256').update(JSON.stringify(contracts)).digest('hex')}`
}

function tableText(value: unknown) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

function schemaObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function schemaType(schema: Record<string, unknown>): string {
  if (typeof schema.$ref === 'string') return schema.$ref
  if (Array.isArray(schema.type)) return schema.type.join(' or ')
  if (typeof schema.type === 'string') {
    return schema.type === 'array' ? `array of ${schemaType(schemaObject(schema.items))}` : schema.type
  }
  const variants = schema.anyOf ?? schema.oneOf
  if (Array.isArray(variants)) return [...new Set(variants.map(value => schemaType(schemaObject(value))))].join(' or ')
  if (Array.isArray(schema.enum)) return 'enum'
  if ('const' in schema) return typeof schema.const
  return 'See schema'
}

const STRUCTURAL_SCHEMA_FIELDS = new Set(['type', 'title', 'description', 'properties', 'items', 'anyOf', 'oneOf', 'allOf', '$defs', '$ref'])

function schemaConstraints(schema: Record<string, unknown>) {
  return Object.entries(schema).filter(([key]) => !STRUCTURAL_SCHEMA_FIELDS.has(key))
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('; ')
}

function referencedSchema(ref: string, root: Record<string, unknown>) {
  if (!ref.startsWith('#/')) throw new Error(`Documentation requires a local JSON Schema reference: ${ref}`)
  let target: unknown = root
  for (const part of ref.slice(2).split('/')) target = schemaObject(target)[part.replace(/~1/g, '/').replace(/~0/g, '~')]
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error(`Documentation JSON Schema reference is missing: ${ref}`)
  return target as Record<string, unknown>
}

function dereferenceSchema(schema: Record<string, unknown>, root: Record<string, unknown>) {
  const seen = new Set<string>()
  while (typeof schema.$ref === 'string') {
    if (seen.has(schema.$ref)) throw new Error(`Circular JSON Schema alias: ${schema.$ref}`)
    seen.add(schema.$ref)
    const { $ref, ...siblings } = schema
    schema = { ...referencedSchema($ref as string, root), ...siblings }
  }
  return schema
}

/** Shared shapes are a rendering projection, never a second schema registry or persisted catalog. */
function sharedSchemaShapes() {
  const shapes = new Map<string, { schema: Record<string, unknown>; root: Record<string, unknown>; serialized: string }>()
  function register(value: Record<string, unknown>, root: Record<string, unknown>) {
    const { $defs: _definitions, ...schema } = dereferenceSchema(value, root)
    const dependencies = new Map<string, Record<string, unknown>>()
    function visit(node: unknown) {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(visit)
      const object = node as Record<string, unknown>
      if (typeof object.$ref === 'string' && !dependencies.has(object.$ref)) {
        const target = referencedSchema(object.$ref, root)
        dependencies.set(object.$ref, target)
        visit(target)
      }
      for (const [key, child] of Object.entries(object)) if (key !== '$defs') visit(child)
    }
    visit(schema)
    const serialized = JSON.stringify({ schema, dependencies: Object.fromEntries([...dependencies].sort(([a], [b]) => a.localeCompare(b))) })
    const id = `schema-${createHash('sha256').update(serialized).digest('hex').slice(0, 16)}`
    const prior = shapes.get(id)
    if (prior && prior.serialized !== serialized) throw new Error('Documentation schema anchor collision')
    if (!prior) shapes.set(id, { schema, root, serialized })
    return id
  }
  return { shapes, register }
}

type SchemaShapes = ReturnType<typeof sharedSchemaShapes>

function schemaTable(schema: Record<string, unknown>, label: string, root: Record<string, unknown>, shapes: SchemaShapes) {
  const properties = Object.entries(schemaObject(schema.properties))
  if (!properties.length) return `${label}: ${schemaType(schema)}.`
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  return [
    '| Field | Type | Required | Description and constraints |',
    '| --- | --- | --- | --- |',
    ...properties.map(([name, value]) => {
      const field = dereferenceSchema(schemaObject(value), root)
      const description = [field.description, schemaConstraints(field)].filter(Boolean).join(' ')
      const nested = field.properties || field.items || field.anyOf || field.oneOf || field.allOf
      const type = `${tableText(schemaType(field))}${nested ? ` ([fields](#${shapes.register(field, root)}))` : ''}`
      return `| \`${tableText(name)}\` | ${type} | ${required.has(name) ? 'Yes' : 'No'} | ${tableText(description)} |`
    }),
  ].join('\n')
}

function schemaShapeDetails(schema: Record<string, unknown>, root: Record<string, unknown>, shapes: SchemaShapes) {
  const lines = [schemaConstraints(schema)]
  if (schema.items) lines.push(`Array items: [${schemaType(schemaObject(schema.items))}](#${shapes.register(schemaObject(schema.items), root)}).`)
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    const branches = schema[keyword]
    if (Array.isArray(branches)) lines.push(`${keyword}: ${branches.map((branch, index) => `[shape ${index + 1}](#${shapes.register(schemaObject(branch), root)})`).join(', ')}.`)
  }
  return lines.filter(Boolean).join('\n\n')
}

export function renderMcpToolReference(tools: McpToolDefinition[]) {
  if (!tools.length) throw new Error('The public MCP tool catalog is empty')
  const sorted = [...tools].sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name))
  const domains = [...new Set(sorted.map(tool => tool.domain))]
  const shapes = sharedSchemaShapes()
  const lines = [
    'This reference is generated from the tool definitions running on this server. It updates when those definitions are deployed.',
    '',
    `Reference fingerprint: \`${mcpDocumentationFingerprint(tools)}\``,
    '',
    `Tools: ${tools.length}.`,
    '',
    'Connect with [the setup guide](/docs/mcp-setup), then read [what AI assistants can do](/docs/what-you-can-edit-through-chatgpt). Select the intended business and use its internal IDs returned by the tools. Permissions and entitlements are checked when each operation runs.',
    '',
    'For step-by-step tasks, see [menu updates](/docs/update-your-menu-with-an-ai-assistant), [bookings](/docs/manage-your-bookings), [photos and video](/docs/add-photos-and-video), [publishing a post](/docs/publish-a-post), and [guest messages and requests](/docs/handle-inquiries-and-reservation-requests).',
    '',
    'Before asking an assistant to change data, review the business, records and intended result. Tool descriptions specify any operation-specific approval steps. Client confirmation controls depend on your AI assistant. Read-only, destructive, open-world and idempotent hints describe the tool; they do not grant permission or approve an operation.',
    '',
    'Input and output tables list each field, its required state and schema constraints. Nested objects, array items and schema alternatives link to shared shapes below. These shapes are generated from the same definitions, including local JSON Schema references.',
    '',
    '## Tool groups',
    '',
    ...domains.map(domain => `- **${domain.replace(/_/g, ' ')}**: ${sorted.filter(tool => tool.domain === domain).map(tool => `[\`${tool.name}\`](#${tool.name})`).join(', ')}`),
  ]
  for (const domain of domains) {
    lines.push('', `## ${domain.charAt(0).toUpperCase() + domain.slice(1).replace(/_/g, ' ')}`)
    for (const tool of sorted.filter(item => item.domain === domain)) {
      if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) throw new Error(`Tool name cannot form a documentation anchor: ${tool.name}`)
      const contract = mcpDocumentationToolContract(tool)
      lines.push('', `<a id="${tool.name}"></a>`, '', `### ${tool.title} — \`${tool.name}\``, '', tool.description, '',
        `Minimum role: **${tool.minimumRole}**. Required entitlement: **${tool.requiredEntitlement ?? 'None'}**.`, '',
        `Annotations: ${Object.entries(tool.annotations).map(([name, value]) => `\`${name}: ${value}\``).join(', ')}.`, '',
        `Authentication: ${tool.securitySchemes.map(scheme => `${scheme.type}, scopes ${scheme.scopes.map(scope => `\`${scope}\``).join(', ')}`).join('; ')}.`, '',
        '#### Input', '', schemaTable(contract.inputSchema, 'Input', contract.inputSchema, shapes), '', schemaShapeDetails(contract.inputSchema, contract.inputSchema, shapes), '',
        '#### Output', '', schemaTable(contract.outputSchema, 'Output', contract.outputSchema, shapes), '', schemaShapeDetails(contract.outputSchema, contract.outputSchema, shapes))
      if (tool.fileParams?.length) lines.push('', `File parameters: ${tool.fileParams.map(name => `\`${name}\``).join(', ')}.`)
      if (tool.uiResourceUri) lines.push('', `UI resource: \`${tool.uiResourceUri}\`.`)
    }
  }
  if (shapes.shapes.size) lines.push('', '## Shared field shapes')
  for (const [id, shape] of shapes.shapes) {
    lines.push('', `<a id="${id}"></a>`, '', `#### ${schemaType(shape.schema)} fields`, '',
      schemaTable(shape.schema, 'Value', shape.root, shapes), '', schemaShapeDetails(shape.schema, shape.root, shapes))
  }
  return lines.join('\n')
}

export function hasMcpToolReference(blocks: DocumentationBlock[]) {
  return blocks.some(block => block.type === 'markdown' && block.data.markdown === MCP_TOOL_REFERENCE_DIRECTIVE)
}

/** Public projection only: editors retain the directive instead of storing the generated catalog. */
export function expandMcpDocumentationBlocks<T extends DocumentationBlock>(blocks: T[], scope: McpDocumentationScope, markdown: string): T[] {
  if (!hasMcpToolReference(blocks)) return blocks
  if (scope.organizationId !== scope.platformOrganizationId || scope.kind !== 'article' || scope.collection !== 'docs') {
    throw new Error('The MCP tool reference directive requires a documentation article in the platform organization')
  }
  const references = blocks.filter(block => block.type === 'markdown' && block.data.markdown === MCP_TOOL_REFERENCE_DIRECTIVE)
  if (references.length !== 1 || references[0]!.data.editor_mode !== 'source') {
    throw new Error('A documentation article must use exactly one source-mode MCP tool reference directive')
  }
  if (!markdown.trim()) throw new Error('The generated MCP tool reference is empty')
  return blocks.map(block => block.type === 'markdown' && block.data.markdown === MCP_TOOL_REFERENCE_DIRECTIVE
    ? { ...block, data: { ...block.data, markdown, editor_mode: 'source' } }
    : block)
}

let deployedReference: Promise<string> | undefined

export async function resolveMcpDocumentationBlocks<T extends DocumentationBlock>(db: DbClient, documentId: string, blocks: T[]): Promise<T[]> {
  if (!hasMcpToolReference(blocks)) return blocks
  const scope = await queryFirst<{ organization_id: string; kind: string; collection: string | null }>(db, `
    SELECT root.organization_id, root.kind, (root.metadata_json ->> '$.collection') AS collection
      FROM content_documents document
      JOIN content_documents root ON root.id = COALESCE(document.root_id, document.id)
        AND root.organization_id = document.organization_id AND root.row_role = 'root'
     WHERE document.id = ?`, [documentId])
  if (!scope) throw new Error('The MCP documentation content owner is missing')
  const platformOrganizationId = (await getPlatformOrganization(db)).id
  // Import only when the public directive is used: tool executors themselves import content writers.
  deployedReference ??= import('./mcp-tools/index').then(({ MCP_PUBLIC_TOOLS }) => renderMcpToolReference(MCP_PUBLIC_TOOLS))
  return expandMcpDocumentationBlocks(blocks, { organizationId: scope.organization_id, platformOrganizationId,
    kind: scope.kind, collection: scope.collection }, await deployedReference)
}
