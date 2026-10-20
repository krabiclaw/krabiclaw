import { expect, test } from '@playwright/test'
import { loginAs } from './helpers/auth'
import { MCP_ORGANIZATION_ID, mcpRequest, loginAsFreshMcpUser } from './helpers/mcp'

// Split out of mcp.spec.ts (authorization/isolation tests) — see
// helpers/mcp.ts for why. The boundary: what any principal may see and invoke
// on a tenant it does not belong to.

test.describe('stateless MCP server', () => {
  test('missing required records produce a 404 tool error across resource families', async ({ request, baseURL }) => {
    await loginAs(request, baseURL!)
    const missingId = `missing-${crypto.randomUUID()}`
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [
      { toolName: 'get_location', args: { location_id: missingId } },
      { toolName: 'get_blog_post', args: { post_id: missingId } },
      { toolName: 'get_post', args: { post_id: missingId } },
      { toolName: 'get_payment', args: { payment_id: missingId } },
      { toolName: 'get_guest_conversation', args: { request_id: missingId } },
      { toolName: 'get_member_scheduling', args: { member_id: missingId } },
      { toolName: 'update_media_asset', args: { asset_id: missingId, alt_text: 'Missing asset' } },
      { toolName: 'cancel_organization_invitation', args: { invitation_id: missingId } },
      { toolName: 'reconcile_post_publication', args: { publication_id: missingId } },
      { toolName: 'delete_post', args: { post_id: missingId } },
    ]
    for (const { toolName, args } of calls) {
      const response = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName, args: { organization_id: MCP_ORGANIZATION_ID, ...args },
      })
      expect(response.status(), toolName).toBe(200)
      const body = await response.json()
      expect(body.error, toolName).toBeUndefined()
      expect(body.result?.isError, toolName).toBe(true)
      expect(body.result?.structuredContent, toolName).toBeUndefined()
      const failure = JSON.parse(body.result.content[0].text) as { status: number; message: string }
      expect(failure.status, toolName).toBe(404)
      expect(failure.message, toolName).toMatch(/not found/i)
    }
  })

  test('a tenant the principal cannot reach yields no tools and no writes', async ({ request, baseURL }) => {
    await loginAsFreshMcpUser(request, baseURL!, 'inaccessible')
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
