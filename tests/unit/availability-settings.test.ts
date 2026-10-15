import assert from 'node:assert/strict'
import test from 'node:test'
import { cancellationPatch, cancellationSummary, cancellationTierOf, hoursSummary, noticeSummary, seatsSummary } from '../../shared/availability-settings.ts'

test('a named cancellation policy is its two cutoffs, and only those cutoffs read back as it', () => {
  for (const tier of ['flexible', 'moderate', 'firm'] as const) {
    assert.equal(cancellationTierOf(cancellationPatch(tier)), tier)
  }
  assert.deepEqual(cancellationPatch('firm'), { free_cancellation_until_minutes: 2880, reschedule_allowed: true, reschedule_cutoff_minutes: 2880 })
  // Cutoffs no tier names are said as they are, never rounded to a tier.
  assert.equal(cancellationTierOf({ free_cancellation_until_minutes: 1440, reschedule_allowed: true, reschedule_cutoff_minutes: 240 }), null)
  assert.equal(cancellationTierOf({ free_cancellation_until_minutes: 1440, reschedule_allowed: false, reschedule_cutoff_minutes: 1440 }), null)
  assert.equal(cancellationSummary({ free_cancellation_until_minutes: 180, reschedule_allowed: true, reschedule_cutoff_minutes: 180 }), 'Custom · free until 3 hours before')
  assert.equal(cancellationSummary({ free_cancellation_until_minutes: null }), 'No deadline')
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
