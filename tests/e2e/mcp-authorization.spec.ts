import { expect, test } from '@playwright/test'
import { loginAs } from './helpers/auth'
import { mcpRequest } from './helpers/mcp'

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
    const blankOrgTools = await mcpRequest(request, baseURL!, {
      method: 'tools/list',
      extraHeaders: { 'x-krabiclaw-organization-id': '   ' },
    })
    expect(blankOrgTools.status()).toBe(200)
    expect(((await blankOrgTools.json()) as { result: { tools: unknown[] } }).result.tools).toEqual([])

    const wrongOrg = await mcpRequest(request, baseURL!, {
      method: 'tools/call',
      toolName: 'get_organization',
      args: { organization_id: missingOrganizationId },
    })
    expect(wrongOrg.status()).toBe(200)
    expect((await wrongOrg.json()).result?.isError).toBe(true)
  })
})
