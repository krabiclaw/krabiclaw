import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { loginAs } from './helpers/auth'
import { mcpJson } from './helpers/mcp'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { seededTenant } from './seed/manifest'

function pkceChallenge(verifier: string) {
  return createHash('sha256').update(verifier).digest('base64url')
}

function oauthAuthorizeUrl(baseURL: string, params: Record<string, string>) {
  return `${baseURL}/api/auth/oauth2/authorize?${new URLSearchParams(params).toString()}`
}

test.describe('OAuth discovery endpoints', () => {

  test('public CIMD exchanges codes once, rotates refresh grants and enforces tenant scope', async ({ request, baseURL }, testInfo) => {
    const MCP_VERSION = '2026-07-28'
    // A client starts unauthenticated: the MCP endpoint answers with the OAuth
    // challenge, before version validation, naming the protected-resource document.
    const probe = await request.post(`${baseURL}/api/mcp`, {
      headers: { 'content-type': 'application/json', 'mcp-protocol-version': MCP_VERSION, 'mcp-method': 'server/discover' },
      data: { jsonrpc: '2.0', id: 'auth-check', method: 'server/discover', params: {},
        _meta: { 'io.modelcontextprotocol/version': MCP_VERSION, 'io.modelcontextprotocol/method': 'server/discover' } },
    })
    expect(probe.status()).toBe(401)
    const challenge = probe.headers()['www-authenticate']!
    expect(challenge).toContain('Bearer')
    const resourceMetadata = challenge.match(/resource_metadata="([^"]+)"/)?.[1]
    // RFC 9728: the metadata for the /api/mcp resource sits at the path-suffixed well-known URL.
    expect(new URL(resourceMetadata!).pathname).toBe('/.well-known/oauth-protected-resource/api/mcp')

    const protectedResource = await request.get(resourceMetadata!)
    expect(protectedResource.status()).toBe(200)
    const resourceBody = await protectedResource.json() as { resource: string; authorization_servers: string[]; bearer_methods_supported: string[] }
    expect(resourceBody.resource).toBe(`${baseURL}/api/mcp`)
    expect(resourceBody.authorization_servers.length).toBeGreaterThan(0)
    expect(resourceBody.bearer_methods_supported).toContain('header')
    const openid = await request.get(`${baseURL}/.well-known/openid-configuration`)
    expect(openid.status()).toBe(200)
    const openidBody = await openid.json() as Record<string, unknown>
    // ChatGPT validates the ID token after code exchange and aborts before MCP
    // initialize when the provider advertises only Better Auth's EdDSA default.
    expect(openidBody.id_token_signing_alg_values_supported as string[]).toContain('RS256')
    // CIMD instead of dynamic registration: a client is its own metadata URL.
    expect(openidBody.registration_endpoint).toBeUndefined()
    expect(openidBody.client_id_metadata_document_supported).toBe(true)
    const authorizationServer = await request.get(`${baseURL}/.well-known/oauth-authorization-server`)
    expect(authorizationServer.status()).toBe(200)
    const authorizationServerBody = await authorizationServer.json() as Record<string, unknown>
    expect(authorizationServerBody.registration_endpoint).toBeUndefined()
    expect(authorizationServerBody.client_id_metadata_document_supported).toBe(true)
    expect(authorizationServerBody.code_challenge_methods_supported as string[]).toContain('S256')

    const restaurant = seededTenant('restaurant')
    await loginAs(request, baseURL!, 'user-e2e-kikuzuki-owner')

    const cimdClientId = process.env.MCP_CIMD_CLIENT_URL!
    expect(cimdClientId, 'MCP_CIMD_CLIENT_URL must name a public HTTPS metadata document').toBeTruthy()
    const redirectUri = new URL('/oauth/test-callback', cimdClientId).toString()
    const verifier = 'blawby-public-cimd-e2e-verifier-0123456789'
    const authorizeParams = {
      client_id: cimdClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid offline_access tenant',
      state: 'first-pass',
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
      resource: `${baseURL}/api/mcp`,
    }

    const firstAuthorize = await request.get(oauthAuthorizeUrl(baseURL!, {
      ...authorizeParams,
      prompt: 'consent',
    }), { maxRedirects: 0 })
    expect(firstAuthorize.status()).toBe(302)
    const consentLocation = firstAuthorize.headers()['location']
    expect(consentLocation).toContain('/oauth/consent?')

    const consentUrl = new URL(consentLocation!, baseURL)
    const oauthQuery = consentUrl.search.slice(1)

    const consentRes = await request.post(`${baseURL}/api/auth/oauth2/consent`, {
      headers: {
        Origin: baseURL!,
      },
      data: {
        accept: true,
        oauth_query: oauthQuery,
      },
    })
    expect(consentRes.status()).toBe(200)
    const consentBody = await consentRes.json() as { url?: string }
    expect(consentBody.url).toBeTruthy()
    const consentRedirect = new URL(consentBody.url!)
    const code = consentRedirect.searchParams.get('code')
    expect(code).toBeTruthy()

    const exchangeCode = async () => await request.post(`${baseURL}/api/auth/oauth2/token`, {
      headers: { Origin: baseURL! },
      form: {
        grant_type: 'authorization_code',
        client_id: cimdClientId,
        code: code!,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
    })
    const token = await exchangeCode()
    expect(token.status()).toBe(200)
    const tokenBody = await token.json() as { access_token?: string, refresh_token?: string }
    expect(tokenBody.access_token).toBeTruthy()
    expect(tokenBody.refresh_token).toBeTruthy()

    const refreshGrant = () => request.post(`${baseURL}/api/auth/oauth2/token`, {
      headers: { Origin: baseURL! },
      form: {
        grant_type: 'refresh_token',
        client_id: cimdClientId,
        refresh_token: tokenBody.refresh_token!,
        resource: `${baseURL}/api/mcp`,
      },
    })
    const refreshed = await refreshGrant()
    expect(refreshed.status(), await refreshed.text()).toBe(200)
    const refreshedBody = await refreshed.json()
    expect(refreshedBody.access_token).toBeTruthy()
    expect(refreshedBody.refresh_token).toBeTruthy()
    expect(refreshedBody.refresh_token).not.toBe(tokenBody.refresh_token)

    const initialized = await request.post(`${baseURL}/api/mcp`, {
      headers: {
        Authorization: `Bearer ${refreshedBody.access_token}`,
        Accept: 'application/json, text/event-stream',
        Cookie: '',
      },
      data: {
        jsonrpc: '2.0', id: 0, method: 'initialize', params: {
          protocolVersion: '2025-06-18', capabilities: {},
          clientInfo: { name: 'blawby-release-e2e', version: '1.0.0' },
        }
      },
    })
    expect(initialized.status(), await initialized.text()).toBe(200)
    expect(await mcpJson(initialized)).toMatchObject({
      result: { protocolVersion: '2025-06-18', serverInfo: { name: 'blawby-mcp', title: 'Blawby' } },
    })

    const tools = await request.post(`${baseURL}/api/mcp`, {
      headers: {
        Authorization: `Bearer ${refreshedBody.access_token}`,
        Accept: 'application/json, text/event-stream',
        Cookie: '',
      },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    })
    expect(tools.status(), await tools.text()).toBe(200)
    const toolsBody = await mcpJson<{ error?: unknown; result: { tools: Array<{ name: string }> } }>(tools)
    expect(toolsBody.error).toBeUndefined()
    expect(toolsBody.result.tools.length).toBeGreaterThan(0)

    // The connected client reads and writes the owner's business through MCP;
    // the write is read back through the dashboard API.
    const tenantCall = (id: string, name: string, args: Record<string, unknown>) => request.post(`${baseURL}/api/mcp`, {
      headers: { Authorization: `Bearer ${refreshedBody.access_token}`, Accept: 'application/json, text/event-stream', Cookie: '' },
      data: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
    })
    const organizationRead = await tenantCall('tenant-read', 'get_organization', { organization_id: restaurant.organizationId })
    expect(organizationRead.status(), await organizationRead.text()).toBe(200)
    const organizationResult = await mcpJson<{ result: { isError: boolean; structuredContent: { context: { organization_id: string } } } }>(organizationRead)
    expect(organizationResult.result.isError).toBe(false)
    expect(organizationResult.result.structuredContent.context.organization_id).toBe(restaurant.organizationId)
    const release = await acquireTenantMutationLock(testInfo, restaurant.organizationId)
    try {
      const title = `Connected client check ${Date.now()}`
      const created = await tenantCall('tenant-write', 'create_task', { organization_id: restaurant.organizationId, title, idempotency_key: crypto.randomUUID() })
      expect(created.status(), await created.text()).toBe(200)
      const createdResult = await mcpJson<{ result: { isError: boolean; structuredContent: { task: { id: string } } } }>(created)
      expect(createdResult.result.isError).toBe(false)
      const taskPath = `${baseURL}/api/organizations/${restaurant.organizationId}/tasks/${createdResult.result.structuredContent.task.id}`
      const stored = await request.get(taskPath)
      expect(stored.status(), await stored.text()).toBe(200)
      expect((await stored.json() as { task: { title: string; status: string } }).task).toMatchObject({ title, status: 'open' })
      const completed = await request.post(`${taskPath}/complete`, { data: {} })
      expect(completed.status(), await completed.text()).toBe(200)
      expect((await completed.json() as { task: { status: string } }).task.status).toBe('done')
    } finally {
      await release()
    }

    const refreshReplay = await refreshGrant()
    expect(refreshReplay.status()).toBe(400)
    expect(await refreshReplay.json()).toMatchObject({ error: 'invalid_grant' })

    const replay = await exchangeCode()
    expect(replay.status()).toBe(400)

    const secondAuthorize = await request.get(oauthAuthorizeUrl(baseURL!, {
      ...authorizeParams,
      scope: 'openid offline_access',
      state: 'second-pass',
    }), { maxRedirects: 0 })
    expect(secondAuthorize.status()).toBe(302)
    const secondLocation = secondAuthorize.headers()['location']
    expect(secondLocation).toBeTruthy()
    expect(secondLocation).not.toContain('/oauth/consent?')

    const secondRedirect = new URL(secondLocation!, baseURL)
    expect(secondRedirect.origin + secondRedirect.pathname).toBe(redirectUri)
    expect(secondRedirect.searchParams.get('code')).toBeTruthy()
    expect(secondRedirect.searchParams.get('state')).toBe('second-pass')

    const limitedToken = await request.post(`${baseURL}/api/auth/oauth2/token`, {
      headers: { Origin: baseURL! },
      form: {
        grant_type: 'authorization_code', client_id: cimdClientId,
        code: secondRedirect.searchParams.get('code')!, redirect_uri: redirectUri,
        code_verifier: verifier, resource: `${baseURL}/api/mcp`,
      },
    })
    expect(limitedToken.status()).toBe(200)
    const limitedGrant = await limitedToken.json() as { access_token: string; scope: string }
    expect(limitedGrant.scope.split(' ')).not.toContain('tenant')
    const limitedHeaders = {
      Authorization: `Bearer ${limitedGrant.access_token}`, Cookie: '',
      Accept: 'application/json, text/event-stream',
    }
    const limitedList = await request.post(`${baseURL}/api/mcp`, {
      headers: limitedHeaders,
      data: { jsonrpc: '2.0', id: 'limited-list', method: 'tools/list', params: {} },
    })
    expect(limitedList.status()).toBe(403)
    const scopeChallenge = limitedList.headers()['www-authenticate']!
    expect(scopeChallenge).toContain('error="insufficient_scope"')
    expect(scopeChallenge).toContain('scope="tenant"')
    const limitedCall = await request.post(`${baseURL}/api/mcp`, {
      headers: { ...limitedHeaders, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'list_organizations' },
      data: { jsonrpc: '2.0', id: 'limited-call', method: 'tools/call', params: {
        name: 'list_organizations', arguments: {},
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
      } },
    })
    expect(limitedCall.status()).toBe(200)
    const limitedResult = await mcpJson<{ result: { resultType: string; isError: boolean; structuredContent?: unknown; _meta: Record<string, unknown> } }>(limitedCall)
    expect(limitedResult.result.resultType).toBe('complete')
    expect(limitedResult.result.isError).toBe(true)
    expect(limitedResult.result.structuredContent).toBeUndefined()
    expect(limitedResult.result._meta['mcp/www_authenticate']).toEqual([scopeChallenge])

    const clientHeaders = new Headers({ Authorization: `Bearer ${refreshedBody.access_token}` })
    const client = new Client({ name: 'blawby-scope-check', version: '1.0.0' }, {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${baseURL}/api/mcp`), { requestInit: { headers: clientHeaders } }))
      clientHeaders.set('Authorization', `Bearer ${limitedGrant.access_token}`)
      const denied = await client.callTool({ name: 'list_organizations', arguments: {} })
      expect(denied.isError).toBe(true)
      expect(denied.structuredContent).toBeUndefined()
      expect(denied._meta?.['mcp/www_authenticate']).toEqual([scopeChallenge])
    } finally {
      await client.close()
    }
  })

})
