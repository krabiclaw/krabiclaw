import { randomUUID } from 'node:crypto'
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test'
import { loginAs } from './auth'
import { E2E_DEMO_ORGANIZATION_ID } from '../test-env'

// The Streamable HTTP transport requires clients to accept both
// application/json and text/event-stream (see the Accept header below), and
// @modelcontextprotocol/server reserves the right to answer with either —
// our own stateless tool calls always resolve a single terminal result, but
// the SDK still wraps it as a one-event SSE stream rather than a plain JSON
// body. Real MCP clients already have to handle both; this makes
// mcpRequest()'s return value do the same so every existing `.json()` call
// site across the e2e suite keeps working unchanged.
export async function mcpJson<T>(response: APIResponse): Promise<T> {
  return parseMcpResponseBody<T>(response)
}

async function parseMcpResponseBody<T>(response: APIResponse): Promise<T> {
  const contentType = response.headers()['content-type'] ?? ''
  const text = await response.text()
  if (!contentType.includes('text/event-stream')) return JSON.parse(text) as T
  const dataLines = text.split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trim())
  if (dataLines.length === 0) throw new Error(`SSE response carried no data: line(s): ${text.slice(0, 200)}`)
  return JSON.parse(dataLines.join('')) as T
}

function withMcpJson(response: APIResponse): APIResponse {
  return new Proxy(response, {
    get(target, prop, receiver) {
      if (prop === 'json') return () => parseMcpResponseBody(target)
      return Reflect.get(target, prop, receiver)
    },
  })
}

export const MCP_VERSION = '2025-06-18'
// Ember & Slice, the demo organization the production snapshot carries with the
// Commerce plan active. Every MCP spec drives this tenant and its loc-demo
// location; a spec never provisions an organization or location of its own.
export const MCP_ORGANIZATION_ID = E2E_DEMO_ORGANIZATION_ID

export async function mcpRequest(
  request: APIRequestContext,
  baseURL: string,
  options: {
    method: 'initialize' | 'notifications/initialized' | 'server/discover' | 'tools/list' | 'tools/call' | 'resources/list' | 'resources/read' | 'bad/method'
    id?: string | number
    organizationId?: string
    toolName?: string
    args?: Record<string, unknown>
    extraHeaders?: Record<string, string>
    params?: Record<string, unknown>
    idempotent?: boolean
  },
) {
  // Plain, standard JSON-RPC 2.0 — no `_meta['io.modelcontextprotocol/...']`
  // claim and no `mcp-protocol-version`/`mcp-method`/`mcp-name` headers.
  // Those were the old hand-rolled protocol layer's header/meta fallback for
  // resolving method/tool name; @modelcontextprotocol/server reads `method`
  // and `params.name`/`params.arguments` from the body per spec, and treats
  // any `_meta['io.modelcontextprotocol/...']` key as a modern-protocol
  // envelope claim — which this legacy-era (2025-06-18) suite doesn't carry
  // the rest of (e.g. `clientCapabilities`), so every request was rejected
  // as a malformed modern envelope regardless of method.
  // A JSON-RPC notification (notifications/initialized) must carry no `id`
  // at all — that's the spec's own distinction between a notification (no
  // response expected, 202 Accepted) and a request (a real result). This
  // helper used to attach an id unconditionally, silently turning that
  // notification into a request the SDK correctly answers as one (200 with
  // a result) instead of 202.
  const isNotification = options.method.startsWith('notifications/')
  const payload = {
    jsonrpc: '2.0',
    ...(isNotification ? {} : { id: options.id ?? `${options.method}-${Date.now()}` }),
    method: options.method,
    params: options.params ?? (options.method === 'tools/call'
      ? { name: options.toolName, arguments: options.args ?? {} }
      : {}),
  }

  const requestId = randomUUID()
  const startedAt = Date.now()
  const diagnostic = { requestId, method: options.method, tool: options.toolName ?? null }
  console.info('[e2e-mcp]', JSON.stringify({ event: 'started', ...diagnostic }))
  try {
    const response = await request.post(`${baseURL}/api/mcp`, {
      maxRetries: options.idempotent ? 1 : 0,
      headers: {
        'content-type': 'application/json',
        // The Streamable HTTP transport requires clients to declare both
        // response formats they accept; @modelcontextprotocol/server answers
        // 406 without this (the old hand-rolled route never checked Accept).
        accept: 'application/json, text/event-stream',
        // organization_id is a KrabiClaw extension for tenant-scoped
        // tools/list discovery, not part of the MCP spec's
        // ListToolsRequestParams — the SDK validates that against the spec's
        // schema (only cursor/_meta) and silently drops anything else, so it
        // has to travel as a header instead of a JSON-RPC param.
        ...(options.organizationId ? { 'x-krabiclaw-organization-id': options.organizationId } : {}),
        ...(options.extraHeaders ?? {}),
        'x-request-id': requestId,
      },
      data: payload,
    })
    const headers = response.headers()
    console.info('[e2e-mcp]', JSON.stringify({
      event: 'finished', ...diagnostic, durationMs: Date.now() - startedAt,
      status: response.status(), rayId: headers['cf-ray'] ?? null,
      serverRequestId: headers['x-request-id'] ?? null,
      d1Statements: headers['x-d1-query-count'] ?? null,
      d1Batches: headers['x-d1-batch-count'] ?? null,
      d1DurationMs: headers['x-d1-duration-ms'] ?? null,
      serverDurationMs: headers['x-total-duration-ms'] ?? null,
    }))
    return withMcpJson(response)
  } catch (error) {
    // Playwright puts the full request, cookies included, in the error's call log.
    // The first line is only the failure kind, e.g. "apiRequestContext.post: read ECONNRESET".
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
    console.error('[e2e-mcp]', JSON.stringify({ event: 'transport_failed', ...diagnostic, reason, durationMs: Date.now() - startedAt }))
    // The original error is deliberately not attached as `cause`: its call log carries the cookies.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`MCP transport failed: ${options.method} ${options.toolName ?? ''}; ${reason}; requestId=${requestId}`)
  }
}

