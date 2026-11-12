import assert from 'node:assert/strict'
import test from 'node:test'
import { freeCancellationNoticeMinutes, freeCancellationUntil, hoursSummary, noticeDuration, noticeSummary, outsideNotice, seatsSummary } from '../../shared/availability-settings.ts'

test('free cancellation closes exactly 24 hours before the start, or at a longer advance notice', () => {
  assert.equal(freeCancellationUntil('2099-10-02T13:00:00.000Z', null), '2099-10-01T13:00:00.000Z')
  assert.equal(freeCancellationUntil('2099-10-02T13:00:00.000Z', 120), '2099-10-01T13:00:00.000Z')
  assert.equal(freeCancellationUntil('2099-10-03T13:00:00.000Z', 2880), '2099-10-01T13:00:00.000Z')
  assert.deepEqual([null, 0, 120, 1440, 2880, 10080].map(minutes => freeCancellationNoticeMinutes(minutes)), [1440, 1440, 1440, 1440, 2880, 10080])
})

test('a start inside the advance notice is closed; one exactly at its edge is too', () => {
  const now = Date.parse('2099-10-01T13:00:00.000Z')
  assert.equal(outsideNotice('2099-10-03T13:00:00.000Z', 2880, now), false)
  assert.equal(outsideNotice('2099-10-03T13:00:00.001Z', 2880, now), true)
  assert.equal(outsideNotice('2099-10-01T13:00:00.001Z', null, now), true)
  assert.equal(outsideNotice('2099-10-01T13:00:00.000Z', null, now), false)
})

test('the notice reads in the guest\'s language, with one day as 24 hours', () => {
  assert.deepEqual([1440, 2880, 120, 10080].map(minutes => noticeDuration(minutes, 'en')), ['24 hours', '2 days', '2 hours', '7 days'])
  assert.equal(noticeDuration(2880, 'vi'), '2 ngày')
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
