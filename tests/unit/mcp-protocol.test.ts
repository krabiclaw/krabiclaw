import assert from 'node:assert/strict'
import test from 'node:test'

import {
  asMcpError,
  MCP_ERROR,
  mcpProtocolError,
} from '../../server/utils/mcp-protocol.ts'
import {
  objectArray,
  objectRecord,
  requiredBoolean,
  requiredString,
  requiredStringArray,
} from '../../server/utils/mcp-tools/execution.ts'

// JSON-RPC envelope parsing, protocol-version negotiation, and JSON-RPC
// argument-shape validation moved to @modelcontextprotocol/server (see
// server/api/mcp.ts) — that coverage now lives in the e2e suite
// (tests/e2e/mcp-*.spec.ts, tests/e2e/oauth-discovery.spec.ts) against the
// real SDK behavior rather than as unit tests of hand-rolled parsing here.
// asMcpError/mcpProtocolError remain ours: every tool executor throws
// through this shape regardless of transport.

test('asMcpError maps an h3 createError with statusCode 404 to invalidParams so tools/call can return isError:true', () => {
  const h3Error = Object.assign(new Error('Not found'), { statusCode: 404, statusMessage: 'Experience not found' })
  const mapped = asMcpError(h3Error)
  assert.equal(mapped.code, MCP_ERROR.invalidParams)
  assert.equal(mapped.message, 'Experience not found')
  assert.equal(mapped.kind, 'tool_execution')
  assert.deepEqual(mapped.data, { status: 404 })
  const badRequest = asMcpError(Object.assign(new Error('H3Error'), { statusCode: 400, statusMessage: 'location_id is required' }))
  assert.equal(badRequest.code, MCP_ERROR.invalidParams)
  assert.equal(badRequest.message, 'location_id is required')
})

test('asMcpError falls back to internal for a plain Error', () => {
  const mapped = asMcpError(new Error('boom'))
  assert.equal(mapped.code, MCP_ERROR.internal)
  assert.equal(mapped.message, 'boom')
  const protocolError = mcpProtocolError(MCP_ERROR.invalidParams, 'bad input')
  assert.deepEqual(asMcpError(protocolError), { code: MCP_ERROR.invalidParams, message: 'bad input', data: undefined, kind: 'tool_execution' })
})

test('domain failures preserve actions and recovery receipts without private details', () => {
  const error = Object.assign(new Error('This website language is not published.'), { statusCode: 409, data: {
    code: 'LANGUAGE_NOT_PUBLISHED', dashboard_url: '/dashboard/kanpai/website/preferences/localization',
    credential: 'private-value', customer_email: 'private@example.com',
  } })
  const mapped = asMcpError(error)
  assert.equal(mapped.kind, 'tool_execution')
  assert.deepEqual(mapped.data, { status: 409, code: 'LANGUAGE_NOT_PUBLISHED', dashboard_url: '/dashboard/kanpai/website/preferences/localization' })

  const reason = 'Channex rejected part of the update.'
  const details: Record<string, unknown> = {
    code: 'CHANNEL_PUSH_FAILED', field: 'channel_push', committed: true, product_id: 'home-1', booking_id: 'stay-1', version: 3,
    updated_at: '2030-01-01T00:00:00.000Z', reason,
    ranges: [{ from: '2030-01-01', to: '2030-01-03', provider_payload: 'private-value' }],
    channel_push: { state: 'needs_review', detail: reason, provider_payload: { credential: 'private-value' } },
    credential: 'private-value', customer_email: 'private@example.com', cause: { provider_token: 'private-value' },
  }
  const channelError = Object.assign(new Error(reason), { statusCode: 503, data: details })
  assert.equal(asMcpError(channelError).kind, 'transport')
  const recovery = {
    status: 503, code: 'CHANNEL_PUSH_FAILED', field: 'channel_push', committed: true, product_id: 'home-1', booking_id: 'stay-1', version: 3,
    updated_at: '2030-01-01T00:00:00.000Z', reason, ranges: [{ from: '2030-01-01', to: '2030-01-03' }],
    channel_push: { state: 'needs_review', detail: reason },
  }
  assert.deepEqual(asMcpError(channelError).data, recovery)
  details.code = 'POST_WRITE_COMPLETION_FAILED'
  details.channel_push = { state: 'pushed', detail: null }
  assert.deepEqual(asMcpError(channelError).data, { ...recovery, code: 'POST_WRITE_COMPLETION_FAILED', channel_push: { state: 'pushed', detail: null } })

  details.code = 'CHANNEL_PUSH_FAILED'
  details.ranges = [{ from: 'private@example.com', to: '2030-01-03' }]
  details.channel_push = { state: 'needs_review', detail: '' }
  details.booking_id = 'private@example.com'
  details.version = -1
  details.updated_at = 'private@example.com'
  details.channel_outcome = 'unknown'
  assert.deepEqual(asMcpError(channelError).data, {
    status: 503, code: 'CHANNEL_PUSH_FAILED', field: 'channel_push', committed: true, product_id: 'home-1', reason, channel_outcome: 'unknown',
  })
  details.committed = 'yes'
  assert.deepEqual(asMcpError(channelError).data, { status: 503, code: 'CHANNEL_PUSH_FAILED', product_id: 'home-1' })

  const setup = Object.assign(new Error('Reservation setup is incomplete'), { statusCode: 409, data: {
    code: 'RESERVATION_SETUP_INCOMPLETE', missing: ['duration_minutes', 'location.timezone'],
    customer_email: 'private@example.com',
  } })
  assert.deepEqual(asMcpError(setup).data, {
    status: 409, code: 'RESERVATION_SETUP_INCOMPLETE', missing: ['duration_minutes', 'location.timezone'],
  })
  setup.data.missing = ['private@example.com']
  assert.deepEqual(asMcpError(setup).data, { status: 409, code: 'RESERVATION_SETUP_INCOMPLETE' })
})

