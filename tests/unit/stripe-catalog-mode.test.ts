import assert from 'node:assert/strict'
import test from 'node:test'
import { assertCatalogModeKey, buildCatalogPlan, sha256Json } from '../../scripts/lib/stripe-catalog-plan.mjs'
import { main, parseCli } from '../../scripts/seed-stripe.mjs'

// Catalog mutation must require an explicit live target, before provider access.
test('catalog mode rejects live keys by default and mismatched explicit targets', () => {
  assert.throws(() => assertCatalogModeKey('sk_live_guard'), /test-mode key/)
  assert.throws(() => assertCatalogModeKey('sk_test_guard', 'live'), /live-mode key/)
  assert.throws(() => assertCatalogModeKey('sk_live_guard', 'test'), /test-mode key/)
  assert.throws(() => assertCatalogModeKey('invalid', 'live'), /live-mode key/)
  assert.throws(() => assertCatalogModeKey('sk_live_guard', 'unknown'), /test or live/)
  assert.doesNotThrow(() => assertCatalogModeKey('rk_live_guard', 'live'))
  assert.doesNotThrow(() => assertCatalogModeKey('rk_test_guard'))
})

test('catalog CLI rejects conflicting account targets and planning scopes', () => {
  assert.throws(() => parseCli(['--require-test-mode', '--require-live-mode']), /not both/)
  assert.throws(() => parseCli(['--offers-only', '--retirement-only']), /not both/)
  assert.equal(parseCli(['--offers-only']).scope, 'offers-only')
  assert.equal(parseCli(['--retirement-only']).scope, 'retirement-only')
})

test('catalog apply cannot reach Stripe with an unapproved live target', async () => {
  let providerAccess = false
  await assert.rejects(main([
    '--apply', '--plan-file', 'unused-plan.json', '--confirm-sha256', 'unused',
    '--journal-file', 'unused-journal.json',
  ], {
    secretKey: 'sk_live_guard',
    stripeFactory: () => { providerAccess = true; throw new Error('Unexpected provider access') },
  }), /test-mode key/)
  assert.equal(providerAccess, false)
})

test('live catalog preflight rejects a test key before Stripe access', async () => {
  let providerAccess = false
  await assert.rejects(main(['--dry-run', '--require-live-mode'], {
    secretKey: 'sk_test_guard',
    stripeFactory: () => { providerAccess = true; throw new Error('Unexpected provider access') },
  }), /live-mode key/)
  assert.equal(providerAccess, false)
})

// Catalog changes stop new sales while every existing subscription keeps its
// contracted price, quantity, schedule and renewal dates.
test('Business catalog consolidates new sales without repricing existing contracts', () => {
  const contracts = [
    { plan: 'commerce', amount: 8900, quantity: 1, interval: 'month', schedule: 'sub_sched_commerce' },
    { plan: 'marketing', amount: 9900, quantity: 5, interval: 'month', schedule: null },
    { plan: 'managed', amount: 14900, quantity: 3, interval: 'month', schedule: null },
    { plan: 'seo_accelerator', amount: 349000, quantity: 2, interval: 'year', schedule: null },
    { plan: 'growth', amount: 3900, quantity: 1, interval: 'month', schedule: null },
  ]
  const snapshot = {
    accountId: 'acct_contracts',
    accountMode: 'test',
    products: contracts.map(({ plan }) => ({
      id: `prod_${plan}`, active: true, metadata: { plan_id: plan }, default_price: `price_${plan}`,
    })),
    pricesByProduct: Object.fromEntries(contracts.map(({ plan, amount, interval }) => [
      `prod_${plan}`,
      [{ id: `price_${plan}`, product: `prod_${plan}`, active: true, currency: 'usd', unit_amount: amount,
        billing_scheme: 'per_unit', recurring: { interval, interval_count: 1 } }],
    ])),
    subscriptions: contracts.map(({ plan, quantity, schedule }) => ({
      id: `sub_${plan}`, status: 'active', schedule, billing_cycle_anchor: 1790000000,
      cancel_at: null, cancel_at_period_end: false, collection_method: 'charge_automatically', trial_start: null, trial_end: null,
      items: [{ id: `si_${plan}`, price: `price_${plan}`, quantity, current_period_start: 1790000000, current_period_end: 1792678400 }],
    })),
  }
  const original = structuredClone(snapshot)
  const plan = buildCatalogPlan({ snapshot })

  assert.deepEqual(snapshot, original)
  assert.deepEqual(plan.providerSnapshot.subscriptions, original.subscriptions)
  assert.equal(plan.providerSnapshotSha256, sha256Json(original))
  assert.deepEqual(plan.operations.filter(operation => operation.type.includes('subscription')), [])
  assert.deepEqual(plan.operations.filter(operation => operation.type === 'create_product').map(operation => operation.planId), ['business', 'site_language'])
  const businessPrice = plan.operations.find(operation => operation.type === 'create_price' && operation.planId === 'business')
  assert.deepEqual(businessPrice?.params, {
    currency: 'usd', recurring: { interval: 'month', interval_count: 1 },
    billing_scheme: 'tiered', tiers_mode: 'graduated',
    tiers: [{ up_to: 2, flat_amount: 9900 }, { up_to: 'inf', unit_amount: 4900 }],
  })
  for (const planId of ['commerce', 'marketing', 'managed', 'seo_accelerator']) {
    assert.deepEqual(plan.operations.filter(operation => operation.productId === `prod_${planId}`).map(operation => operation.type), [
      'clear_product_default_price', 'deactivate_price', 'archive_product',
    ])
  }

  const offersOnly = buildCatalogPlan({ snapshot, scope: 'offers-only' })
  assert.deepEqual(offersOnly.operations, plan.operations.filter(operation => !['clear_product_default_price', 'deactivate_price', 'archive_product'].includes(operation.type)))
  assert.deepEqual(offersOnly.providerSnapshot.subscriptions, original.subscriptions)
  assert.notEqual(offersOnly.planSha256, plan.planSha256)
})

