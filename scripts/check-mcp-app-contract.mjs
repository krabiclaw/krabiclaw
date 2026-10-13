#!/usr/bin/env node

import { authHeaders, BASE_URL, credentialsConfigured, expectStatus, fail, finish, pass, request, run, skip } from './utils/mcp-check.mjs'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const MCP_VERSION = process.env.MCP_PROTOCOL_VERSION ?? '2025-06-18'

async function main() {
  console.log(`Checking MCP Apps contract at ${BASE_URL}`)

  const unauth = await request('tools/list')
  expectStatus('unauthenticated tools/list returns 401', unauth, 401)
  const wwwAuth = unauth.res.headers.get('www-authenticate') ?? ''
  if (wwwAuth.includes('resource_metadata=')) pass('WWW-Authenticate includes resource_metadata')
  else fail('WWW-Authenticate missing resource_metadata', wwwAuth)

  const unauthTool = await request('tools/call', { name: 'list_organizations', arguments: {} })
  expectStatus('unauthenticated tools/call returns JSON-RPC auth result', unauthTool, 200)
  const toolChallenge = unauthTool.body?.result?._meta?.['mcp/www_authenticate']?.[0] ?? ''
  if (
    unauthTool.body?.result?.isError === true
    && toolChallenge.includes('resource_metadata=')
    && toolChallenge.includes('error="invalid_token"')
    && toolChallenge.includes('error_description=')
  ) {
    pass('unauthenticated tools/call includes mcp/www_authenticate challenge')
  } else {
    fail('unauthenticated tools/call missing mcp/www_authenticate challenge', unauthTool.body)
  }

  if (!credentialsConfigured) {
    skip('authenticated checks need MCP_BEARER_TOKEN, local credentials, or MCP_CREDENTIAL_LOGIN=1 for a tunnel')
    finish()
  }
  const headers = await authHeaders()

  const init = await request('initialize', { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: 'krabiclaw-contract-check', version: '0.1.0' } }, headers)
  expectStatus('initialize succeeds', init, 200)
  if (init.body?.result?.capabilities?.tools) pass('initialize advertises tools capability')
  else fail('initialize did not advertise tools capability', init.body)
  if (init.body?.result?.protocolVersion === MCP_VERSION) pass('initialize negotiates requested protocol version')
  else fail('initialize negotiated unexpected protocol version', init.body)

  const initialized = await request('notifications/initialized', {}, headers, { omitId: true })
  expectStatus('notifications/initialized is accepted', initialized, 202)

  const tools = await request('tools/list', {}, headers)
  expectStatus('tools/list succeeds', tools, 200)
  const toolList = tools.body?.result?.tools ?? []
  for (const tool of toolList) {
    const securitySchemes = tool.securitySchemes ?? []
    const metaSecuritySchemes = tool._meta?.securitySchemes ?? []
    const hasTenantOauth = securitySchemes.some(scheme =>
      scheme?.type === 'oauth2' && Array.isArray(scheme.scopes) && scheme.scopes.includes('tenant')
    )
    const metaMatches = JSON.stringify(securitySchemes) === JSON.stringify(metaSecuritySchemes)
    if (hasTenantOauth && metaMatches) pass(`${tool.name} declares tenant OAuth security scheme`)
    else fail(`${tool.name} missing tenant OAuth security scheme`, { securitySchemes, metaSecuritySchemes })
  }
  const client = new Client({ name: 'krabiclaw-contract-check', version: '0.1.0' }, {
    versionNegotiation: { mode: { pin: '2026-07-28' } },
  })
  const credentialHeaders = new Headers(headers)
  let toolStatus
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/api/mcp`), {
    requestInit: { headers: credentialHeaders },
    fetch: async (url, init) => {
      const response = await fetch(url, init)
      if (new Headers(init?.headers).get('Mcp-Method') === 'tools/call') toolStatus = response.status
      return response
    },
  })
  try {
    await client.connect(transport)
    const welcome = await client.callTool({ name: 'list_organizations', arguments: {} })
    if (toolStatus === 200 && !welcome.isError && Array.isArray(welcome.structuredContent?.organizations) && welcome.structuredContent.organizations.length > 0) {
      pass('current MCP client decodes authenticated list_organizations with tenant data')
    } else fail('current MCP client did not receive organizations', { status: toolStatus, result: welcome })

    for (const [label, credentials] of [
      ['missing credentials', {}],
      ['invalid bearer token', { authorization: 'Bearer invalid-mcp-contract-token' }],
    ]) {
      credentialHeaders.delete('authorization')
      credentialHeaders.delete('cookie')
      for (const [name, value] of Object.entries(credentials)) credentialHeaders.set(name, value)
      const result = await client.callTool({ name: 'list_organizations', arguments: {} })
      const challenge = result._meta?.['mcp/www_authenticate']?.[0] ?? ''
      if (toolStatus === 200 && result.isError === true && result.structuredContent === undefined
        && challenge.includes(`resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/api/mcp"`)
        && challenge.includes('error="invalid_token"') && challenge.includes('error_description=')) {
        pass(`current MCP client decodes ${label} as auth error without tenant data`)
      } else fail(`current MCP client received invalid ${label} result`, { status: toolStatus, result })
    }
  } finally {
    await client.close()
  }

  const malformedCall = await request('tools/call', { name: 'save_media_attachment', arguments: null }, headers)
  expectStatus('malformed tools/call arguments return JSON-RPC envelope', malformedCall, 200)
  if (malformedCall.body?.error?.code === -32602 && String(malformedCall.body?.error?.message ?? '').includes('"arguments"')) {
    pass('malformed tools/call arguments are non-terminating JSON-RPC invalidParams')
  } else {
    fail('malformed tools/call arguments did not return JSON-RPC invalidParams', malformedCall.body)
  }

}

run(main)
