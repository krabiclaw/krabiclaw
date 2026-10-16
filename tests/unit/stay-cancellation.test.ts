import assert from 'node:assert/strict'
import test from 'node:test'
import { bookedPolicyFor, stayCancellationRefund, type StayBookedPolicy } from '../../shared/stay-cancellation.ts'

// Three nights from Fri Oct 23 at a Los Angeles home checking in at 15:00 (22:00Z), booked a month ahead.
const nightly = [{ date: '2026-10-23', price_minor: 10000 }, { date: '2026-10-24', price_minor: 10000 }, { date: '2026-10-25', price_minor: 12000 }]
const home = { nightly, timezone: 'America/Los_Angeles', check_in_time: '15:00', booked_at: '2026-09-20T12:00:00Z' }
const refund = (policy: StayBookedPolicy, now: string, extra: Partial<typeof home> = {}) => stayCancellationRefund({ ...home, ...extra, policy, now })

test('the stay length chooses the home policy, and a missing one is missing', () => {
  const policies = { cancellation_policy: 'moderate', long_term_cancellation_policy: 'strict' } as const
  assert.equal(bookedPolicyFor(27, policies), 'moderate')
  assert.equal(bookedPolicyFor(28, policies), 'long_term_strict')
  assert.equal(bookedPolicyFor(28, { ...policies, long_term_cancellation_policy: null }), null)
})

test('Flexible: full refund until a day before check-in, then the guest pays one night and the nights spent', () => {
  assert.equal(refund('flexible', '2026-10-22T22:00:00Z'), 32000)
  assert.equal(refund('flexible', '2026-10-22T22:00:01Z'), 22000)
  // Cancelled during the first night: that night and one more are paid.
  assert.equal(refund('flexible', '2026-10-24T03:00:00Z'), 12000)
})

test('Moderate: full refund until 5 days before, then one night plus half of the rest', () => {
  assert.equal(refund('moderate', '2026-10-18T22:00:00Z'), 32000)
  assert.equal(refund('moderate', '2026-10-19T00:00:00Z'), 11000)
  assert.equal(refund('moderate', '2026-10-24T03:00:00Z'), 6000)
})

test('Limited and Firm: full, then half between 7 days and the cutoff, then nothing', () => {
  assert.equal(refund('limited', '2026-10-09T22:00:00Z'), 32000)
  assert.equal(refund('limited', '2026-10-12T00:00:00Z'), 16000)
  assert.equal(refund('limited', '2026-10-17T00:00:00Z'), 0)
  assert.equal(refund('firm', '2026-09-23T22:00:00Z'), 32000)
  assert.equal(refund('firm', '2026-10-01T00:00:00Z'), 16000)
  assert.equal(refund('firm', '2026-10-24T00:00:00Z'), 0)
})

test('Strict returns half until 7 days before; every standard policy is free for 24 hours when booked 7+ days ahead', () => {
  assert.equal(refund('strict', '2026-10-01T00:00:00Z'), 16000)
  assert.equal(refund('strict', '2026-10-20T00:00:00Z'), 0)
  assert.equal(refund('strict', '2026-09-21T11:00:00Z'), 32000)
  // Booked 3 days ahead: no free window.
  assert.equal(refund('firm', '2026-10-20T13:00:00Z', { booked_at: '2026-10-20T12:00:00Z' }), 0)
})

test('Long term: free until the cutoff, then the nights spent and the next 30 are kept', () => {
  const month = Array.from({ length: 40 }, (_, day) => ({ date: new Date(Date.UTC(2026, 10, 1 + day)).toISOString().slice(0, 10), price_minor: 5000 }))
  assert.equal(refund('long_term_firm', '2026-10-01T00:00:00Z', { nightly: month }), 200000)
  assert.equal(refund('long_term_firm', '2026-10-20T00:00:00Z', { nightly: month }), 50000)
  assert.equal(refund('long_term_firm', '2026-11-06T00:00:00Z', { nightly: month }), 25000)
  assert.equal(refund('long_term_strict', '2026-09-21T11:00:00Z', { nightly: month }), 200000)
  assert.equal(refund('long_term_strict', '2026-09-23T00:00:00Z', { nightly: month }), 50000)
})
