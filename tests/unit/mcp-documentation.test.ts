import assert from 'node:assert/strict'
import test from 'node:test'
import {
  expandMcpDocumentationBlocks, MCP_TOOL_REFERENCE_DIRECTIVE,
  mcpDocumentationFingerprint, renderMcpToolReference,
} from '../../server/utils/mcp-documentation.ts'
import type { McpToolDefinition } from '../../server/utils/mcp-tools/shared.ts'
import { renderContentBlocksForLlm } from '../../server/utils/platform-llm.ts'
import { renderMarkdownToHtml, sanitizeHtmlForSsr } from '../../utils/markdown.ts'

const tool: McpToolDefinition = {
  name: 'read_example', title: 'Read example', description: 'Read the selected record.', domain: 'examples',
  minimumRole: 'member', annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  securitySchemes: [{ type: 'oauth2', scopes: ['tenant'] }],
  inputSchema: { type: 'object', properties: {
    record_id: { type: 'string', description: 'The selected record.' },
    mode: { type: 'string', enum: ['brief', 'full'], default: 'brief' },
  }, required: ['record_id'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { value: { type: 'number' }, records: {
    type: 'array', items: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  } }, required: ['value'] },
}

test('documentation fingerprints ignore serialization order and detect permission and schema changes', () => {
  const hash = mcpDocumentationFingerprint([tool])
  const reordered = { ...tool, inputSchema: { additionalProperties: false, required: ['record_id'],
    properties: { mode: { default: 'brief', enum: ['brief', 'full'], type: 'string' },
      record_id: { description: 'The selected record.', type: 'string' } }, type: 'object' } }
  assert.equal(mcpDocumentationFingerprint([reordered]), hash)
  for (const change of [
    { minimumRole: 'admin' as const }, { requiredEntitlement: 'payments' },
    { annotations: { ...tool.annotations, openWorldHint: true } },
    { inputSchema: { ...tool.inputSchema, required: ['record_id', 'mode'] } },
  ]) assert.notEqual(mcpDocumentationFingerprint([{ ...tool, ...change }]), hash)
  const second = { ...tool, name: 'read_other' }
  assert.equal(mcpDocumentationFingerprint([tool, second]), mcpDocumentationFingerprint([second, tool]))
})

test('the reference retains stable tool anchors, constraints and output shapes through HTML and LLM rendering', () => {
  const markdown = renderMcpToolReference([tool])
  const html = sanitizeHtmlForSsr(renderMarkdownToHtml(markdown, 7))
  assert.match(html, /<a id="read_example"><\/a>/)
  assert.match(markdown, /\| `record_id` \| string \| Yes \| The selected record\. \|/)
  assert.match(markdown, /enum: \["brief","full"\]/)
  assert.match(markdown, /default: "brief"/)
  assert.match(markdown, /\| `value` \| number \| Yes \|/)
  assert.match(markdown, /Reference fingerprint: `sha256:[a-f0-9]{64}`/)
  assert.match(html, /<a id="schema-[a-f0-9]{16}"><\/a>/)
  assert.match(markdown, /\| `title` \| string \| Yes \|/)
  const anchors = new Set([...markdown.matchAll(/<a id="([^"]+)"/g)].map(match => match[1]))
  for (const link of markdown.matchAll(/\]\(#(schema-[^)]+)\)/g)) assert.ok(anchors.has(link[1]))
  const llm = renderContentBlocksForLlm([{ type: 'markdown', position: 0, level: null,
    data: { markdown, editor_mode: 'source' }, media: [] }])
  assert.equal(llm, markdown)
})

test('public reference expansion preserves raw CMS blocks and refuses a different content owner', () => {
  const blocks = [{ id: 'reference-block', type: 'markdown', data: { markdown: MCP_TOOL_REFERENCE_DIRECTIVE, editor_mode: 'source' } }]
  const scope = { organizationId: 'selected-platform', platformOrganizationId: 'selected-platform', kind: 'article', collection: 'docs' }
  const markdown = renderMcpToolReference([tool])
  const publicBlocks = expandMcpDocumentationBlocks(blocks, scope, markdown)
  assert.notEqual(publicBlocks, blocks)
  assert.match(publicBlocks[0]!.data.markdown, /read_example/)
  assert.equal(blocks[0]!.data.markdown, MCP_TOOL_REFERENCE_DIRECTIVE)
  assert.equal(publicBlocks[0]!.id, blocks[0]!.id)
  for (const change of [{ organizationId: 'another-tenant' }, { kind: 'page' }, { collection: 'blog' }]) {
    assert.throws(() => expandMcpDocumentationBlocks(blocks, { ...scope, ...change }, markdown), /requires a documentation article in the platform organization/)
  }
  assert.throws(() => expandMcpDocumentationBlocks([...blocks, ...blocks], scope, markdown), /exactly one source-mode/)
  assert.throws(() => expandMcpDocumentationBlocks([{ ...blocks[0]!, data: { ...blocks[0]!.data, editor_mode: 'rich' } }], scope, markdown), /exactly one source-mode/)
  const ordinary = [{ type: 'markdown', data: { markdown: `Explain this marker: ${MCP_TOOL_REFERENCE_DIRECTIVE}` } }]
  assert.equal(expandMcpDocumentationBlocks(ordinary, scope, markdown), ordinary)
})
