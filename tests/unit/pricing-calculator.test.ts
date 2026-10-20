import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calculateSlidingScaleRate, parsePricingAmount } from '../../utils/pricing-calculator.ts'

const rows = [['1', '$39,900', '$55,860', '$63,840']]

test('Blawby pricing parser handles formatted imported amounts', () => {
  assert.equal(parsePricingAmount('$55,860'), 55860)
  assert.equal(parsePricingAmount('bad'), 0)
})

test('Blawby pricing calculator applies inclusive imported thresholds', () => {
  assert.deepEqual(calculateSlidingScaleRate({ householdSize: 1, income: 39900, period: 'annual', rows }), { percentage: 50, rate: 160, standardRate: 320 })
  assert.equal(calculateSlidingScaleRate({ householdSize: 1, income: 39901, period: 'annual', rows }).rate, 215)
  assert.equal(calculateSlidingScaleRate({ householdSize: 1, income: 55860, period: 'annual', rows }).rate, 215)
  assert.equal(calculateSlidingScaleRate({ householdSize: 1, income: 63840, period: 'annual', rows }).rate, 240)
  assert.equal(calculateSlidingScaleRate({ householdSize: 1, income: 63841, period: 'annual', rows }).rate, 320)
})

test('Blawby pricing calculator normalizes monthly income to annual', () => {
  assert.equal(calculateSlidingScaleRate({ householdSize: 1, income: 3325, period: 'monthly', rows }).rate, 160)
  assert.equal(calculateSlidingScaleRate({ householdSize: 1, income: 6000, period: 'monthly', rows }).rate, 320)
})