// Extracts typed data from a tools/call result and preserves protocol/tool
// failures as test failures with the server's error text.
export function mcpData<T>(body: { error?: unknown; result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown } }): T {
  if (body.error) {
    throw new Error(`MCP request failed: ${JSON.stringify(body.error)}`)
  }
  if (body.result?.isError) {
    const message = body.result.content
      ?.map(item => item.text)
      .filter((text): text is string => typeof text === 'string' && text.length > 0)
      .join('\n')
    throw new Error(`MCP tool call failed: ${message || 'unknown error'}`)
  }
  if (body.result?.structuredContent && typeof body.result.structuredContent === 'object') {
    return body.result.structuredContent as T
  }
  throw new Error('MCP tool response contained no result.structuredContent')
}

export async function loginAsFreshMcpUser(request: APIRequestContext, baseURL: string, label: string) {
  const userId = `user-e2e-mcp-fresh-${label}`
  await loginAs(request, baseURL, userId)
  return userId
}

type MemberSchedulingRecord = {
  timezone: string | null
  weekly: Array<{ weekday: number; start: string; end: string }> | null
  time_off: Array<{ start: string; end: string }> | null
  updated_at: string
}
type MemberPublicProfile = {
  public_name: string | null
  public_photo_url: string | null
  public_bio: string | null
  public_approved: number
  updated_at: string
}

/**
 * A bookable offering or a stay is published only with a host whose profile
 * guests can see. This publishes the signed-in member's own profile through
 * update_member_public_profile, keeping their hours, and returns that member with the
 * restore of the profile it replaced. Unknown Hours remain unknown.
 */
export async function publishOwnHostProfile(request: APIRequestContext, baseURL: string, organizationId: string, publicName: string) {
  const call = async <T>(toolName: string, args: Record<string, unknown>) => {
    const response = await mcpRequest(request, baseURL, { method: 'tools/call', toolName, args: { organization_id: organizationId, ...args } })
    expect(response.status(), await response.text()).toBe(200)
    return mcpData<T>(await response.json())
  }
  const { members } = await call<{ members: Array<{ id: string; self: boolean; scheduling: MemberSchedulingRecord | null }> }>('get_member_scheduling', {})
  const self = members.find(member => member.self)
  expect(self, 'the signed-in user is a member of the organization').toBeTruthy()
  const memberId = self!.id
  const previousScheduling = self!.scheduling
  const { profile: previous } = await call<{ profile: MemberPublicProfile | null }>('get_member_public_profile', { member_id: memberId })
  const published = await call<{ profile: MemberPublicProfile }>('update_member_public_profile', {
    member_id: memberId, expected_updated_at: previous?.updated_at ?? null,
    public_name: publicName, public_photo_url: previous?.public_photo_url ?? null, public_bio: previous?.public_bio ?? null, public_approved: true,
  })
  expect(published.profile).toMatchObject({ public_name: publicName, public_approved: 1 })
  const restore = async () => {
    const profile = { public_name: previous?.public_name ?? null, public_photo_url: previous?.public_photo_url ?? null, public_bio: previous?.public_bio ?? null }
    const { profile: current } = await call<{ profile: MemberPublicProfile }>('get_member_public_profile', { member_id: memberId })
    await call('update_member_public_profile', { member_id: memberId, expected_updated_at: current.updated_at, ...profile, public_approved: Boolean(previous?.public_approved) })
    const { profile: restored } = await call<{ profile: MemberPublicProfile }>('get_member_public_profile', { member_id: memberId })
    expect(restored).toMatchObject({ ...profile, public_approved: previous?.public_approved ?? 0 })
    const { scheduling } = await call<{ scheduling: MemberSchedulingRecord }>('get_member_scheduling', { member_id: memberId })
    expect(scheduling).toMatchObject(previousScheduling ? Object.fromEntries(Object.entries(previousScheduling).filter(([key]) => key !== 'updated_at')) : { timezone: null, weekly: null, time_off: null })
  }
  return { memberId, restore }
}
