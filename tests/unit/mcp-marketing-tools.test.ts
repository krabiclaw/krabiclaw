import assert from 'node:assert/strict'
import test from 'node:test'
import { getMcpTool } from '../../server/utils/mcp-tools/index.ts'

test('all Google Ads and marketing MCP tools are registered in MCP_PUBLIC_TOOLS with correct hints', () => {
  const expectedNames = [
    'list_google_ads_campaigns',
    'get_google_ads_campaign',
    'create_google_ads_search_campaign',
    'clone_google_ads_campaign',
    'update_google_ads_campaign',
    'launch_omnichannel_campaign',
  ]

  for (const name of expectedNames) {
    const tool = getMcpTool(name)
    assert.ok(tool, `Tool ${name} must be registered`)
    assert.ok(tool.description && tool.description.length > 10)
    assert.ok(tool.inputSchema)
    assert.ok(tool.outputSchema)
    assert.equal(tool.minimumRole, 'admin')
  }

  // Annotation hints verification
  const listTool = getMcpTool('list_google_ads_campaigns')!
  assert.equal(listTool.annotations.readOnlyHint, true)
  assert.equal(listTool.annotations.destructiveHint, false)

  const createTool = getMcpTool('create_google_ads_search_campaign')!
  assert.equal(createTool.annotations.readOnlyHint, false)
  assert.equal(createTool.annotations.openWorldHint, true)

  const cloneTool = getMcpTool('clone_google_ads_campaign')!
  assert.equal(cloneTool.annotations.readOnlyHint, false)
  assert.equal(cloneTool.annotations.openWorldHint, true)

  const updateTool = getMcpTool('update_google_ads_campaign')!
  assert.equal(updateTool.annotations.readOnlyHint, false)
  assert.equal(updateTool.annotations.destructiveHint, true)

  const omnichannelTool = getMcpTool('launch_omnichannel_campaign')!
  assert.equal(omnichannelTool.annotations.readOnlyHint, false)
  assert.equal(omnichannelTool.annotations.destructiveHint, true)
  assert.equal(omnichannelTool.annotations.openWorldHint, true)
})
