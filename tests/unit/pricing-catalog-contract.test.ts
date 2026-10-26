import assert from 'node:assert/strict'
import test from 'node:test'
import type Stripe from 'stripe'
import { assertStripeCatalogPrice, planSubscriptionItem, recurringPriceAmount, selectMeteredPrices, selectStripeCatalogPrice } from '../../server/utils/stripe-catalog.ts'
import { PRICING_COMPARISON, comparisonValue } from '../../shared/pricing-comparison.ts'
import { getPlanEntitlements } from '../../server/utils/billing-entitlements.ts'
import { classifyStripePlanChange } from '../../shared/stripe-ga4.ts'
import { additionalHomePrice, assertNewSalePlan, BILLING_METER_KEYS, BILLING_METERS, PAID_PLAN_PRICES, PAYMENTS_FEE, planMeters, ratePercent } from '../../shared/billing-model.ts'
import { renderPlansMarkdown } from '../../server/routes/pricing.md.get.ts'
import type { Plan } from '../../server/utils/billing-plans.ts'

const product = { id: 'prod-existing', metadata: { plan_id: 'growth', monthly_price_id: 'price-month' } } as unknown as Stripe.Product
// The canonical plan price as Stripe returns it: one flat monthly charge.
const price = (id: string, amount: number, overrides: Record<string, unknown> = {}) => ({
  id, product: product.id, active: true, unit_amount: amount, currency: 'usd', billing_scheme: 'per_unit', transform_quantity: null,
  recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, lookup_key: null, ...overrides,
}) as unknown as Stripe.Price
const monthly = price('price-month', 4900)

