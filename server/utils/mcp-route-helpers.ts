import type { H3Event } from 'nitro';
import { setResponseHeader } from 'nitro/h3';
import { mcpErrorRecoveryDetails } from '~/server/utils/mcp-protocol'
import { APIError, isAPIError } from 'better-auth/api'
import { createResourceServerChallenge } from '@better-auth/oauth-provider'
import { bearerAuthChallengeResponse, OAuthError, OAuthErrorCode, type CallToolResult } from '@modelcontextprotocol/server'

export function buildMcpOAuthChallenge(options: {
  resourceUrl: string
  description: string
}) {
  const error = createResourceServerChallenge(new APIError('UNAUTHORIZED', { message: options.description }), options.resourceUrl)
  const challenge = mcpAuthChallengeFromError(error)
  if (!challenge) throw new Error('Better Auth did not provide an authentication challenge')
  return challenge
}

export function setMcpAuthChallenge(event: H3Event, challenge: string) {
  setResponseHeader(event, 'WWW-Authenticate', challenge)
}

export function mcpAuthRequiredResult(options: { challenge: string; message: string }): CallToolResult {
  let challenge = options.challenge
  // Tool-level OAuth requires error parameters even when the HTTP challenge is bare.
  if (!/(?:^\S+\s+|,\s*)error=/.test(challenge)) {
    const errorChallenge = bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InvalidToken, options.message)).headers.get('WWW-Authenticate')
    if (!errorChallenge?.startsWith('Bearer ')) throw new Error('MCP SDK did not provide a Bearer authentication challenge')
    challenge += `, ${errorChallenge.slice('Bearer '.length)}`
  }
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: options.message,
      },
    ],
    _meta: {
      'mcp/www_authenticate': [challenge],
    },
  }
}

export function mcpToolErrorResult(message: string, data?: unknown, platformOrigin?: string) {
  const details = data && typeof data === 'object' ? data : {}
  const code = 'code' in details && typeof details.code === 'string' ? details.code : undefined
  const status = 'status' in details && Number.isInteger(details.status) && Number(details.status) >= 400 && Number(details.status) < 600 ? Number(details.status) : undefined
  let dashboardUrl: string | undefined
  let dashboardUrlError: string | undefined
  if (platformOrigin && 'dashboard_url' in details && typeof details.dashboard_url === 'string') {
    try {
      const origin = new URL(platformOrigin)
      const url = new URL(details.dashboard_url, origin.origin)
      if (['https:', 'http:'].includes(origin.protocol) && url.origin === origin.origin && !url.username && !url.password && url.pathname.startsWith('/dashboard/')) dashboardUrl = url.toString()
      else dashboardUrlError = 'invalid_destination'
    } catch { dashboardUrlError = 'invalid_destination' }
  }
  const recovery = mcpErrorRecoveryDetails(details)
  const action = status || code || Object.keys(recovery).length ? { ...(status ? { status } : {}), message, ...recovery, ...(dashboardUrl ? { dashboard_url: dashboardUrl } : {}), ...(dashboardUrlError ? { dashboard_url_error: dashboardUrlError } : {}) } : undefined
  // Structured content must match the tool's success schema; errors use content.
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: action ? JSON.stringify(action) : message,
      },
    ],
  }
}

export function mcpAuthChallengeFromError(error: unknown): string | null {
  return isAPIError(error) ? new Headers(error.headers).get('WWW-Authenticate') : null
}

export function buildMcpAuthChallengeForError(
  error: unknown,
  options: { resourceUrl: string; defaultDescription: string },
) {
  return mcpAuthChallengeFromError(error) ?? buildMcpOAuthChallenge({
    resourceUrl: options.resourceUrl,
    description: options.defaultDescription,
  })
}

export function describeMcpAuthTelemetryError(
  error: unknown,
  options?: { fallback?: string; prefix?: string },
) {
  const prefix = options?.prefix ?? 'credential_rejected'
  const fallback = options?.fallback ?? (error instanceof Error ? error.message : String(error))
  return `${prefix}: ${fallback}`
}

export function getCloudflareWaitUntil(event: H3Event): ((_promise: Promise<unknown>) => void) | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = (event.req.runtime?.cloudflare as any)?.context as { waitUntil?: (_p: Promise<unknown>) => void } | undefined
  return ctx?.waitUntil?.bind(ctx)
}

export function isMcpMutatingTool(tool: { annotations?: { readOnlyHint?: boolean } } | undefined | null) {
  return tool?.annotations?.readOnlyHint === false
}
