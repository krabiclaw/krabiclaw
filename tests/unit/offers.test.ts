import { test } from 'node:test'
import assert from 'node:assert/strict'
import { offer, planOffers } from '../../shared/offers.ts'
import { getPlanEntitlements } from '../../server/utils/billing-entitlements.ts'

test('a plan is offered only what it lacks, most valuable first', () => {
  assert.deepEqual(planOffers(getPlanEntitlements('business')), [])
  assert.deepEqual(planOffers(getPlanEntitlements('growth')).map(item => item.id), ['calendar_sync', 'airbnb_sync', 'google_ads', 'payments'])
  assert.equal(planOffers(getPlanEntitlements('free'))[0]!.id, 'calendar_sync')
  assert.throws(() => offer('unknown' as never), /Unknown offer/)
})