test('a plan is one flat monthly USD price; anything else cannot become the current offer', () => {
  assert.equal(selectStripeCatalogPrice(product, [monthly])?.id, 'price-month')
  assertStripeCatalogPrice('growth', monthly)
  assertStripeCatalogPrice('business', price('price-business', 14900))
  assert.throws(() => assertStripeCatalogPrice('growth', null), /flat USD 4900 cent monthly price/)
  for (const wrong of [{ currency: 'eur' }, { unit_amount: 0 }, { unit_amount: 3900 }, { recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' } },
    { recurring: { interval: 'month', interval_count: 1, usage_type: 'metered' } }, { billing_scheme: 'tiered', unit_amount: null }]) {
    assert.throws(() => assertStripeCatalogPrice('growth', price('price-month', 4900, wrong)), /monthly price/)
  }
  for (const amount of [0, 4900, 8900, 9900]) assert.throws(() => assertStripeCatalogPrice('business', price('price-business', amount)), /monthly price/)
  for (const retired of ['commerce', 'marketing']) assert.throws(() => assertNewSalePlan(retired), /Unknown paid plan/)
  assert.throws(() => assertStripeCatalogPrice('invented_plan', monthly), /Unknown paid plan/)
  // The graduated per-location price the plans were sold at before is not the offer.
  const graduated = price('price-graduated', 4900, { billing_scheme: 'tiered', unit_amount: null })
  assert.equal(selectStripeCatalogPrice({ ...product, metadata: { plan_id: 'growth' } } as Stripe.Product, [graduated]), null)
  assert.throws(() => selectStripeCatalogPrice(product, [graduated]), /invalid monthly_price_id/)
})

test('display rename preserves provider identities and metadata selects one canonical offer', () => {
  assert.equal(selectStripeCatalogPrice({ ...product, name: 'Grow' }, [monthly, price('price-other', 4900)])?.id, monthly.id)
  assert.throws(() => selectStripeCatalogPrice({ ...product, metadata: { plan_id: 'growth' } }, [monthly, price('price-other', 4900)]), /exactly one canonical/)
})

// Stripe's own phrasing for each metered price, and which plan carries it.
test('homes and fees are metered prices in Stripe’s phrasing', () => {
  assert.equal(additionalHomePrice(), '$9 per additional home per month')
  assert.equal(PAYMENTS_FEE, '1.4% of payment volume, plus Stripe fees')
  assert.equal(ratePercent(0.014), '1.4')
  assert.equal(ratePercent(0.1), '10')
  // A home is a lodging unit, metered the same on Growth and Business; locations are not metered.
  assert.deepEqual(planMeters('growth'), ['homes'])
  assert.deepEqual(planMeters('business'), ['homes', 'captured_volume', 'stripe_cost', 'ad_spend'])
  assert.deepEqual(planMeters('free'), [])
  assert.deepEqual(BILLING_METER_KEYS.map(key => BILLING_METERS[key].formula), ['last', 'sum', 'sum', 'sum'])
  assert.deepEqual(BILLING_METERS.homes.tiers, [{ up_to: 2, unit_amount: 0 }, { up_to: 'inf', unit_amount: 900 }])
  assert.equal(BILLING_METERS.homes.description, '2 homes included, then $9 per additional home per month.')
})

const meter = (key: string, overrides: Record<string, unknown> = {}) => ({
  id: `mtr-${key}`, status: 'active', event_name: BILLING_METERS[key as keyof typeof BILLING_METERS].eventName,
  default_aggregation: { formula: BILLING_METERS[key as keyof typeof BILLING_METERS].formula }, ...overrides,
}) as unknown as Stripe.Billing.Meter
const meteredProduct = (key: string) => ({ id: `prod-${key}`, active: true, metadata: { product_family: key, monthly_price_id: `price-${key}` } }) as unknown as Stripe.Product
const meteredPrice = (key: string, overrides: Record<string, unknown> = {}) => {
  const definition = BILLING_METERS[key as keyof typeof BILLING_METERS]
  return {
    id: `price-${key}`, product: `prod-${key}`, active: true, currency: 'usd',
    recurring: { interval: 'month', interval_count: 1, usage_type: 'metered', meter: `mtr-${key}` },
    ...('tiers' in definition
      ? { billing_scheme: 'tiered', tiers_mode: 'graduated', unit_amount: null, tiers: definition.tiers.map(tier => ({ up_to: tier.up_to === 'inf' ? null : tier.up_to, unit_amount: tier.unit_amount, flat_amount: null })) }
      : { billing_scheme: 'per_unit', unit_amount: null, unit_amount_decimal: Number(definition.unitAmountDecimal).toFixed(12) }),
    ...overrides,
  } as unknown as Stripe.Price
}
const catalog = () => ({
  products: BILLING_METER_KEYS.map(meteredProduct),
  prices: BILLING_METER_KEYS.map(key => meteredPrice(key)),
  meters: BILLING_METER_KEYS.map(key => meter(key)),
})

test('each metered price must be the published one on its meter', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(selectMeteredPrices(catalog())).map(([key, row]) => [key, row.id])),
    Object.fromEntries(BILLING_METER_KEYS.map(key => [key, `price-${key}`])))
  const replace = (key: string, overrides: Record<string, unknown>) => ({ ...catalog(), prices: catalog().prices.map(row => row.id === `price-${key}` ? meteredPrice(key, overrides) : row) })
  assert.throws(() => selectMeteredPrices({ ...catalog(), products: catalog().products.filter(row => row.id !== 'prod-homes') }), /0 active Additional home products/)
  assert.throws(() => selectMeteredPrices(replace('homes', { tiers: [{ up_to: 2, unit_amount: 0, flat_amount: null }, { up_to: null, unit_amount: 4900, flat_amount: null }] })), /Additional home monthly on the krabiclaw_homes meter/)
  assert.throws(() => selectMeteredPrices(replace('homes', { tiers: [{ up_to: 5, unit_amount: 0, flat_amount: null }, { up_to: null, unit_amount: 900, flat_amount: null }] })), /Additional home monthly on the krabiclaw_homes meter/)
  assert.throws(() => selectMeteredPrices(replace('captured_volume', { unit_amount_decimal: '0.029' })), /Payments fee monthly/)
  assert.throws(() => selectMeteredPrices(replace('stripe_cost', { recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed', meter: null } })), /Stripe fees monthly/)
  assert.throws(() => selectMeteredPrices({ ...catalog(), meters: catalog().meters.map(row => row.id === 'mtr-ad_spend' ? meter('ad_spend', { default_aggregation: { formula: 'last' } }) : row) }), /Managed ads monthly on the krabiclaw_ad_spend meter/)
})

test('Commerce inherits Growth capabilities and participates in native subscription transitions', () => {
  const growth = getPlanEntitlements('growth')
  const commerce = getPlanEntitlements('commerce')
  for (const [capability, value] of Object.entries(growth)) {
    if (capability !== 'plan' && capability !== 'payments') assert.equal(commerce[capability], value)
  }
  assert.equal(getPlanEntitlements('free').payments, false)
  assert.equal(growth.payments, false)
  assert.equal(commerce.payments, true)
  assert.equal(classifyStripePlanChange('free', 'commerce', false), 'initial_subscription')
  assert.equal(classifyStripePlanChange('growth', 'commerce', true), 'upgrade')
  assert.equal(classifyStripePlanChange('commerce', 'growth', true), 'downgrade')
  assert.equal(classifyStripePlanChange('commerce', 'commerce', true), null)
})

test('Business combines payments and ad management while existing contracts retain their capabilities', () => {
  const business = getPlanEntitlements('business')
  const marketing = getPlanEntitlements('marketing')
  const commerce = getPlanEntitlements('commerce')
  for (const [capability, value] of Object.entries(marketing)) {
    if (capability !== 'plan') assert.equal(business[capability], value)
  }
  assert.equal(business.payments, true)
  assert.equal(business.marketing, true)
  assert.equal(marketing.payments, true)
  assert.equal(marketing.marketing, true)
  assert.equal(commerce.payments, true)
  assert.equal(commerce.marketing, false)
  assert.equal(getPlanEntitlements('growth').marketing, false)
  assert.equal(classifyStripePlanChange('commerce', 'business', true), 'upgrade')
  assert.equal(classifyStripePlanChange('marketing', 'business', true), 'upgrade')
  assert.equal(classifyStripePlanChange('marketing', 'growth', true), 'downgrade')
  assert.equal(classifyStripePlanChange('business', 'growth', true), 'downgrade')
  assert.equal(classifyStripePlanChange('business', 'free', true), 'downgrade')
  const ads = PRICING_COMPARISON.flatMap(group => [...group.rows]).find(row => row.id === 'ads.google')!
  assert.equal(comparisonValue(ads, 'commerce'), 'Not included')
  assert.equal(comparisonValue(ads, 'business'), 'Included')
})

test('comparison rejects unknown capabilities and preserves current review-request policy', () => {
  assert.throws(() => comparisonValue({ entitlement: 'invented_capability' }, 'growth'), /Unknown capability/)
  assert.throws(() => comparisonValue({ entitlement: 'messaging' }, 'invented_plan'), /Unsupported runtime billing plan/)
  const review = PRICING_COMPARISON.flatMap(group => [...group.rows]).find(row => row.id === 'reviews.requests')!
  assert.equal(comparisonValue(review, 'free'), 'Not included')
  assert.equal(comparisonValue(review, 'growth'), 'Included')
  assert.equal(comparisonValue(review, 'commerce'), 'Included')
  const payments = PRICING_COMPARISON.flatMap(group => [...group.rows]).find(row => row.id === 'payments.acceptance')!
  assert.equal(comparisonValue(payments, 'free'), 'Not included')
  assert.equal(comparisonValue(payments, 'growth'), 'Not included')
  assert.equal(comparisonValue(payments, 'commerce'), 'Included')
  const onboarding = PRICING_COMPARISON.flatMap(group => [...group.rows]).find(row => row.id === 'places.onboarding')!
  assert.equal(comparisonValue(onboarding, 'free'), 'Included')
})

test('renderPlansMarkdown generates accurate, machine-readable markdown specifications', () => {
  const dummyPlans: Plan[] = [
    {
      id: 'free',
      name: 'Free',
      tagline: 'Start building for free',
      highlighted: false,
      prices: [],
      features: ['Basic templates', 'AI site generation'],
      limits: { customDomain: false, googlePlaces: false, support: 'Community' },
      cta: { label: 'Start Free', href: '/signup' },
    },
    {
      id: 'growth',
      name: 'Growth',
      tagline: 'Scale your business',
      highlighted: true,
      prices: [{ id: 'p_month', amount: 4900, currency: 'usd', interval: 'month' }],
      features: ['Custom domains', 'Google Places', 'Direct booking'],
      limits: { customDomain: true, googlePlaces: true, support: 'Priority' },
      cta: { label: 'Upgrade', href: '/signup' },
    },
  ]

  const md = renderPlansMarkdown(dummyPlans)
  assert.ok(md.includes('# KrabiClaw Pricing & Plans'))
  assert.ok(md.includes('## Free'))
  assert.ok(md.includes('Free ($0/month)'))
  assert.ok(md.includes('## Growth'))
  assert.ok(md.includes('$49/month'))
  assert.ok(md.includes('Custom Domain: Included'))
  assert.ok(md.includes('Custom Domain: Not included'))
  assert.ok(md.includes('- **Homes**: 2 included. A home is a place to stay.\n'))
  assert.ok(md.includes('- **Homes**: 2 included, then $9 per additional home per month. A home is a place to stay.\n'))
  const business = renderPlansMarkdown([{ ...dummyPlans[1]!, id: 'business', name: 'Business', prices: [{ id: 'p_business', amount: 14900, currency: 'usd', interval: 'month' }] }])
  assert.ok(business.includes('$149/month'))
  assert.ok(!business.includes('rental unit'))
  assert.ok(business.includes('- **Payments fees**: 1.4% of payment volume, plus Stripe fees.\n'))
  assert.ok(md.includes('- **Billing**: Additional homes and fees are billed on your subscription invoice at the end of each month.\n'))
  assert.ok(!md.includes('Payments fees'))
  assert.ok(md.includes('## Add-ons\n'))
  assert.ok(md.includes('- **Managed ads**: 10% of monthly ad spend. Chris hand-manages'))
  assert.ok(md.includes('- **SEO and marketing strategy**: $2,000 per month. Julia leads'))
})


test('the current contract charge uses its exact native price and quantity, including retired graduated prices', () => {
  assert.equal(recurringPriceAmount(monthly, 1), 4900)
  const graduated = price('price-graduated', 0, { billing_scheme: 'tiered', tiers_mode: 'graduated', unit_amount: null,
    tiers: [{ up_to: 2, flat_amount: 4900, unit_amount: null }, { up_to: null, flat_amount: null, unit_amount: 4900 }] })
  assert.equal(recurringPriceAmount(graduated, 2), 4900)
  assert.equal(recurringPriceAmount(graduated, 5), 19600)
  assert.throws(() => recurringPriceAmount(monthly, null), /quantity/)
  assert.throws(() => recurringPriceAmount(monthly, -1), /quantity/)
  assert.throws(() => recurringPriceAmount({ ...graduated, tiers: undefined }, 2), /billing scheme/)
})

test('a plan subscription has one plan item beside its metered and service items', () => {
  const plan = { id: 'si-business', quantity: 1, price: { ...price('price-business', 14900), product: { id: 'prod-business', metadata: { plan_id: 'business' } } } }
  const metered = { id: 'si-captured-volume', price: { ...meteredPrice('captured_volume'), product: meteredProduct('captured_volume') } }
  const homes = { id: 'si-homes', price: { ...meteredPrice('homes'), product: meteredProduct('homes') } }
  const strategy = { id: 'si-strategy', quantity: 1, price: { id: 'price-strategy', product: { id: 'prod-strategy', metadata: { product_family: 'services', service: 'strategy' } } } }
  const subscription = (...items: unknown[]) => ({ id: 'sub-business', items: { data: items } }) as unknown as Stripe.Subscription
  assert.equal(planSubscriptionItem(subscription(plan, metered, homes, strategy)).id, 'si-business')
  // A subscription from before homes were metered carries no homes item and bills its plan exactly as before.
  const earlier = subscription(plan, metered, strategy)
  assert.equal(planSubscriptionItem(earlier).id, 'si-business')
  assert.equal(recurringPriceAmount(planSubscriptionItem(earlier).price, planSubscriptionItem(earlier).quantity), PAID_PLAN_PRICES.business.monthly)
  assert.throws(() => planSubscriptionItem(subscription(metered)), /exactly one plan price/)
  assert.throws(() => planSubscriptionItem(subscription(plan, { ...plan, id: 'si-growth' })), /exactly one plan price/)
})

// The published homes price on Business: 50 homes are the flat $149 plus 48 × $9, which is $581 per month.
test('a 50-home Business organization is quoted $581 per month', () => {
  const homes = meteredPrice('homes')
  assert.equal(recurringPriceAmount(homes, 2), 0)
  assert.equal(recurringPriceAmount(homes, 50), 48 * 900)
  assert.equal(PAID_PLAN_PRICES.business.monthly + recurringPriceAmount(homes, 50), 58100)
  assert.equal(PAID_PLAN_PRICES.growth.monthly + recurringPriceAmount(homes, 50), 48100)
})
