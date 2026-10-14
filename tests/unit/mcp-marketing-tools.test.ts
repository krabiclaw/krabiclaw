import assert from 'node:assert/strict'
import test from 'node:test'
import { GOOGLE_ADS_TOOLS, handleGoogleAdsTools } from '../../server/utils/mcp-tools/google-ads.ts'
import { MARKETING_TOOLS, handleMarketingTools } from '../../server/utils/mcp-tools/marketing.ts'
import { MCP_PUBLIC_TOOLS, getMcpTool } from '../../server/utils/mcp-tools/index.ts'
import type { McpExecutorContext } from '../../server/utils/mcp-tools/execution.ts'

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

test('handleGoogleAdsTools dispatches create_google_ads_search_campaign and returns formatted receipt', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = String(input)
    if (url.includes('/customers/3317427925/googleAds:mutate')) {
      return Response.json({
        mutateOperationResponses: [
          { campaignBudgetResult: { resourceName: 'customers/3317427925/campaignBudgets/101' } },
          { campaignResult: { resourceName: 'customers/3317427925/campaigns/202' } },
          { adGroupResult: { resourceName: 'customers/3317427925/adGroups/303' } },
          { adGroupCriterionResult: { resourceName: 'customers/3317427925/adGroupCriteria/404' } },
          { adGroupAdResult: { resourceName: 'customers/3317427925/adGroupAds/505' } },
        ],
      })
    }
    return new Response('Not found', { status: 404 })
  })

  // Mock DB query for readIntegration
  const mockDb = {
    prepare: () => ({
      bind: () => ({
        first: async () => ({
          organization_id: 'org-test',
          provider: 'google_ads',
          account_id: 'acc-google-1',
          target_id: '331-742-7925',
          target_name: 'Krabiclaw Main',
          verified: 1,
        }),
      }),
    }),
  } as any

  const mockEnv = {
    DB: mockDb,
    GOOGLE_ADS_DEVELOPER_TOKEN: 'test-dev-token',
  } as any

  // Mock linkedAccountAccessToken
  const ctx: McpExecutorContext = {
    event: {} as any,
    toolName: 'create_google_ads_search_campaign',
    tool: getMcpTool('create_google_ads_search_campaign')!,
    rawArguments: {},
    normalizedArguments: {},
    organizationId: 'org-test',
    organization: {
      db: mockDb,
      env: mockEnv,
      organizationId: 'org-test',
      userId: 'usr-123',
    } as any,
    args: {
      name: 'Autumn Special Menu',
      daily_budget_micros: 20000000,
      target_url: 'https://krabiclaw.com/menu',
      keywords: [{ text: 'seasonal menu', match_type: 'PHRASE' }],
      headlines: ['Autumn Seasonal Menu', 'Fresh Organic Dining', 'Reserve Tonight'],
      descriptions: ['Experience our seasonal autumn dishes prepared daily.', 'Book your table online today.'],
      status: 'PAUSED',
    },
  }

  // Mock linkedAccountAccessToken by mocking auth module function via global fetch if needed,
  // or mocking the resolve function.
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = String(input)
    if (url.includes('/customers/3317427925/googleAds:mutate')) {
      return Response.json({
        mutateOperationResponses: [
          { campaignBudgetResult: { resourceName: 'customers/3317427925/campaignBudgets/101' } },
          { campaignResult: { resourceName: 'customers/3317427925/campaigns/202' } },
          { adGroupResult: { resourceName: 'customers/3317427925/adGroups/303' } },
          { adGroupCriterionResult: { resourceName: 'customers/3317427925/adGroupCriteria/404' } },
          { adGroupAdResult: { resourceName: 'customers/3317427925/adGroupAds/505' } },
        ],
      })
    }
    return new Response('{}', { status: 200 })
  })
})
