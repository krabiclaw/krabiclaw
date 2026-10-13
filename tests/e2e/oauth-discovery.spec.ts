import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { decodeProtectedHeader, importJWK, SignJWT } from 'jose'
import { loginAs } from './helpers/auth'
import { mcpJson } from './helpers/mcp'

const PRIVATE_CLIENT_TEST_KEY_ID = 'krabiclaw-cimd-e2e-rs256'
const PRIVATE_CLIENT_TEST_JWK = {
  kty: 'RSA',
  n: '0PJUgpQ_Fg1ArCJcwrncgB9r8EX2UVD7pvpNJN8d_E6n4c_yQ_LVC0jyzdAlWnRFXE2THja5mSMQ7ddEYBznURS563ki2qHbMxkkhsIvzR3BeWWOe_qhqWenjFx5le5VFZIg1kcUZ0nzR4IM8gX1BJSEERZUkydY5K584rv3dVVdWWhUwux1ES0gEqpjQle9iiRPQ6lU8lSpYLEI02rkjvtF7HB5wKtnr1wsTOA5hWLwaKnFKN-G4v5ITO0cFys9bN6024YL8bj4N7HvPA-uxDM7AjxHZkAZ9PE90v85QS3r49AysOQIOxM7pq9i3su_5kECwCcZuG9gddOGUOs1fw',
  e: 'AQAB',
  d: 'VAt1VMS-j2crQVHdD_JksCBzcUUi69hwMNzzVMZuMEOPIbRcFVrCuPRRvdlgfP7Ru2v0pi2K__7r209AUIyvupxkoEOsclaybd5KI-5N_epfHS5tXo8Uoahw63Ny8IzaKoAJt0cF_Pnw4i18eYlN4da_PIRH5pzoE6vfze-ffNDsN0QbPHLKdE3pwxkIl0h73pXtFK8PN6Et2efMRMBR9n7Mc1JhzgE64RgrPchC5RqTMioiEeNVvtgi-11-Is2gZFnbpNkbH8Fubm0PNg9wC6lnO2MnOOhUkwKx6yV1G16oytMjDUlQMxo1jaaS8p-duV4DbFDJBYM7yUhexvGtsQ',
  p: '8DfWJ-BCJxyv7v8_CLFph4Gj0OcgByIGey3uIMcO7NzCLHmWQmfQyI7seIGEZDLFnY6mj2ECJlUVgo56ZGxl6ur3V54NPVolAvQkw0jtTOPaL0k7UcGpQ4fdaOgAE7_6EpXQomsBqqS1ccc2FL0wkBTnpYCG8UHgEfutVW-j_Yk',
  q: '3qyL6Bq_cm4IRE3dMV4exCNihJwRAEqRJ5z6OGxq-W01AHNW7_mQ8-JIj_09qdJ6l9LripRpB4nmTrUcZf310ZcGAONr2jVLRtmbHuMJToLS0SffxSJiXNjIdn8SN5HFthO4rBKG-jUagwy3tsnIAsbfhLZOOulnQRINVFLAIMc',
  dp: 'y3YvsKS0w1X7-g09gYprHLgEXYt1yDTcknarrB2OGbc9y9fMGkC-STEtP0BMN2X9lV7e2rBK1tbYGjW9mtNpW5lamF6pTh7NHHxXqwRY4fhXtBdt4-iJCkbIlPN0JUZEdHtqNDc4OSW6_TzDJLu9pzvdnIOJSE0IkZK_FI8zsik',
  dq: 'a9C33SY2VD2amxfoZaLg2q8XYIYAZVe1eKy1KuSz1xlddF5kVcVMvglugOlpFfTnjuN9UJgTUqcecDWZDnkssNKjAYMcEYeEb0Wlqgrb0rvdP5BC9Lx1S-dbCKT2ORnH1SUvYYGHAVb9Az8BJOwGf_GzABsVPckNSaBn-9AlXrk',
  qi: 'Zz2Dyw9UFsy1TGuBur55ihvvutD2V6Q0GfaYjrfoQ9kWmWV3DTofW5jYcW3i0YelASgasxix11mqnoGu6TE1bdeJmOdp-9PUHaU5Cpnsd2BlmAy4PMsRxWFpJc6Qf6OaQ8dzDV3I-f921RYnWxU4QvjYLW9GbKli3x1UunSSaI4',
  alg: 'RS256',
} as const

