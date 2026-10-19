import assert from 'node:assert/strict'
import test from 'node:test'
import { assertCatalogModeKey, buildCatalogPlan, sha256Json } from '../../scripts/lib/stripe-catalog-plan.mjs'
import { assertStripeCliIdentity, main, parseCli, parseStripeCliResponse } from '../../scripts/seed-stripe.mjs'

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
  assert.throws(() => parseCli(['--stripe-cli-config', 'private.toml']), /explicit --require-test-mode or --require-live-mode/)
  assert.throws(() => parseCli(['--stripe-cli-config', 'private.toml', '--require-test-mode', '--ownership-file', 'ownership.json']), /catalog operations only/)
})

test('CLI authentication proves account and mode without accepting missing or changed context', () => {
  assert.equal(assertStripeCliIdentity({ account_id: 'acct_sandbox', mode: 'test' }, 'test'), 'acct_sandbox')
  assert.throws(() => assertStripeCliIdentity({ account_id: 'acct_sandbox', mode: 'live' }, 'test'), /require test mode/)
  assert.throws(() => assertStripeCliIdentity({ account_id: 'acct_sandbox' }, 'test'), /require test mode/)
  assert.throws(() => assertStripeCliIdentity({ mode: 'test' }, 'test'), /exact account ID/)
  assert.throws(() => assertStripeCliIdentity({ account_id: 'acct_other', mode: 'test' }, 'test', 'acct_sandbox'), /account changed/)
})

test('CLI response parsing retains the actual status, response headers and provider error', () => {
  const response = parseStripeCliResponse('> GET https://api.stripe.com/v1/products\n< HTTP 400\n< Content-Type: application/json\n< Request-Id: req_badprice\n\n{"error":{"message":"No such price","code":"resource_missing"}}\n')
  assert.deepEqual(response, {
    statusCode: 400, headers: { 'content-type': 'application/json', 'request-id': 'req_badprice' },
    body: { error: { message: 'No such price', code: 'resource_missing' } },
  })
  assert.throws(() => parseStripeCliResponse('{"id":"prod_without_status"}'), /actual HTTP response status/)
  assert.throws(() => parseStripeCliResponse('< HTTP 200\n< Content-Type: application/json\n'), /JSON response body/)
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
  assert.deepEqual(plan.operations.filter(operation => operation.type === 'create_product').map(operation => operation.planId), ['business', 'rental_units', 'site_language', 'strategy'])
  // Like a service, the Additional rental unit product is found by its family and never carries a plan id.
  const unitProduct = plan.operations.find(operation => operation.type === 'create_product' && operation.planId === 'rental_units')
  assert.deepEqual(unitProduct?.params.metadata, { product_family: 'rental_units', highlighted: 'false' })
  const unitPrice = plan.operations.find(operation => operation.type === 'create_price' && operation.planId === 'rental_units')
  assert.deepEqual(unitPrice?.params, { currency: 'usd', recurring: { interval: 'month', interval_count: 1 }, billing_scheme: 'per_unit', unit_amount: 1900 })
  const unitUpdate = plan.operations.find(operation => operation.type === 'update_product' && operation.product?.ref?.planId === 'rental_units')
  assert.equal(unitUpdate?.params.unit_label, 'rental unit')
  // The app finds the strategy product by its service metadata and never by a plan id, which would make Better Auth treat it as a plan.
  const strategyProduct = plan.operations.find(operation => operation.type === 'create_product' && operation.planId === 'strategy')
  assert.deepEqual(strategyProduct?.params.metadata, { product_family: 'services', service: 'strategy', highlighted: 'false' })
  assert.equal(strategyProduct?.params.metadata.plan_id, undefined)
  const strategyPrice = plan.operations.find(operation => operation.type === 'create_price' && operation.planId === 'strategy')
  assert.deepEqual(strategyPrice?.params, { currency: 'usd', recurring: { interval: 'month', interval_count: 1 }, billing_scheme: 'per_unit', unit_amount: 200000 })
  const businessPrice = plan.operations.find(operation => operation.type === 'create_price' && operation.planId === 'business')
  assert.deepEqual(businessPrice?.params, {
    currency: 'usd', recurring: { interval: 'month', interval_count: 1 },
    billing_scheme: 'tiered', tiers_mode: 'graduated',
    tiers: [{ up_to: 2, flat_amount: 14900 }, { up_to: 'inf', unit_amount: 4900 }],
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
          recurring: { interval: 'month', interval_count: 1 }, tiers: [{ up_to: 2, flat_amount: 14900 }, { up_to: 'inf', unit_amount: 4900 }] },
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

// The $149 Business offer replaces the $99 one for new sales only: the offers
// scope adds the new price and points the product at it, and the $99 price a
// subscription is on stays active until the retirement scope, then stays its contract.
test('Business moves to the USD 149 offer without repricing a USD 99 subscription', () => {
  const tiered = (id, amount) => ({ id, product: 'prod_business', active: true, currency: 'usd', billing_scheme: 'tiered', tiers_mode: 'graduated',
    recurring: { interval: 'month', interval_count: 1 }, tiers: [{ up_to: 2, flat_amount: amount }, { up_to: 'inf', unit_amount: 4900 }] })
  const snapshot = {
    accountId: 'acct_business', accountMode: 'test',
    products: [{ id: 'prod_business', active: true, metadata: { plan_id: 'business', monthly_price_id: 'price_business_99' }, default_price: 'price_business_99' }],
    pricesByProduct: { prod_business: [tiered('price_business_99', 9900)] },
    subscriptions: [{ id: 'sub_business', status: 'active', schedule: null, billing_cycle_anchor: 1790000000, cancel_at: null, cancel_at_period_end: false,
      collection_method: 'charge_automatically', trial_start: null, trial_end: null,
      items: [{ id: 'si_business', price: 'price_business_99', quantity: 4, current_period_start: 1790000000, current_period_end: 1792678400 }] }],
  }
  const offers = buildCatalogPlan({ snapshot, scope: 'offers-only' })
  const created = offers.operations.find(operation => operation.type === 'create_price' && operation.planId === 'business')
  assert.deepEqual(created?.params.tiers, [{ up_to: 2, flat_amount: 14900 }, { up_to: 'inf', unit_amount: 4900 }])
  const update = offers.operations.find(operation => operation.type === 'update_product' && operation.product?.id === 'prod_business')
  assert.deepEqual(update?.params.default_price, { ref: { kind: 'price', planId: 'business' } })
  assert.deepEqual(update?.params.metadata.monthly_price_id, { ref: { kind: 'price', planId: 'business' } })
  assert.equal(offers.operations.some(operation => operation.priceId === 'price_business_99'), false)
  assert.deepEqual(offers.providerSnapshot.subscriptions, snapshot.subscriptions)
  // Once the $149 price exists, retirement deactivates the $99 price for new sales; the subscription keeps billing on it.
  const after = { ...snapshot, products: [{ ...snapshot.products[0], metadata: { plan_id: 'business', monthly_price_id: 'price_business_149' }, default_price: 'price_business_149' }],
    pricesByProduct: { prod_business: [tiered('price_business_99', 9900), tiered('price_business_149', 14900)] } }
  const full = buildCatalogPlan({ snapshot: after })
  assert.deepEqual(full.operations.filter(operation => operation.priceId === 'price_business_99').map(operation => operation.type), ['deactivate_price'])
  assert.equal(full.operations.some(operation => operation.type.includes('subscription')), false)
})
