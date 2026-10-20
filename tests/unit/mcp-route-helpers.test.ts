import assert from 'node:assert/strict'
import test from 'node:test'
import { mcpToolErrorResult } from '../../server/utils/mcp-route-helpers.ts'
import { asMcpError } from '../../server/utils/mcp-protocol.ts'

test('a tool action carries its dashboard destination without unrelated private details', () => {
  const result = mcpToolErrorResult('A paid plan is required.', {
    code: 'LANGUAGE_ENTITLEMENT_REQUIRED', dashboard_url: '/dashboard/kanpai/payments?tab=plan',
    credential: 'private-value', customer_email: 'private@example.com',
  }, 'https://krabiclaw.com')
  assert.equal(result.isError, true)
  assert.equal('structuredContent' in result, false)
  assert.deepEqual(JSON.parse(result.content[0]!.text), {
    code: 'LANGUAGE_ENTITLEMENT_REQUIRED', message: 'A paid plan is required.',
    dashboard_url: 'https://krabiclaw.com/dashboard/kanpai/payments?tab=plan',
  })
  assert.equal(JSON.stringify(result).includes('private'), false)
})

test('a rejected tool cannot supply an external or escaped dashboard destination', () => {
  for (const dashboard_url of ['https://example.com/dashboard/kanpai', '//example.com/dashboard/kanpai', '/dashboard/../api/auth', '/dashboard/%2e%2e/api/auth']) {
    const result = mcpToolErrorResult('Blocked', { code: 'PLAN_REQUIRED', dashboard_url }, 'https://krabiclaw.com')
    assert.deepEqual(JSON.parse(result.content[0]!.text), { code: 'PLAN_REQUIRED', message: 'Blocked', dashboard_url_error: 'invalid_destination' })
  }
})

test('a missing resource reaches the model as a 404 tool failure', () => {
  const error = Object.assign(new Error('Reservation policy not found'), { statusCode: 404, data: { code: 'RESERVATION_POLICY_NOT_FOUND' } })
  const mapped = asMcpError(error)
  const result = mcpToolErrorResult(mapped.message, mapped.data)
  assert.equal(result.isError, true)
  assert.equal('structuredContent' in result, false)
  assert.deepEqual(JSON.parse(result.content[0]!.text), { status: 404, code: 'RESERVATION_POLICY_NOT_FOUND', message: 'Reservation policy not found' })
})

test('incomplete setup names the fields needed for recovery', () => {
  const result = mcpToolErrorResult('Reservation setup is incomplete', {
    status: 409, code: 'RESERVATION_SETUP_INCOMPLETE', missing: ['duration_minutes'], customer_email: 'private@example.com',
  })
  assert.deepEqual(JSON.parse(result.content[0]!.text), { status: 409, code: 'RESERVATION_SETUP_INCOMPLETE', message: 'Reservation setup is incomplete', missing: ['duration_minutes'] })
  assert.equal(JSON.stringify(result).includes('private'), false)
})