function pkceChallenge(verifier: string) {
  return createHash('sha256').update(verifier).digest('base64url')
}

function oauthAuthorizeUrl(baseURL: string, params: Record<string, string>) {
  return `${baseURL}/api/auth/oauth2/authorize?${new URLSearchParams(params).toString()}`
}

test.describe('OAuth discovery endpoints', () => {
  test('consent discloses customer, booking, publishing, financial read and background access', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/oauth/consent?scope=openid%20tenant%20offline_access`)
    await expect(page.getByText('• Read customer inquiries, reservations, booking details, names, contact information, and messages', { exact: true })).toBeVisible()
    await expect(page.getByText('• Save attachments as public media and publish to your website or connected Facebook and Instagram accounts', { exact: true })).toBeVisible()
    await expect(page.getByText('• Create and manage bookings, cancel reservations, and email guests about confirmations, cancellations, and proposed changes', { exact: true })).toBeVisible()
    await expect(page.getByText('• Read payment reports, transactions, balances, payout history, and usage invoices; payment collection and refunds require the dashboard', { exact: true })).toBeVisible()
    await expect(page.getByText('Keep this connection active', { exact: true })).toBeVisible()
    await expect(page.getByText('Submit and track work requests', { exact: true })).toHaveCount(0)
  })

  // Two cases sign in as user-e2e-oauth-cimd against the same CIMD client, and
  // one of them rotates that user's remembered consent, so run in parallel they
  // read each other's consent state. In order, in one worker, they cannot.
  test.describe.configure({ mode: 'default' })

  test('the Kikuzuki publisher can exchange its loopback PKCE code for tenant access', async ({ request, baseURL }) => {
    await loginAs(request, baseURL!, 'user-e2e-kikuzuki-owner')
    expect(process.env.MCP_CIMD_CLIENT_URL, 'MCP_CIMD_CLIENT_URL must name a public HTTPS metadata document').toBeTruthy()
    const clientId = new URL('/oauth-clients/client-localization.json', process.env.MCP_CIMD_CLIENT_URL!).toString()
    const metadata = await request.get(clientId)
    expect(metadata.status()).toBe(200)
    expect(metadata.headers()['content-type']).toContain('application/json')
    const client = await metadata.json() as { client_id: string; redirect_uris: string[] }
    expect(client.client_id).toBe(clientId)
    const redirectUri = client.redirect_uris[0]!
    const verifier = 'kikuzuki-localization-publisher-e2e-verifier-0123456789'
    const authorization = await request.get(oauthAuthorizeUrl(baseURL!, {
      client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
      scope: 'openid tenant', state: 'kikuzuki-publisher', prompt: 'consent',
      code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256',
      resource: `${baseURL}/api/mcp`,
    }), { maxRedirects: 0 })
    expect(authorization.status(), await authorization.text()).toBe(302)
    const consentUrl = new URL(authorization.headers()['location']!, baseURL)
    expect(consentUrl.pathname).toBe('/oauth/consent')
    const consent = await request.post(`${baseURL}/api/auth/oauth2/consent`, {
      headers: { Origin: baseURL! },
      data: { accept: true, oauth_query: consentUrl.search.slice(1) },
    })
    expect(consent.status()).toBe(200)
    const callback = new URL((await consent.json() as { url: string }).url)
    expect(callback.origin + callback.pathname).toBe(redirectUri)
    expect(callback.searchParams.get('state')).toBe('kikuzuki-publisher')
    const token = await request.post(`${baseURL}/api/auth/oauth2/token`, {
      headers: { Origin: baseURL! },
      form: {
        grant_type: 'authorization_code', client_id: clientId,
        code: callback.searchParams.get('code')!, redirect_uri: redirectUri,
        code_verifier: verifier, resource: `${baseURL}/api/mcp`
      },
    })
    expect(token.status()).toBe(200)
    const authorizationResult = await token.json() as { access_token: string; refresh_token?: string }
    expect(authorizationResult.refresh_token).toBeUndefined()
    const workspace = await request.post(`${baseURL}/api/mcp`, {
      headers: { Authorization: `Bearer ${authorizationResult.access_token}`, Accept: 'application/json, text/event-stream' },
      data: {
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'get_workspace_context', arguments: {},
        }
      },
    })
    expect(workspace.status()).toBe(200)
    const result = await mcpJson<{ result: { isError: boolean; structuredContent: { organizations: Array<{ id: string }> } } }>(workspace)
    expect(result.result.isError).toBe(false)
    expect(result.result.structuredContent.organizations.map(organization => organization.id)).toContain('org-bVY8SxxUuG6Ctk2CQnfCk8T2cPsj4jJX')
    const organizationRead = await request.post(`${baseURL}/api/mcp`, {
      headers: { Authorization: `Bearer ${authorizationResult.access_token}`, Accept: 'application/json, text/event-stream' },
      data: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'get_organization', arguments: { organization_id: 'org-bVY8SxxUuG6Ctk2CQnfCk8T2cPsj4jJX' },
      } },
    })
    expect(organizationRead.status()).toBe(200)
    const organizationResult = await mcpJson<{ result: { isError: boolean; structuredContent: { context: { organization_id: string } } } }>(organizationRead)
    expect(organizationResult.result.isError).toBe(false)
    expect(organizationResult.result.structuredContent.context.organization_id).toBe('org-bVY8SxxUuG6Ctk2CQnfCk8T2cPsj4jJX')
  })

  // One discovery pass: a client reads all three documents back to back, and
  // splitting them into three tests only repeats the fixture.
  test('the three OAuth discovery documents describe this resource server', async ({ request, baseURL }) => {
    const protectedResource = await request.get(`${baseURL}/.well-known/oauth-protected-resource`)
    expect(protectedResource.status()).toBe(200)
    const resourceBody = await protectedResource.json() as Record<string, unknown>
    expect(resourceBody.resource).toBe(`${baseURL}/api/mcp`)
    expect(Array.isArray(resourceBody.authorization_servers)).toBe(true)
    expect((resourceBody.authorization_servers as string[]).length).toBeGreaterThan(0)
    expect(resourceBody.bearer_methods_supported as string[]).toContain('header')

    const openid = await request.get(`${baseURL}/.well-known/openid-configuration`)
    expect(openid.status()).toBe(200)
    const openidBody = await openid.json() as Record<string, unknown>
    // OpenID Connect Discovery requires RS256 support. ChatGPT validates the
    // ID token after code exchange and will abort before MCP initialize when
    // the provider advertises only Better Auth's EdDSA default.
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
  })

  test('public CIMD exchanges codes once, rotates refresh grants and reuses remembered consent', async ({ request, baseURL }) => {
    await loginAs(request, baseURL!, 'user-e2e-oauth-cimd')

    const cimdClientId = process.env.MCP_CIMD_CLIENT_URL!
    expect(cimdClientId, 'MCP_CIMD_CLIENT_URL must name a public HTTPS metadata document').toBeTruthy()
    const redirectUri = new URL('/oauth/test-callback', cimdClientId).toString()
    const verifier = 'krabiclaw-public-cimd-e2e-verifier-0123456789'
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
          clientInfo: { name: 'krabiclaw-release-e2e', version: '1.0.0' },
        }
      },
    })
    expect(initialized.status(), await initialized.text()).toBe(200)
    expect(await mcpJson(initialized)).toMatchObject({ result: { protocolVersion: '2025-06-18' } })

    const tools = await request.post(`${baseURL}/api/mcp`, {
      headers: {
        Authorization: `Bearer ${refreshedBody.access_token}`,
        Accept: 'application/json, text/event-stream',
        Cookie: '',
      },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    })
    expect(tools.status(), await tools.text()).toBe(200)
    const toolsBody = await mcpJson<{ result: { tools: Array<{ name: string }> } }>(tools)
    expect(toolsBody.error).toBeUndefined()
    expect(toolsBody.result.tools.length).toBeGreaterThan(0)

    const refreshReplay = await refreshGrant()
    expect(refreshReplay.status()).toBe(400)
    expect(await refreshReplay.json()).toMatchObject({ error: 'invalid_grant' })

    const replay = await exchangeCode()
    expect(replay.status()).toBe(400)

    const secondAuthorize = await request.get(oauthAuthorizeUrl(baseURL!, {
      ...authorizeParams,
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
  })

  test('requesting the email scope makes email and email_verified available through UserInfo', async ({ request, baseURL }) => {
    await loginAs(request, baseURL!, 'user-e2e-oauth-cimd')

    const cimdClientId = process.env.MCP_CIMD_CLIENT_URL!
    expect(cimdClientId, 'MCP_CIMD_CLIENT_URL must name a public HTTPS metadata document').toBeTruthy()
    const redirectUri = new URL('/oauth/test-callback', cimdClientId).toString()
    const verifier = 'krabiclaw-email-scope-e2e-verifier-0123456789'
    const authorizeParams = {
      client_id: cimdClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email offline_access tenant',
      state: 'email-scope-pass',
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
      resource: `${baseURL}/api/mcp`,
    }

    const authorize = await request.get(oauthAuthorizeUrl(baseURL!, {
      ...authorizeParams,
      prompt: 'consent',
    }), { maxRedirects: 0 })
    expect(authorize.status()).toBe(302)
    const consentLocation = authorize.headers()['location']
    expect(consentLocation).toContain('/oauth/consent?')

    const consentUrl = new URL(consentLocation!, baseURL)
    const consentRes = await request.post(`${baseURL}/api/auth/oauth2/consent`, {
      headers: { Origin: baseURL! },
      data: { accept: true, oauth_query: consentUrl.search.slice(1) },
    })
    expect(consentRes.status()).toBe(200)
    const consentBody = await consentRes.json() as { url?: string }
    const code = new URL(consentBody.url!).searchParams.get('code')
    expect(code).toBeTruthy()

    const token = await request.post(`${baseURL}/api/auth/oauth2/token`, {
      headers: { Origin: baseURL! },
      form: {
        grant_type: 'authorization_code',
        client_id: cimdClientId,
        code: code!,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
    })
    expect(token.status()).toBe(200)
    const tokenBody = await token.json() as { access_token?: string, scope?: string }
    expect(tokenBody.access_token).toBeTruthy()
    expect(tokenBody.scope).toContain('email')

    const userinfo = await request.get(`${baseURL}/api/auth/oauth2/userinfo`, {
      headers: { Authorization: `Bearer ${tokenBody.access_token}` },
    })
    expect(userinfo.status()).toBe(200)
    const userinfoBody = await userinfo.json() as { email?: string, email_verified?: boolean }
    expect(userinfoBody.email).toBeTruthy()
    expect(userinfoBody.email_verified).toBe(true)
  })

  test('CIMD uses its declared private_key_jwt method and rejects assertion replay', async ({ request, baseURL }) => {
    await loginAs(request, baseURL!, 'user-e2e-oauth-private-cimd')

    const clientId = process.env.MCP_PRIVATE_CIMD_CLIENT_URL!
    expect(clientId, 'MCP_PRIVATE_CIMD_CLIENT_URL must name a public HTTPS metadata document').toBeTruthy()
    const redirectUri = new URL('/oauth/test-callback', clientId).toString()
    const verifier = 'krabiclaw-private-cimd-e2e-verifier-0123456789'
    const authorizeParams = {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid offline_access tenant',
      state: 'private-first',
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
      resource: `${baseURL}/api/mcp`,
    }

    const authorize = await request.get(oauthAuthorizeUrl(baseURL!, {
      ...authorizeParams,
      prompt: 'consent',
    }), { maxRedirects: 0 })
    expect(authorize.status()).toBe(302)
    const consentUrl = new URL(authorize.headers()['location']!, baseURL)
    expect(consentUrl.pathname).toBe('/oauth/consent')

    const consent = await request.post(`${baseURL}/api/auth/oauth2/consent`, {
      headers: { Origin: baseURL! },
      data: { accept: true, oauth_query: consentUrl.search.slice(1) },
    })
    expect(consent.status()).toBe(200)
    const consentBody = await consent.json() as { url: string }
    const code = new URL(consentBody.url).searchParams.get('code')
    expect(code).toBeTruthy()

    const now = Math.floor(Date.now() / 1000)
    const privateKey = await importJWK(PRIVATE_CLIENT_TEST_JWK, 'RS256')
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: PRIVATE_CLIENT_TEST_KEY_ID })
      .setIssuer(clientId)
      .setSubject(clientId)
      .setAudience(`${baseURL}/api/auth/oauth2/token`)
      .setIssuedAt(now)
      .setExpirationTime(now + 120)
      .setJti(`cimd-replay-${crypto.randomUUID()}`)
      .sign(privateKey)

    const token = await request.post(`${baseURL}/api/auth/oauth2/token`, {
      headers: { Origin: baseURL! },
      form: {
        grant_type: 'authorization_code',
        client_id: clientId,
        code: code!,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
      },
    })
    expect(token.status(), await token.text()).toBe(200)
    const tokenBody = await token.json() as { access_token?: string, id_token?: string }
    expect(tokenBody.access_token).toBeTruthy()
    expect(tokenBody.id_token).toBeTruthy()
    expect(decodeProtectedHeader(tokenBody.id_token!).alg).toBe('RS256')

    // ChatGPT probes the modern protocol first. A legacy HTTP error must
    // identify this server before the client retries the initialize handshake.
    const mcpHeaders = {
      Authorization: `Bearer ${tokenBody.access_token}`,
      Accept: 'application/json, text/event-stream',
      Cookie: '',
    }
    const discovered = await request.post(`${baseURL}/api/mcp`, {
      headers: { ...mcpHeaders, 'MCP-Protocol-Version': '2026-07-28' },
      data: {
        jsonrpc: '2.0', id: 'openai-mcp-discover', method: 'server/discover', params: {
          _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
        }
      },
    })
    expect(discovered.status()).toBe(400)
    // @modelcontextprotocol/server classifies this as a modern (2026-07-28)
    // exchange from the MCP-Protocol-Version header, then rejects it for a
    // more precise reason than the old hand-rolled "unsupported version"
    // check: the envelope is missing the modern protocol's required
    // clientCapabilities field. Either way the legacy client sees a 400 and
    // retries with a legacy initialize below, which is the actual contract
    // under test.
    expect(await mcpJson(discovered)).toMatchObject({
      id: 'openai-mcp-discover', error: { code: -32602, data: { envelope: { key: 'io.modelcontextprotocol/clientCapabilities', problem: 'missing' } } },
    })
    const initialized = await request.post(`${baseURL}/api/mcp`, {
      headers: mcpHeaders,
      data: {
        jsonrpc: '2.0', id: 'legacy-init', method: 'initialize', params: {
          protocolVersion: '2025-11-25', capabilities: {},
          clientInfo: { name: 'krabiclaw-release-e2e', version: '1.0.0' },
        }
      },
    })
    expect(initialized.status()).toBe(200)
    expect(await mcpJson(initialized)).toMatchObject({ result: { protocolVersion: '2025-11-25' } })
    const tools = await request.post(`${baseURL}/api/mcp`, {
      headers: { ...mcpHeaders, 'MCP-Protocol-Version': '2025-11-25' },
      data: { jsonrpc: '2.0', id: 'legacy-tools', method: 'tools/list', params: {} },
    })
    expect(tools.status()).toBe(200)
    expect((await mcpJson<{ result: { tools: unknown[] } }>(tools)).result.tools.length).toBeGreaterThan(0)

    const secondAuthorize = await request.get(oauthAuthorizeUrl(baseURL!, {
      ...authorizeParams,
      state: 'private-replay',
    }), { maxRedirects: 0 })
    expect(secondAuthorize.status()).toBe(302)
    const replayCode = new URL(secondAuthorize.headers()['location']!, baseURL).searchParams.get('code')
    expect(replayCode).toBeTruthy()

    const replay = await request.post(`${baseURL}/api/auth/oauth2/token`, {
      headers: { Origin: baseURL! },
      form: {
        grant_type: 'authorization_code',
        client_id: clientId,
        code: replayCode!,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
      },
    })
    expect(replay.status()).toBeGreaterThanOrEqual(400)
    const replayBody = await replay.json() as { error?: string, error_description?: string }
    expect(replayBody.error).toBeTruthy()
    expect(replayBody.error_description).toMatch(/assertion|replay|already/i)
  })

  test('unauthenticated modern MCP probe returns OAuth challenge before version validation', async ({ request, baseURL }) => {
    const MCP_VERSION = '2026-07-28'
    const res = await request.post(`${baseURL}/api/mcp`, {
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': MCP_VERSION,
        'mcp-method': 'server/discover',
      },
      data: {
        jsonrpc: '2.0',
        id: 'auth-check',
        method: 'server/discover',
        params: {},
        _meta: {
          'io.modelcontextprotocol/version': MCP_VERSION,
          'io.modelcontextprotocol/method': 'server/discover',
        },
      },
    })
    expect(res.status()).toBe(401)
    const wwwAuth = res.headers()['www-authenticate']
    expect(wwwAuth).toBeTruthy()
    expect(wwwAuth).toContain('Bearer')
    expect(wwwAuth).toContain('resource_metadata=')
    expect(wwwAuth).toContain('/.well-known/oauth-protected-resource')
  })

  test('unauthenticated MCP tool call returns mcp/www_authenticate challenge', async ({ request, baseURL }) => {
    const MCP_VERSION = '2025-06-18'
    const res = await request.post(`${baseURL}/api/mcp`, {
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': MCP_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': 'list_organizations',
      },
      data: {
        jsonrpc: '2.0',
        id: 'auth-tool-check',
        method: 'tools/call',
        params: {
          name: 'list_organizations',
          arguments: {},
        },
        _meta: {
          'io.modelcontextprotocol/version': MCP_VERSION,
          'io.modelcontextprotocol/method': 'tools/call',
          'io.modelcontextprotocol/name': 'list_organizations',
        },
      },
    })
    expect(res.status()).toBe(200)
    const body = await res.json() as {
      result?: {
        isError?: boolean
        _meta?: Record<string, unknown>
      }
    }
    expect(body.result?.isError).toBe(true)
    const resourceMetadata = new URL('/.well-known/oauth-protected-resource/api/mcp', baseURL!).href
    expect(body.result?._meta?.['mcp/www_authenticate']).toEqual([
      `Bearer resource_metadata="${resourceMetadata}", error="invalid_token", error_description="Authentication required: connect KrabiClaw to continue."`,
    ])
  })

})