test('asMcpError maps statusCode 403 to forbidden rather than auth', () => {
  const forbidden = Object.assign(new Error('Forbidden'), { statusCode: 403 })
  const mapped = asMcpError(forbidden)
  assert.equal(mapped.kind, 'forbidden')
  assert.equal(mapped.code, MCP_ERROR.internal)
})

test('execution validation helpers throw structured mcpProtocolError with field and expected', () => {
  assert.throws(
    () => requiredString({}, 'organization_id'),
    (err: unknown) => {
      const mcp = (err as { mcp: { code: number; message: string; data: unknown } }).mcp
      assert.equal(mcp.code, MCP_ERROR.invalidParams)
      assert.match(mcp.message, /Invalid organization_id: a non-empty string is required/)
      assert.deepEqual(mcp.data, { field: 'organization_id', expected: 'non-empty string' })
      return true
    },
  )

  assert.throws(
    () => requiredBoolean({ active: 'yes' }, 'active'),
    (err: unknown) => {
      const mcp = (err as { mcp: { code: number; message: string; data: unknown } }).mcp
      assert.equal(mcp.code, MCP_ERROR.invalidParams)
      assert.match(mcp.message, /Invalid active: a boolean \(true or false\) is required/)
      assert.deepEqual(mcp.data, { field: 'active', expected: 'boolean' })
      return true
    },
  )

  assert.throws(
    () => requiredStringArray(['valid', ''], 'tags'),
    (err: unknown) => {
      const mcp = (err as { mcp: { code: number; message: string; data: unknown } }).mcp
      assert.equal(mcp.code, MCP_ERROR.invalidParams)
      assert.match(mcp.message, /Invalid tags: an array of non-empty strings is required/)
      assert.deepEqual(mcp.data, { field: 'tags', expected: 'string[]' })
      return true
    },
  )

  assert.throws(
    () => objectRecord('not-an-object', 'payload'),
    (err: unknown) => {
      const mcp = (err as { mcp: { code: number; message: string; data: unknown } }).mcp
      assert.equal(mcp.code, MCP_ERROR.invalidParams)
      assert.match(mcp.message, /Invalid payload: an object is required/)
      assert.deepEqual(mcp.data, { field: 'payload', expected: 'object' })
      return true
    },
  )

  assert.throws(
    () => objectArray([{ ok: true }, 'invalid'], 'items'),
    (err: unknown) => {
      const mcp = (err as { mcp: { code: number; message: string; data: unknown } }).mcp
      assert.equal(mcp.code, MCP_ERROR.invalidParams)
      assert.match(mcp.message, /Invalid items: each element must be an object/)
      assert.deepEqual(mcp.data, { field: 'items', expected: 'object[]' })
      return true
    },
  )
})