test('retirement-only requires complete replacement offers and emits only archival operations', () => {
  const snapshot = {
    accountId: 'acct_contracts', accountMode: 'test', subscriptions: [],
    products: ['growth', 'business', 'commerce'].map(plan => ({
      id: `prod_${plan}`, active: true, metadata: { plan_id: plan }, default_price: `price_${plan}`,
    })),
    pricesByProduct: {
      prod_growth: [
        { id: 'price_growth', product: 'prod_growth', active: true, currency: 'usd', billing_scheme: 'tiered', tiers_mode: 'graduated',
          recurring: { interval: 'month', interval_count: 1 }, tiers: [{ up_to: 2, flat_amount: 4900 }, { up_to: 'inf', unit_amount: 4900 }] },
        { id: 'price_growth_annual', product: 'prod_growth', active: true, currency: 'usd', billing_scheme: 'tiered', tiers_mode: 'graduated',
          recurring: { interval: 'year', interval_count: 1 }, tiers: [{ up_to: 2, flat_amount: 58800 }, { up_to: 'inf', unit_amount: 58800 }] },
      ],
      prod_business: [
        { id: 'price_business', product: 'prod_business', active: true, currency: 'usd', billing_scheme: 'tiered', tiers_mode: 'graduated',
          recurring: { interval: 'month', interval_count: 1 }, tiers: [{ up_to: 2, flat_amount: 9900 }, { up_to: 'inf', unit_amount: 4900 }] },
      ],
      prod_commerce: [
        { id: 'price_commerce', product: 'prod_commerce', active: true, currency: 'usd', billing_scheme: 'per_unit',
          unit_amount: 8900, recurring: { interval: 'month', interval_count: 1 } },
      ],
    },
  }
  const plan = buildCatalogPlan({ snapshot, scope: 'retirement-only' })
  assert.deepEqual(plan.operations.map(operation => ({ type: operation.type, productId: operation.productId })), [
    { type: 'clear_product_default_price', productId: 'prod_commerce' },
    { type: 'deactivate_price', productId: 'prod_commerce' },
    { type: 'archive_product', productId: 'prod_commerce' },
  ])
  assert.throws(() => buildCatalogPlan({
    snapshot: { ...snapshot, pricesByProduct: { ...snapshot.pricesByProduct, prod_growth: snapshot.pricesByProduct.prod_growth.slice(0, 1) } },
    scope: 'retirement-only',
  }), /canonical Growth annual price/)
  assert.throws(() => buildCatalogPlan({
    snapshot: { ...snapshot, products: snapshot.products.filter(product => product.id !== 'prod_business') },
    scope: 'retirement-only',
  }), /canonical Business product; found 0/)
  assert.throws(() => buildCatalogPlan({
    snapshot: { ...snapshot, products: [...snapshot.products, { ...snapshot.products[1], id: 'prod_business_duplicate' }] },
    scope: 'retirement-only', canonicalProductIds: { business: 'prod_business' },
  }), /exactly one active canonical Business product; found 2/)
})
