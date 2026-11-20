import { expect, test } from '@playwright/test'
import { loginAs } from './helpers/auth'
import { mcpRequest } from './helpers/mcp'
import { seededTenant } from './seed/manifest'

// What any principal may see and invoke on a tenant it does not belong to.

test.describe('stateless MCP server', () => {

  test('a tenant the principal cannot reach yields no tools and no writes', async ({ request, baseURL }) => {
    await loginAs(request, baseURL!, 'user-e2e-mcp-fresh-inaccessible')
    const missingOrganizationId = `org-missing-${Date.now()}`

    const wrongOrgTools = await mcpRequest(request, baseURL!, { method: 'tools/list', organizationId: missingOrganizationId })
    expect(wrongOrgTools.status()).toBe(200)
    expect(((await wrongOrgTools.json()) as { result: { tools: unknown[] } }).result.tools).toEqual([])

    // A blank header is not "no tenant selected": it names a tenant that
    // resolves to nothing, and must fail closed the same way.
    for (const header of ['x-blawby-organization-id']) {
      const blankOrgTools = await mcpRequest(request, baseURL!, {
        method: 'tools/list',
        extraHeaders: { [header]: '   ' },
      })
      expect(blankOrgTools.status()).toBe(200)
      expect(((await blankOrgTools.json()) as { result: { tools: unknown[] } }).result.tools).toEqual([])
    }

    const wrongOrg = await mcpRequest(request, baseURL!, {
      method: 'tools/call',
      toolName: 'get_organization',
      args: { organization_id: missingOrganizationId },
    })
    expect(wrongOrg.status()).toBe(200)
    expect((await wrongOrg.json()).result?.isError).toBe(true)
  })
})

test('Growth Google Ads writes explain the plan requirement and link to tenant billing', async ({ request, baseURL }) => {
  await loginAs(request, baseURL!, 'user-e2e-ncls-owner')
  const tenant = seededTenant('legal')
  const tools = [
    ['create_google_ads_search_campaign', {
      name: 'Consultations', daily_budget_micros: 1_000_000, target_url: 'https://example.com/legal',
      keywords: [{ text: 'legal consultation', match_type: 'EXACT' }],
      headlines: ['Legal Consultations', 'Talk With An Attorney', 'Request A Consultation'],
      descriptions: ['Learn how our legal team can help.', 'Request an appointment with an attorney.'],
      contains_eu_political_advertising: false,
    }],
    ['update_google_ads_campaign', { campaign_id: '123', status: 'PAUSED' }],
  ] as const
  for (const [toolName, args] of tools) {
    const response = await mcpRequest(request, baseURL!, {
      method: 'tools/call', toolName, args: { ...args, organization_id: tenant.organizationId },
    })
    expect(response.status()).toBe(200)
    const { result } = await response.json()
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text)).toEqual({
      status: 403,
      code: 'ENTITLEMENT_REQUIRED',
      message: "This organization's plan does not include Google Ads Management. Ask an organization owner to review Plan and billing.",
      organization_id: tenant.organizationId,
      dashboard_url: new URL(`/dashboard/${tenant.slug}/billing`, baseURL).href,
    })
  }
})

test('Google Ads diagnostics are read-only tools for the selected Growth tenant', async ({ request, baseURL }) => {
  await loginAs(request, baseURL!, 'user-e2e-ncls-owner')
  const tenant = seededTenant('legal')
  const toolNames = [
    'query_google_ads_change_history',
    'get_campaign_delivery_diagnostics',
    'get_campaign_bidding_settings',
    'list_conversion_actions',
    'get_conversion_tracking_health',
  ]
  const catalog = await mcpRequest(request, baseURL!, { method: 'tools/list', organizationId: tenant.organizationId })
  expect(catalog.status()).toBe(200)
  const { result } = await catalog.json()
  const diagnostics = result.tools.filter((tool: { name: string }) => toolNames.includes(tool.name))
  expect(diagnostics.map((tool: { name: string }) => tool.name).sort()).toEqual(toolNames.sort())
  expect(result._meta['blawby/catalogFingerprint']).toMatch(/^sha256:[0-9a-f]{64}$/)
  for (const tool of diagnostics) {
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    expect(tool._meta['blawby/toolInfo']).toMatchObject({ domain: expect.any(String), minimumRole: expect.any(String) })
  }

  const response = await mcpRequest(request, baseURL!, {
    method: 'tools/call', toolName: 'list_conversion_actions', args: { organization_id: tenant.organizationId },
  })
  expect(response.status()).toBe(200)
  const { result: disconnected } = await response.json()
  expect(disconnected.isError).toBe(true)
  expect(JSON.parse(disconnected.content[0].text)).toMatchObject({
    status: 400,
    message: expect.stringContaining('Google Ads is not connected for this organization'),
  })
})
