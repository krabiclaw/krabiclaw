import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateTelemetryInput } from '../../server/api/dashboard/telemetry.post.ts'

test('validateTelemetryInput accepts valid telemetry actions', () => {
  const actions = ['today_view', 'today_range_switch', 'today_card_click', 'today_filter_change'] as const
  for (const action of actions) {
    const valid = validateTelemetryInput({ action, surface: 'today' })
    assert.ok(valid)
    assert.equal(valid.action, action)
    assert.equal(valid.surface, 'today')
  }
})

test('validateTelemetryInput parses stringified JSON payloads from beacons', () => {
  const payload = JSON.stringify({
    action: 'today_card_click',
    surface: 'today',
    cardId: 'card-123',
    cardPriority: 'attention',
    locationId: 'loc-456',
  })
  const parsed = validateTelemetryInput(payload)
  assert.ok(parsed)
  assert.equal(parsed.action, 'today_card_click')
  assert.equal(parsed.cardId, 'card-123')
  assert.equal(parsed.cardPriority, 'attention')
  assert.equal(parsed.locationId, 'loc-456')
})

test('validateTelemetryInput rejects invalid payloads and unknown actions', () => {
  assert.equal(validateTelemetryInput(null), null)
  assert.equal(validateTelemetryInput(undefined), null)
  assert.equal(validateTelemetryInput(''), null)
  assert.equal(validateTelemetryInput('invalid-json{'), null)
  assert.equal(validateTelemetryInput(123), null)
  assert.equal(validateTelemetryInput({}), null)
  assert.equal(validateTelemetryInput({ action: 'unknown_action' }), null)
  assert.equal(validateTelemetryInput({ action: 'delete_database' }), null)
})
