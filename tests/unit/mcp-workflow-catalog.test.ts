import assert from 'node:assert/strict'
import test from 'node:test'

import { MCP_PUBLIC_TOOLS } from '../../server/utils/mcp-tools/index.ts'
import { referencedMcpTools } from '../../server/utils/mcp-prompts.ts'
import {
  PUBLIC_MCP_GUIDE_SLUGS,
  catalogSnapshot,
  documentationDependencies,
  promptSnapshots,
  publicGuideReviewFailures,
  reviewPublicGuide,
} from '../../scripts/check-mcp-tool-catalog.mjs'

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

test('public guide reviews track authored title and prose without copying them or environment-specific front matter', () => {
  const source = '# Update a menu\n\nUse `update_menu` and `get_product`.\n'
  const reviewed = reviewPublicGuide('capabilities', `---\ncanonical_url: https://krabiclaw.com/docs/capabilities\nlast_updated: 2026-10-13\n---\n\n${source}`, MCP_PUBLIC_TOOLS)
  const staging = reviewPublicGuide('capabilities', `---\ncanonical_url: https://staging.krabiclaw.com/docs/capabilities\nlast_updated: 2026-10-14\n---\n\n${source}`, MCP_PUBLIC_TOOLS)
  assert.deepEqual(staging, reviewed)
  assert.deepEqual(Object.keys(reviewed), ['slug', 'contentHash', 'toolContracts'])
  assert.notEqual(reviewPublicGuide('capabilities', source.replace('Update a menu', 'Replace a menu'), MCP_PUBLIC_TOOLS).contentHash, reviewed.contentHash)
  assert.throws(() => reviewPublicGuide('capabilities', '# No operations described', MCP_PUBLIC_TOOLS), /guide must identify its MCP tool dependencies/)
})

test('equivalent Markdown screenshots can use different delivery URLs while alt text, title, captions, prose and ordinary links stay reviewed', () => {
  const source = '# Upload media\n\nUse `save_media_attachment`.\n\n![Upload \\[picker\\] controls](https://production.example/media/current "Current controls")\n\nThe picker has Add files and a drop zone.\n\n[Upload help](https://production.example/help)'
  const reviewed = reviewPublicGuide('add-photos-and-video', source, MCP_PUBLIC_TOOLS)
  const imageChanged = source.replace('https://production.example/media/current', 'https://staging.example/media/equivalent')
  assert.deepEqual(reviewPublicGuide('add-photos-and-video', imageChanged, MCP_PUBLIC_TOOLS), reviewed)
  assert.deepEqual(reviewPublicGuide('add-photos-and-video', imageChanged.replace('https://staging.example/media/equivalent', '<https://staging.example/media/equivalent>'), MCP_PUBLIC_TOOLS), reviewed)
  for (const changed of [
    source.replace('Upload \\[picker\\] controls', 'Different upload controls'),
    source.replace('Current controls', 'Different controls'),
    source.replace('The picker has Add files and a drop zone.', 'The picker saves immediately.'),
    source.replace('Use `save_media_attachment`.', 'Read `list_media_assets`.'),
    source.replace('https://production.example/help', 'https://staging.example/help'),
  ]) {
    assert.notEqual(reviewPublicGuide('add-photos-and-video', changed, MCP_PUBLIC_TOOLS).contentHash, reviewed.contentHash)
  }
})

test('changed permissions, entitlements, annotations and schemas require explicit public workflow review', () => {
  const reviews = PUBLIC_MCP_GUIDE_SLUGS.map(slug => reviewPublicGuide(slug, '# Workflow\n\nUse `update_menu`.', MCP_PUBLIC_TOOLS))
  assert.deepEqual(publicGuideReviewFailures(reviews, MCP_PUBLIC_TOOLS), [])
  const mutations = [
    (tool: typeof MCP_PUBLIC_TOOLS[number]) => ({ ...tool, minimumRole: tool.minimumRole === 'admin' ? 'owner' as const : 'admin' as const }),
    (tool: typeof MCP_PUBLIC_TOOLS[number]) => ({ ...tool, requiredEntitlement: 'changed-entitlement' }),
    (tool: typeof MCP_PUBLIC_TOOLS[number]) => ({ ...tool, annotations: { ...tool.annotations, openWorldHint: !tool.annotations.openWorldHint } }),
    (tool: typeof MCP_PUBLIC_TOOLS[number]) => ({ ...tool, inputSchema: { ...tool.inputSchema, description: 'Changed operation contract' } }),
  ]
  for (const mutate of mutations) {
    const proposed = MCP_PUBLIC_TOOLS.map(tool => tool.name === 'update_menu' ? mutate(tool) : tool)
    const failures = publicGuideReviewFailures(reviews, proposed)
    assert.equal(failures.length, PUBLIC_MCP_GUIDE_SLUGS.length)
    assert.ok(failures.every(failure => failure.includes('update_menu changed')))
    assert.strictEqual(catalogSnapshot(proposed, { tools: MCP_PUBLIC_TOOLS, publicDocumentation: reviews }).publicDocumentation, reviews, 'ordinary regeneration preserves the reviewed dependencies')
  }
  assert.ok(publicGuideReviewFailures(reviews, MCP_PUBLIC_TOOLS.filter(tool => tool.name !== 'update_menu')).every(failure => failure.includes('removed tool update_menu')))
})
