import assert from 'node:assert/strict'
import test from 'node:test'

import { MCP_PUBLIC_TOOLS } from '../../server/utils/mcp-tools/index.ts'
import { referencedMcpTools } from '../../server/utils/mcp-prompts.ts'
import { documentationDependencies, promptSnapshots } from '../../scripts/check-mcp-tool-catalog.mjs'

const toolNames = MCP_PUBLIC_TOOLS.map(tool => tool.name)

test('every runtime workflow identifies valid current tools, including guest replies and booking actions', () => {
  const workflows = promptSnapshots(MCP_PUBLIC_TOOLS)
  for (const workflow of workflows) {
    assert.ok(Object.keys(workflow.toolContracts).length, `${workflow.name} needs explicit tool dependencies`)
  }
  const triage = workflows.find(workflow => workflow.name === 'triage_inbox')!
  for (const name of ['list_guest_conversations', 'get_guest_conversation', 'reply_to_guest', 'confirm_product_booking', 'request_table_reservation_change']) {
    assert.ok(name in triage.toolContracts, name)
  }
  assert.ok(workflows.find(workflow => workflow.name === 'set_up_products')!.toolContracts.update_menu)
  assert.ok(workflows.find(workflow => workflow.name === 'set_up_bookable_product')!.toolContracts.list_product_booking_sessions)
})

test('tool references reject typos, removed operations and invalid reference anchors without treating argument fields as tools', () => {
  assert.deepEqual(referencedMcpTools('Use get_product with product_id, then update_product with expected_updated_at and idempotency_key.', toolNames), ['get_product', 'update_product'])
  assert.throws(() => referencedMcpTools('Call get_removed_product.', toolNames), /Unknown MCP tool reference: get_removed_product/)
  assert.throws(() => referencedMcpTools('Call retire_old_tool.', toolNames, ['retire_old_tool']), /Unknown MCP tool reference: retire_old_tool/)
  assert.throws(() => documentationDependencies('[Read](/docs/mcp-tool-reference#imaginary_tool)', MCP_PUBLIC_TOOLS), /Unknown MCP tool reference anchor: imaginary_tool/)
  const anchor = documentationDependencies('[Update the menu](/docs/mcp-tool-reference#update_menu)', MCP_PUBLIC_TOOLS)
  assert.deepEqual(Object.keys(anchor), ['update_menu'])
})
