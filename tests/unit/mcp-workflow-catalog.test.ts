import assert from 'node:assert/strict'
import test from 'node:test'

import { MCP_PUBLIC_TOOLS } from '../../server/utils/mcp-tools/index.ts'
import { referencedMcpTools } from '../../server/utils/mcp-prompts.ts'
import { documentationDependencies } from '../../scripts/check-mcp-tool-catalog.mjs'

const toolNames = MCP_PUBLIC_TOOLS.map(tool => tool.name)

test('tool references reject typos, removed operations and invalid reference anchors without treating argument fields as tools', () => {
  assert.deepEqual(referencedMcpTools('Use get_product with product_id, then update_product with updated_at and idempotency_key.', toolNames), ['get_product', 'update_product'])
  assert.throws(() => referencedMcpTools('Call get_removed_product.', toolNames), /Unknown MCP tool reference: get_removed_product/)
  assert.throws(() => referencedMcpTools('Call retire_old_tool.', toolNames, ['retire_old_tool']), /Unknown MCP tool reference: retire_old_tool/)
  assert.throws(() => documentationDependencies('[Read](/docs/mcp-tool-reference#imaginary_tool)', MCP_PUBLIC_TOOLS), /Unknown MCP tool reference anchor: imaginary_tool/)
  const anchor = documentationDependencies('[Update the menu](/docs/mcp-tool-reference#update_menu)', MCP_PUBLIC_TOOLS)
  assert.deepEqual(Object.keys(anchor), ['update_menu'])
})
