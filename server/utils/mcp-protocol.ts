// Error-shaping shared between the MCP route (server/api/mcp.ts) and
// every tool executor. JSON-RPC envelope parsing, protocol-version
// negotiation, and the standard non-tool-call methods now belong to
// @modelcontextprotocol/server (see server/api/mcp.ts) — this file only
// keeps the pieces executors and the route still need: a typed error shape
// business logic can throw, and the two envelope builders used for the
// handful of responses the route still builds by hand (credential-missing,
// pre-dispatch auth failures) before handing off to the SDK.

import { isAPIError } from 'better-auth/api'

export type JsonRpcId = string | number | null

export interface McpErrorShape {
  code: number
  message: string
  data?: unknown
  kind?: McpFailureKind
}

export type McpFailureKind =
  | 'protocol'
  | 'tool_execution'
  | 'auth'
  | 'forbidden'
  | 'transport'

export const MCP_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const

export function mcpSuccess(id: JsonRpcId | undefined, result: unknown) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result,
  }
}

export function mcpFailure(id: JsonRpcId | undefined, error: McpErrorShape) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error,
  }
}

export function mcpProtocolError(code: number, message: string, data?: unknown, kind: McpFailureKind = 'tool_execution') {
  const error = new Error(message) as Error & { mcp: McpErrorShape }
  error.mcp = { code, message, data, kind }
  return error
}

export function mcpErrorRecoveryIds(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const details = value as Record<string, unknown>
  return Object.fromEntries(['organization_id', 'draft_id', 'invitation_id', 'location_id', 'product_id', 'request_id'].flatMap(key =>
    typeof details[key] === 'string' && /^[A-Za-z0-9_:-]{1,200}$/.test(details[key]) ? [[key, details[key]]] : [],
  ))
}

export function mcpErrorRecoveryDetails(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const details = value as Record<string, unknown>
  const recovery: Record<string, unknown> = mcpErrorRecoveryIds(details)
  if (typeof details.code === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(details.code)) recovery.code = details.code
  for (const key of ['missing', 'missing_fields', 'invalid_fields', 'fields', 'missing_product_ids', 'draft_ids', 'removed_block_ids', 'resource_ids']) {
    const values = details[key]
    const pattern = ['missing', 'missing_fields', 'invalid_fields', 'fields'].includes(key) ? /^[A-Za-z_][A-Za-z0-9_.\[\]]*$/ : /^[A-Za-z0-9_:-]{1,200}$/
    if (Array.isArray(values) && values.every(value => typeof value === 'string' && pattern.test(value))) recovery[key] = values
  }
  if (typeof details.resource_type === 'string' && /^[a-z_]+$/.test(details.resource_type)) recovery.resource_type = details.resource_type
  if (Number.isInteger(details.index) && Number(details.index) >= 0) recovery.index = details.index
  if (Array.isArray(details.missing_prices) && details.missing_prices.every(value => value && typeof value === 'object' && typeof value.product_id === 'string' && typeof value.name === 'string')) {
    recovery.missing_prices = details.missing_prices.map(({ product_id, name }) => ({ product_id, name }))
  }
  if (Array.isArray(details.skipped) && details.skipped.every(value => value && typeof value === 'object'
    && ['rule_id', 'local_date', 'local_start_time'].every(key => typeof value[key] === 'string')
    && ['nonexistent_local_time', 'ambiguous_local_time', 'location_closed'].includes(value.reason))) {
    recovery.skipped = details.skipped.map(({ rule_id, local_date, local_start_time, reason }) => ({ rule_id, local_date, local_start_time, reason }))
  }
  return recovery
}

export function asMcpError(error: unknown): McpErrorShape {
  if (error && typeof error === 'object' && 'mcp' in error) {
    const shape = (error as { mcp: McpErrorShape }).mcp
    return { code: shape.code, message: shape.message, data: shape.data, kind: shape.kind }
  }

  // REST and MCP share typed failures. Preserve their status and recovery fields.
  const status = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : NaN
  if (error && typeof error === 'object' && Number.isInteger(status) && status >= 400 && status < 600) {
    const message = typeof (error as { statusMessage?: unknown }).statusMessage === 'string'
      ? (error as { statusMessage: string }).statusMessage
      : error instanceof Error ? error.message : 'Invalid request.'
    const details = isAPIError(error) ? error.body ?? {} : 'data' in error && error.data && typeof error.data === 'object' ? error.data : {}
    const data = {
      status,
      ...mcpErrorRecoveryDetails(details),
      ...('dashboard_url' in details && typeof details.dashboard_url === 'string' ? { dashboard_url: details.dashboard_url } : {}),
    }
    return { code: [400, 404].includes(status) ? MCP_ERROR.invalidParams : MCP_ERROR.internal, message,
      kind: status === 401 ? 'auth' : status === 403 ? 'forbidden' : status >= 500 ? 'transport' : 'tool_execution',
      data,
    }
  }

  if (error instanceof Error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode
    const kind: McpFailureKind = statusCode === 401 ? 'auth' : statusCode === 403 ? 'forbidden' : 'transport'
    return { code: MCP_ERROR.internal, message: error.message, kind }
  }

  return { code: MCP_ERROR.internal, message: 'Internal server error', kind: 'transport' }
}
