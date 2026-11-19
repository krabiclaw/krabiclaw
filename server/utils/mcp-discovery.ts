import type { CloudflareEnv } from '~/server/utils/auth'

export interface McpServerCard {
  version: string
  serverInfo: {
    name: string
    version: string
    description: string
  }
  transports: Array<{
    type: string
    url: string
  }>
  capabilities?: {
    tools?: Record<string, unknown>
    prompts?: Record<string, unknown>
  }
  authentication?: {
    type: string
    resourceMetadata: string
  }
}

export interface AgentCard {
  schemaVersion: string
  name: string
  description: string
  url: string
  capabilities: {
    mcp?: {
      endpoint: string
      serverCard: string
    }
  }
  authentication?: {
    type: string
    authorizationServer: string
  }
}

export interface AiCatalog {
  specVersion: string
  entries: Array<{
    identifier: string
    type: string
    url: string
  }>
}

function resolveBaseUrl(env: CloudflareEnv): string {
  const url = (env.BETTER_AUTH_URL ?? env.NUXT_PUBLIC_PLATFORM_DOMAIN ?? env.NUXT_PUBLIC_SITE_URL)?.replace(/\/$/, '')
  if (!url) throw new Error('BETTER_AUTH_URL is required')
  return url
}

export function mcpServerIdentity(env: CloudflareEnv) {
  const title = env.NUXT_PUBLIC_APP_NAME ?? 'Blawby'
  return { name: `${title.toLowerCase()}-mcp`, title, version: 'phase-5' }
}

export function buildMcpServerCard(env: CloudflareEnv): McpServerCard {
  const baseUrl = resolveBaseUrl(env)
  const { name, version } = mcpServerIdentity(env)
  return {
    version: '1.0',
    serverInfo: {
      name,
      version,
      description: 'Manage website content, offerings, stays, reservations, inquiries, and legal consultations.',
    },
    transports: [
      {
        type: 'http',
        url: `${baseUrl}/api/mcp`,
      },
    ],
    capabilities: {
      tools: {},
      prompts: {},
    },
    authentication: {
      type: 'oauth2',
      resourceMetadata: `${baseUrl}/.well-known/oauth-protected-resource/api/mcp`,
    },
  }
}

export function buildAgentCard(env: CloudflareEnv): AgentCard {
  const baseUrl = resolveBaseUrl(env)
  const appName = env.NUXT_PUBLIC_APP_NAME ?? 'Blawby'
  return {
    schemaVersion: '1.0',
    name: appName,
    description: 'AI business management agent for websites, offerings, stays, and consultations.',
    url: baseUrl,
    capabilities: {
      mcp: {
        endpoint: `${baseUrl}/api/mcp`,
        serverCard: `${baseUrl}/api/mcp/server-card`,
      },
    },
    authentication: {
      type: 'oauth2',
      authorizationServer: `${baseUrl}/.well-known/oauth-authorization-server`,
    },
  }
}

export function buildAiCatalog(env: CloudflareEnv): AiCatalog {
  const baseUrl = resolveBaseUrl(env)
  const { name: serverName } = mcpServerIdentity(env)
  return {
    specVersion: '1.0',
    entries: [
      {
        identifier: `urn:mcp:server:${serverName}`,
        type: 'application/mcp-server-card+json',
        url: `${baseUrl}/api/mcp/server-card`,
      },
      {
        identifier: `urn:agent:card:${serverName}`,
        type: 'application/agent-card+json',
        url: `${baseUrl}/.well-known/agent-card.json`,
      },
    ],
  }
}
