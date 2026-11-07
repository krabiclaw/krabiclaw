import assert from 'node:assert/strict'
import test from 'node:test'
import { freeCancellationUntil, hoursSummary, noticeSummary, seatsSummary } from '../../shared/availability-settings.ts'

test('free cancellation closes exactly 24 hours before the start', () => {
  assert.equal(freeCancellationUntil('2099-10-02T13:00:00.000Z'), '2099-10-01T13:00:00.000Z')
})

test('settings cards state their values in one line', () => {
  assert.equal(noticeSummary(null), 'No notice needed')
  assert.equal(noticeSummary(1440), 'At least 1 day')
  assert.equal(noticeSummary(90), 'At least 90 minutes')
  assert.equal(seatsSummary(null), 'No limit')
  assert.equal(seatsSummary(12), '12 per time slot')
  const weekdays = { periods: [1, 2, 3, 4, 5, 6].map(day => ({ open: { day, hour: 12, minute: 0 }, close: { day, hour: 22, minute: 0 } })) }
  assert.equal(hoursSummary(weekdays), 'Open 6 days · Closed Sun')
  assert.equal(hoursSummary(null), 'Not set')
  assert.equal(hoursSummary({ periods: [] }), 'Closed every day')
})
