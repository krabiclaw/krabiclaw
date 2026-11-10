import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatMetaAdAccountId,
  rawMetaAdAccountId,
  listMetaAdAccounts,
  getMetaAdAccount,
  getMetaAdsPerformanceSummary,
  getMetaCampaignAccountId,
  createMetaAdsCampaign,
  updateMetaAdsCampaign,
} from '../../server/utils/meta-ads'

test('formatMetaAdAccountId ensures act_ prefix and rawMetaAdAccountId strips it', () => {
  assert.equal(formatMetaAdAccountId('123456789'), 'act_123456789')
  assert.equal(formatMetaAdAccountId('act_123456789'), 'act_123456789')
  assert.equal(rawMetaAdAccountId('act_123456789'), '123456789')
  assert.equal(rawMetaAdAccountId('123456789'), '123456789')
})

test('listMetaAdAccounts and getMetaAdAccount map accounts and detect inactive statuses', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes('/me/adaccounts')) {
      return new Response(JSON.stringify({
        data: [
          { id: 'act_101', account_id: '101', name: 'Active Account', currency: 'USD', timezone_name: 'America/New_York', account_status: 1 },
          { id: 'act_102', account_id: '102', name: 'Disabled Account', currency: 'EUR', timezone_name: 'Europe/Paris', account_status: 2 },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/act_101')) {
      return new Response(JSON.stringify({
        id: 'act_101',
        account_id: '101',
        name: 'Active Account',
        currency: 'USD',
        timezone_name: 'America/New_York',
        account_status: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`Unexpected fetch to ${url}`)
  }

  try {
    const accounts = await listMetaAdAccounts('test-token')
    assert.equal(accounts.length, 2)
    assert.equal(accounts[0]!.accountId, '101')
    assert.equal(accounts[0]!.notEnabled, false)
    assert.equal(accounts[1]!.accountId, '102')
    assert.equal(accounts[1]!.notEnabled, true)

    const single = await getMetaAdAccount('test-token', '101')
    assert.equal(single?.accountId, '101')
    assert.equal(single?.currency, 'USD')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('getMetaAdsPerformanceSummary aggregates spend into cents and calculates conversions', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    assert.match(String(input), /\/act_101\/insights/)
    return new Response(JSON.stringify({
      data: [
        {
          spend: '125.50',
          impressions: '10000',
          reach: '8500',
          clicks: '420',
          account_currency: 'EUR',
          actions: [
            // When both omni_purchase and purchase are returned, omni_purchase takes priority without double counting
            { action_type: 'omni_purchase', value: '5' },
            { action_type: 'purchase', value: '5' },
            { action_type: 'omni_schedule', value: '3' },
            { action_type: 'post_engagement', value: '50' },
          ],
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  try {
    const summary = await getMetaAdsPerformanceSummary('test-token', '101', '2026-10-01', '2026-10-07')
    assert.equal(summary.costCents, 12550)
    assert.equal(summary.impressions, 10000)
    assert.equal(summary.reach, 8500)
    assert.equal(summary.clicks, 420)
    assert.equal(summary.currency, 'EUR')
    // 5 purchases (deduplicated) + 3 schedules = 8 conversions (post_engagement is excluded)
    assert.equal(summary.conversions, 8)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('createMetaAdsCampaign and updateMetaAdsCampaign send correct payloads', async () => {
  const originalFetch = globalThis.fetch
  let createCalled = false
  let updateCalled = false

  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('/act_101/campaigns')) {
      createCalled = true
      const body = String(init?.body ?? '')
      assert.match(body, /status=PAUSED/)
      assert.match(body, /name=Summer\+Promo/)
      assert.match(body, /daily_budget=1500/)
      assert.match(body, /objective=OUTCOME_TRAFFIC/)
      return new Response(JSON.stringify({ id: 'camp_999' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/camp_999') && init?.method === 'POST') {
      updateCalled = true
      const body = String(init?.body ?? '')
      assert.match(body, /status=ACTIVE/)
      assert.match(body, /daily_budget=2000/)
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/camp_999?fields=account_id')) {
      return new Response(JSON.stringify({ id: 'camp_999', account_id: '101' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`Unexpected fetch to ${url}`)
  }

  try {
    const created = await createMetaAdsCampaign('test-token', '101', { name: 'Summer Promo', dailyBudgetCents: 1500 })
    assert.equal(created.id, 'camp_999')
    assert.equal(createCalled, true)

    const ownerAccountId = await getMetaCampaignAccountId('test-token', 'camp_999')
    assert.equal(ownerAccountId, '101')

    const updated = await updateMetaAdsCampaign('test-token', 'camp_999', { status: 'ACTIVE', dailyBudgetCents: 2000 })
    assert.equal(updated.success, true)
    assert.equal(updateCalled, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})
