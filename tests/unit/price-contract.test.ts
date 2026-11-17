import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AmbiguousPriceError,
  assertNoConflictingPrices,
  assertPriceShape,
  selectPrice,
  type Price,
} from '../../shared/prices.ts'

const base: Omit<Price, 'id'> = {
  organization_id: 'org1', product_variant_id: 'v1', location_id: null, active: true,
  currency: 'THB', unit_amount: 25000, type: 'one_time', recurring_interval: null,
  recurring_interval_count: null, tax_behavior: 'unspecified', compare_at_unit_amount: null,
  valid_from_at: null, valid_until_at: null, source: 'manual', created_by: 'u', updated_by: 'u',
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
}
const p = (id: string, over: Partial<Price> = {}): Price => ({ ...base, id, ...over })
const AT = '2026-06-01T00:00:00.000Z'

test('no applicable offer returns null, never a substitute', () => {
  assert.equal(selectPrice([], { currency: 'THB', location_id: null, at: AT }), null)
  assert.equal(selectPrice([p('free', { unit_amount: 0 })], { currency: 'THB', location_id: null, at: AT })!.unit_amount, 0, 'zero is an explicit offer')
  assert.equal(selectPrice([p('a')], { currency: 'USD', location_id: null, at: AT }), null, 'must not fall back to another currency')
  assert.equal(selectPrice([p('a', { active: false })], { currency: 'THB', location_id: null, at: AT }), null)
  assert.equal(selectPrice([p('a', { valid_until_at: '2026-05-01T00:00:00.000Z' })], { currency: 'THB', location_id: null, at: AT }), null, 'must not use a lapsed offer')
  assert.equal(selectPrice([p('a', { valid_from_at: '2026-07-01T00:00:00.000Z' })], { currency: 'THB', location_id: null, at: AT }), null, 'must not use a future offer')
})

test('location scope precedence: specific wins, neutral is not a second source', () => {
  const prices = [p('neutral'), p('locA', { location_id: 'locA' })]
  assert.equal(selectPrice(prices, { currency: 'THB', location_id: 'locA', at: AT })!.id, 'locA')
  assert.equal(selectPrice(prices, { currency: 'THB', location_id: 'locB', at: AT })!.id, 'neutral')
  assert.equal(selectPrice(prices, { currency: 'THB', location_id: null, at: AT })!.id, 'neutral')
  assert.equal(selectPrice([p('locA', { location_id: 'locA' })], { currency: 'THB', location_id: null, at: AT }), null,
    'no location context must not reach a location-scoped offer')
})

test('ambiguity throws instead of ordering and picking', () => {
  assert.throws(() => selectPrice([p('a'), p('b')], { currency: 'THB', location_id: null, at: AT }), AmbiguousPriceError)
  assert.throws(() => selectPrice([p('a', { location_id: 'locA' }), p('b', { location_id: 'locA' })], { currency: 'THB', location_id: 'locA', at: AT }), AmbiguousPriceError)
})

test('billing recurrence is never confused with anything else', () => {
  const weekly = p('w', { type: 'recurring', recurring_interval: 'week', recurring_interval_count: 1 })
  const once = p('o')
  assert.equal(selectPrice([weekly, once], { currency: 'THB', location_id: null, at: AT })!.id, 'o', 'default asks for one-time')
  assert.equal(selectPrice([weekly, once], { currency: 'THB', location_id: null, at: AT, billing: { type: 'recurring', interval: 'week', interval_count: 1 } })!.id, 'w')
  assert.equal(selectPrice([weekly], { currency: 'THB', location_id: null, at: AT, billing: { type: 'recurring', interval: 'month', interval_count: 1 } }), null)
})

test('shape validation rejects malformed offers', () => {
  assert.throws(() => assertPriceShape(p('x', { unit_amount: -1 })), /non-negative/)
  assert.throws(() => assertPriceShape(p('x', { currency: 'thb' as Price['currency'] })), /ISO 4217/)
  assert.throws(() => assertPriceShape(p('x', { compare_at_unit_amount: 100 })), /must exceed/)
  assert.throws(() => assertPriceShape(p('x', { type: 'recurring' })), /recurring price requires/)
  assert.throws(() => assertPriceShape(p('x', { recurring_interval: 'week', recurring_interval_count: 1 })), /must not carry recurrence/)
  assert.throws(() => assertPriceShape(p('x', { valid_from_at: '2026-02-01T00:00:00.000Z', valid_until_at: '2026-01-01T00:00:00.000Z' })), /positive/)
})

test('write-time conflict guard', () => {
  assert.throws(() => assertNoConflictingPrices([p('a'), p('b')]), AmbiguousPriceError)
  assertNoConflictingPrices([p('a', { valid_until_at: '2026-06-01T00:00:00.000Z' }), p('b', { valid_from_at: '2026-06-01T00:00:00.000Z' })])
  assertNoConflictingPrices([p('a'), p('b', { location_id: 'locA' })])
  assertNoConflictingPrices([p('a'), p('b', { currency: 'USD' })])
  assertNoConflictingPrices([p('a'), p('b', { active: false })])
  assert.throws(() => assertNoConflictingPrices([p('a', { valid_until_at: '2026-07-01T00:00:00.000Z' }), p('b', { valid_from_at: '2026-06-01T00:00:00.000Z' })]), AmbiguousPriceError)
})
