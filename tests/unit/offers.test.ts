import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { OFFERS, offer, planOffers } from '../../shared/offers.ts'
import { INTEGRATIONS } from '../../shared/integrations.ts'
import { BUSINESS_ADDITIONS, SERVICES } from '../../shared/billing-model.ts'
import { getPlanEntitlements } from '../../server/utils/billing-entitlements.ts'

test('every offer names a real capability or service, a picture on disk and three steps', () => {
  const capabilities = getPlanEntitlements('free')
  for (const item of OFFERS) {
    if ('entitlement' in item.unlock) {
      assert.ok(item.unlock.entitlement in capabilities, `${item.id} names capability ${item.unlock.entitlement}, which the plan policy does not define`)
      assert.equal(getPlanEntitlements(item.unlock.plan)[item.unlock.entitlement], true, `${item.id} is offered with ${item.unlock.plan}, which does not include it`)
    } else {
      assert.ok(item.unlock.service in SERVICES, `${item.id} names service ${item.unlock.service}`)
    }
    assert.ok(existsSync(join('public', item.illustration)), `${item.id} illustration ${item.illustration} is missing`)
    assert.equal(item.steps.length, 3, `${item.id} explains itself in three steps`)
    assert.ok(item.line.length <= 160, `${item.id} line is one sentence`)
  }
})

test('a plan is offered only what it lacks, most valuable first', () => {
  assert.deepEqual(planOffers(getPlanEntitlements('business')), [])
  assert.deepEqual(planOffers(getPlanEntitlements('growth')).map(item => item.id), ['calendar_sync', 'airbnb_sync', 'google_ads', 'payments'])
  assert.equal(planOffers(getPlanEntitlements('free'))[0]!.id, 'calendar_sync')
  assert.throws(() => offer('unknown' as never), /Unknown offer/)
})

test('the Business additions, the connections and the comparison agree on what Business adds', () => {
  for (const addition of BUSINESS_ADDITIONS) assert.ok(OFFERS.some(item => item.id === addition.id.replace('-', '_')), `${addition.id} has no offer to illustrate it`)
  for (const key of ['google-calendar', 'airbnb'] as const) {
    const connection = INTEGRATIONS.find(item => item.key === key)!
    assert.equal(connection.group, 'sync')
    assert.equal(getPlanEntitlements('growth')[connection.entitlement!], false, `${key} is Business only`)
    assert.equal(getPlanEntitlements('business')[connection.entitlement!], true)
  }
})
