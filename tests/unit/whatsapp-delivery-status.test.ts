import test from 'node:test'
import assert from 'node:assert/strict'

import { compareDeliveryStatus } from '../../server/domain/guest-threads/deliveries.ts'

// A delivery status only advances: forward through the lifecycle, failed only
// before a recorded success, and nothing after a recorded failure.
test('delivery status transitions advance only forward', () => {
  const transitions: Array<[Parameters<typeof compareDeliveryStatus>[0], Parameters<typeof compareDeliveryStatus>[1], boolean]> = [
    [null, 'accepted', true],
    [null, 'sent', true],
    [null, 'delivered', true],
    [null, 'read', true],
    [null, 'failed', true],
    ['accepted', 'sent', true],
    ['sent', 'delivered', true],
    ['delivered', 'read', true],
    ['accepted', 'read', true],
    ['accepted', 'accepted', false],
    ['sent', 'sent', false],
    ['delivered', 'delivered', false],
    ['read', 'read', false],
    ['delivered', 'sent', false],
    ['read', 'delivered', false],
    ['read', 'accepted', false],
    ['delivered', 'failed', false],
    ['read', 'failed', false],
    ['accepted', 'failed', true],
    ['sent', 'failed', true],
    ['failed', 'sent', false],
    ['failed', 'delivered', false],
    ['failed', 'read', false],
    ['failed', 'accepted', false],
    ['failed', 'failed', false],
  ]
  for (const [current, next, advances] of transitions) {
    assert.equal(compareDeliveryStatus(current, next), advances, `${current} -> ${next}`)
  }
})
