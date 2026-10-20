// Pre-dispatch credential-presence check shared by server/api/mcp.ts.
// The seven standard non-tool-call JSON-RPC methods this file used to
// dispatch (ping, resources/*, prompts/*, server/discover,
// notifications/initialized) are now @modelcontextprotocol/server's own —
// see server/api/mcp.ts for what's left in our hands.
import type { H3Event } from 'nitro';
import type { CallToolResult } from '@modelcontextprotocol/server';

export interface McpToolMeta {
  domain?: string | null
  isMutating?: boolean
}

export interface McpSurfaceRuntimeConfig {
  authOptions: RequireMcpUserOptions
  resourceUrl: (_baseUrl: string) => string
  authDescription: string
  authRequiredText: string
  logEvent: (_event: H3Event, _fields: Record<string, unknown>) => void
  resolveToolMeta: (_toolName: string | null) => McpToolMeta
}

/**
 * Handles the pre-parse "no bearer token, no cookie" branch shared by both
 * surfaces: a `tools/call` request must fail as a 200 JSON-RPC envelope
 * carrying an embedded auth-required tool result (MCP clients can't act on a
 * raw 401 mid-tool-call), while every other method fails with a real 401 +
 * WWW-Authenticate so OAuth clients can discover the authorization server.
 * Returns `{ handled: false }` when a bearer token or cookie is present, so
 * the caller proceeds to authenticate and dispatch the parsed request body.
 */
export async function resolveMissingMcpCredential(
  event: H3Event, config: Pick<McpSurfaceRuntimeConfig, 'resourceUrl' | 'authDescription' | 'authRequiredText' | 'logEvent' | 'resolveToolMeta'>, baseUrl: string, body: unknown, ): Promise<
  | { handled: false }
  | { handled: true; requestId: JsonRpcId | undefined; requestMethod: string | undefined; requestToolName: string | undefined; toolResult: CallToolResult }
  | { handled: true; requestId: JsonRpcId | undefined; requestMethod: string | undefined; requestToolName: string | undefined; response: unknown }
> {
  if (event.req.headers.get('authorization') || event.req.headers.get('cookie')) {
    return { handled: false }
  }

  const rawBody = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  const requestId = rawBody?.id as JsonRpcId | undefined
  const requestMethod = rawBody?.method as string | undefined
  const requestToolName = rawBody?.params && typeof rawBody.params === 'object' && !Array.isArray(rawBody.params)
    && typeof (rawBody.params as Record<string, unknown>).name === 'string'
    ? String((rawBody.params as Record<string, unknown>).name)
    : undefined

  const authChallenge = buildMcpOAuthChallenge({
    resourceUrl: config.resourceUrl(baseUrl), description: config.authDescription, })

  if (requestMethod === 'tools/call') {
    const toolMeta = config.resolveToolMeta(requestToolName ?? null)
    config.logEvent(event, {
      requestId: requestId ?? null, method: requestMethod, toolName: requestToolName ?? null, toolDomain: requestToolName ? toolMeta.domain ?? null : null, status: 'auth_required', errorMessage: 'credential_missing: missing bearer token or cookie', })
    return {
      handled: true, requestId, requestMethod, requestToolName, toolResult: mcpAuthRequiredResult({ challenge: authChallenge, message: config.authRequiredText }), }
  }

  event.res.status = 401
  setMcpAuthChallenge(event, authChallenge)
  return {
    handled: true, requestId, requestMethod, requestToolName, response: mcpFailure(requestId ?? null, { code: MCP_ERROR.invalidRequest, message: 'Authentication required.' }), }
}
