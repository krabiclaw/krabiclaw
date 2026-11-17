import assert from 'node:assert/strict'
import test from 'node:test'
import { freeCancellationNoticeMinutes, freeCancellationUntil, noticeDuration, outsideNotice } from '../../shared/availability-settings.ts'

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

