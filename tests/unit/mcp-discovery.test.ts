import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAgentCard, buildAiCatalog, buildMcpServerCard } from '../../server/utils/mcp-discovery.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

test('buildMcpServerCard generates a valid SEP-2127 server card referencing canonical MCP and OAuth endpoints', () => {
  const env = {
    BETTER_AUTH_URL: 'https://blawby.com',
    NUXT_PUBLIC_APP_NAME: 'Blawby',
  } as CloudflareEnv

  const card = buildMcpServerCard(env)
  assert.equal(card.version, '1.0')
  assert.equal(card.serverInfo.name, 'blawby-mcp')
  assert.equal(card.serverInfo.version, 'phase-5')
  assert.deepEqual(card.transports, [{ type: 'http', url: 'https://blawby.com/api/mcp' }])
  assert.equal(card.authentication?.type, 'oauth2')
  assert.equal(card.authentication?.resourceMetadata, 'https://blawby.com/.well-known/oauth-protected-resource/api/mcp')
})

test('buildAgentCard generates a valid A2A Agent Card v1.0 referencing the MCP transport and auth endpoints', () => {
  const env = {
    BETTER_AUTH_URL: 'https://blawby.com',
    NUXT_PUBLIC_APP_NAME: 'Blawby',
  } as CloudflareEnv

  const agentCard = buildAgentCard(env)
  assert.equal(agentCard.schemaVersion, '1.0')
  assert.equal(agentCard.name, 'Blawby')
  assert.equal(agentCard.url, 'https://blawby.com')
  assert.equal(agentCard.capabilities.mcp?.endpoint, 'https://blawby.com/api/mcp')
  assert.equal(agentCard.capabilities.mcp?.serverCard, 'https://blawby.com/api/mcp/server-card')
  assert.equal(agentCard.authentication?.type, 'oauth2')
  assert.equal(agentCard.authentication?.authorizationServer, 'https://blawby.com/.well-known/oauth-authorization-server')
})

test('buildAiCatalog generates an Agentic Resource Discovery manifest pointing to both cards', () => {
  const env = {
    BETTER_AUTH_URL: 'https://blawby.com',
    NUXT_PUBLIC_APP_NAME: 'Blawby',
  } as CloudflareEnv

  const catalog = buildAiCatalog(env)
  assert.equal(catalog.specVersion, '1.0')
  assert.equal(catalog.entries.length, 2)
  assert.deepEqual(catalog.entries[0], {
    identifier: 'urn:mcp:server:blawby-mcp',
    type: 'application/mcp-server-card+json',
    url: 'https://blawby.com/api/mcp/server-card',
  })
  assert.deepEqual(catalog.entries[1], {
    identifier: 'urn:agent:card:blawby-mcp',
    type: 'application/agent-card+json',
    url: 'https://blawby.com/.well-known/agent-card.json',
  })
})
