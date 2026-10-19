import assert from 'node:assert/strict'
import test from 'node:test'
import type Stripe from 'stripe'
import { assertStripeCatalogPrices, isCurrentBusinessPrice, planSubscriptionItems, recurringPriceAmount, selectRentalUnitPrice, selectStripeCatalogPrice } from '../../server/utils/stripe-catalog.ts'
import { PRICING_COMPARISON, comparisonValue } from '../../shared/pricing-comparison.ts'
import { getPlanEntitlements } from '../../server/utils/billing-entitlements.ts'
import { classifyStripePlanChange } from '../../shared/stripe-ga4.ts'
import { additionalLocationPrice, additionalRentalUnitPrice, assertNewSalePlan, businessMonthlyAmount, coveredLocations, coveredRentalUnits } from '../../shared/billing-model.ts'
import { renderPlansMarkdown } from '../../server/routes/pricing.md.get.ts'
import type { Plan } from '../../server/utils/billing-plans.ts'

const product = { id: 'prod-existing', metadata: { plan_id: 'growth', monthly_price_id: 'price-month', annual_price_id: 'price-year' } } as unknown as Stripe.Product
// The canonical plan price as Stripe returns it: graduated, the last bound null.
const price = (id: string, interval: 'month' | 'year', amount: number, additional = interval === 'year' ? 58800 : 4900) => ({
  id, product: product.id, active: true, unit_amount: null, currency: 'usd', recurring: { interval, interval_count: 1 }, lookup_key: null,
  billing_scheme: 'tiered', tiers_mode: 'graduated',
  tiers: [{ up_to: 2, flat_amount: amount, unit_amount: null }, { up_to: null, flat_amount: null, unit_amount: additional }],
}) as unknown as Stripe.Price
const withPlanAmount = (base: Stripe.Price, amount: number) => ({ ...base, tiers: [{ ...base.tiers![0]!, flat_amount: amount }, base.tiers![1]!] }) as Stripe.Price
const monthly = price('price-month', 'month', 4900)
const annual = price('price-year', 'year', 58800)

test('pricing resolves exact provider interval identities, never derives annual from monthly', () => {
  assert.equal(selectStripeCatalogPrice(product, [monthly, annual], 'month')?.id, 'price-month')
  assert.equal(selectStripeCatalogPrice(product, [monthly, annual], 'year')?.id, 'price-year')
  assert.equal(selectStripeCatalogPrice(product, [monthly], 'year'), null)
  assert.equal(selectStripeCatalogPrice(product, [annual], 'month'), null)
  assertStripeCatalogPrices('growth', monthly, annual)
})

test('missing, wrong-currency and fabricated zero paid prices cannot become the current offer', () => {
  assert.throws(() => assertStripeCatalogPrices('growth', null), /monthly price/)
  assert.throws(() => assertStripeCatalogPrices('growth', { ...monthly, currency: 'eur' }), /monthly price/)
  assert.throws(() => assertStripeCatalogPrices('growth', withPlanAmount(monthly, 0)), /monthly price/)
  assert.throws(() => assertStripeCatalogPrices('growth', monthly, withPlanAmount(annual, 4900)), /annual price/)
  // The flat per-unit price the plan was sold at before is not the per-location offer.
  const flat = { ...monthly, billing_scheme: 'per_unit', tiers_mode: null, tiers: undefined, unit_amount: 4900 } as unknown as Stripe.Price
  assert.equal(selectStripeCatalogPrice({ ...product, metadata: { plan_id: 'growth' } } as Stripe.Product, [flat], 'month'), null)
  // An explicit $0.00 charge in a tier prints a $0.00 invoice line; the offer sets none.
  const zeroLines = { ...monthly, tiers: [{ up_to: 2, flat_amount: 4900, unit_amount: 0 }, { up_to: null, flat_amount: 0, unit_amount: 4900 }] } as unknown as Stripe.Price
  assert.throws(() => assertStripeCatalogPrices('growth', zeroLines), /monthly price/)
})

test('each additional location is USD 49 a month or USD 588 a year on every paid plan', () => {
  assert.throws(() => assertStripeCatalogPrices('growth', price('price-month', 'month', 4900, 8900)), /monthly price/)
  assert.throws(() => assertStripeCatalogPrices('growth', monthly, price('price-year', 'year', 58800, 4900)), /annual price/)
  assert.throws(() => assertStripeCatalogPrices('business', price('price-business-month', 'month', 14900, 9900)), /monthly price/)
  assert.equal(coveredLocations('free', null), 2)
  assert.equal(coveredLocations('growth', 1), 2)
  assert.equal(coveredLocations('growth', 2), 2)
  assert.equal(coveredLocations('commerce', 5), 5)
  assert.throws(() => coveredLocations('growth', null), /quantity/)
  assert.equal(additionalLocationPrice(), '$49 per additional location per month')
  assert.equal(additionalLocationPrice('year'), '$588 per additional location per year')
})

test('Business requires the approved USD 149 monthly offer and rejects an invented annual offer', () => {
  const business = price('price-business-month', 'month', 14900)
  assertStripeCatalogPrices('business', business)
  for (const amount of [0, 4900, 8900, 9900]) {
    assert.throws(() => assertStripeCatalogPrices('business', withPlanAmount(business, amount)), /monthly price/)
  }
  assert.throws(() => assertStripeCatalogPrices('business', { ...business, currency: 'eur' }), /monthly price/)
  assert.throws(() => assertStripeCatalogPrices('business', business, price('price-business-year', 'year', 178800)), /no authorized annual price/)
  for (const retired of ['commerce', 'marketing']) assert.throws(() => assertNewSalePlan(retired), /Unknown paid plan/)
  assert.throws(() => assertStripeCatalogPrices('invented_plan', business), /Unknown paid plan/)
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

test('display rename preserves provider identities and metadata selects one canonical offer', () => {
  const renamed = { ...product, name: 'Grow' }
  assert.equal(selectStripeCatalogPrice(renamed, [monthly, annual], 'month')?.id, monthly.id)
  assert.equal(selectStripeCatalogPrice(renamed, [monthly, annual], 'year')?.id, annual.id)
  const ambiguous = { ...product, metadata: { plan_id: 'growth' } }
  assert.throws(() => selectStripeCatalogPrice(ambiguous, [monthly, price('price-other', 'month', 4900)], 'month'), /exactly one canonical/)
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
  assert.ok(md.includes('- **Locations**: 2 included\n'))
  assert.ok(md.includes('- **Locations**: 2 included, then $49 per additional location per month\n'))
  assert.ok(!md.includes('Rental units'))
  const business = renderPlansMarkdown([{ ...dummyPlans[1]!, id: 'business', name: 'Business', prices: [{ id: 'p_business', amount: 14900, currency: 'usd', interval: 'month' }] }])
  assert.ok(business.includes('$149/month'))
  assert.ok(business.includes('- **Rental units**: 2 included, then $19 per additional rental unit per month. A rental unit is one independently bookable home'))
  assert.ok(md.includes('## Add-ons\n'))
  assert.ok(md.includes('- **Managed ads**: 10% of monthly ad spend. Chris hand-manages'))
  assert.ok(md.includes('- **SEO and marketing strategy**: $2,000 per month. Julia leads'))
})


test('the current contract charge uses its exact native price and quantity, including retired flat prices', () => {
  const flat = { ...monthly, id: 'price-original-flat', billing_scheme: 'per_unit', tiers_mode: null, tiers: undefined, unit_amount: 8900 } as unknown as Stripe.Price
  assert.equal(recurringPriceAmount(flat, 1), 8900)
  assert.equal(recurringPriceAmount(flat, 3), 26700)
  const business = price('price-business-month', 'month', 14900)
  assert.equal(recurringPriceAmount(business, 2), 14900)
  assert.equal(recurringPriceAmount(business, 5), 29600)
  assert.throws(() => recurringPriceAmount(business, null), /quantity/)
  assert.throws(() => recurringPriceAmount(business, -1), /quantity/)
  assert.throws(() => recurringPriceAmount({ ...business, tiers: undefined }, 2), /billing scheme/)
})

// #1493's sample portfolios: 149 + 49 × max(0, locations − 2) + 19 × max(0, units − 2) dollars a month.
test('the current Business offer bills locations and rental units with two independent allowances', () => {
  const samples: Array<[string, number, number, number]> = [
    ['one rental unit', 0, 1, 149], ['two rental units', 0, 2, 149], ['three rental units', 0, 3, 168],
    ['five rental units', 0, 5, 206], ['six apartments in one building', 0, 6, 225], ['six villas at separate addresses', 0, 6, 225],
    ['twenty rental units', 0, 20, 491], ['no rental units and no other locations', 0, 0, 149],
    ['three restaurants', 3, 0, 198], ['one restaurant with six cabins', 1, 6, 225],
  ]
  for (const [portfolio, locations, units, dollars] of samples) assert.equal(businessMonthlyAmount(locations, units), dollars * 100, portfolio)
  assert.equal(coveredRentalUnits(0), 2)
  assert.equal(coveredRentalUnits(4), 6)
  assert.throws(() => coveredRentalUnits(-1), /quantity/)
  assert.equal(additionalRentalUnitPrice(), '$19 per additional rental unit per month')
})

const unitProduct = { id: 'prod-units', active: true, metadata: { product_family: 'rental_units', monthly_price_id: 'price-unit' } } as unknown as Stripe.Product
const unitPrice = { id: 'price-unit', product: 'prod-units', active: true, currency: 'usd', billing_scheme: 'per_unit', unit_amount: 1900, transform_quantity: null,
  recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } } as unknown as Stripe.Price

test('the Additional rental unit price must be the one per-unit USD 19 monthly price the offer names', () => {
  assert.equal(selectRentalUnitPrice([unitProduct], [unitPrice]).id, 'price-unit')
  assert.throws(() => selectRentalUnitPrice([], [unitPrice]), /0 active Additional rental unit products/)
  assert.throws(() => selectRentalUnitPrice([unitProduct, { ...unitProduct, id: 'prod-units-2' } as Stripe.Product], [unitPrice]), /2 active/)
  for (const wrong of [{ unit_amount: 2900 }, { currency: 'eur' }, { recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' } }, { recurring: { interval: 'month', interval_count: 1, usage_type: 'metered' } }, { active: false }]) {
    assert.throws(() => selectRentalUnitPrice([unitProduct], [{ ...unitPrice, ...wrong } as Stripe.Price]), /per-unit USD 1900 cent monthly price/)
  }
})

test('a Business subscription bills rental units only on the current price; an earlier Business price keeps its contract', () => {
  const plan = (amount: number, planId = 'business') => ({ id: `si-${planId}`, quantity: 3, price: { ...price(`price-${planId}-${amount}`, 'month', amount), product: { id: `prod-${planId}`, metadata: { plan_id: planId } } } })
  const units = (quantity: number) => ({ id: 'si-units', quantity, price: { ...unitPrice, product: unitProduct } })
  const strategy = { id: 'si-strategy', quantity: 1, price: { id: 'price-strategy', product: { id: 'prod-strategy', metadata: { product_family: 'services', service: 'strategy' } } } }
  const subscription = (...items: unknown[]) => ({ id: 'sub-business', items: { data: items } }) as unknown as Stripe.Subscription
  assert.equal(isCurrentBusinessPrice(plan(14900).price as unknown as Stripe.Price), true)
  assert.equal(isCurrentBusinessPrice(plan(9900).price as unknown as Stripe.Price), false)
  const current = planSubscriptionItems(subscription(plan(14900), units(4), strategy))
  assert.deepEqual([current.plan.id, current.rentalUnits?.quantity], ['si-business', 4])
  assert.equal(planSubscriptionItems(subscription(plan(9900))).rentalUnits, null)
  assert.throws(() => planSubscriptionItems(subscription(plan(9900), units(1))), /without the current Business price/)
  assert.throws(() => planSubscriptionItems(subscription(plan(4900, 'growth'), units(1))), /without the current Business price/)
  assert.throws(() => planSubscriptionItems(subscription(units(1))), /exactly one plan price/)
  assert.throws(() => planSubscriptionItems(subscription(plan(14900), units(1), units(2))), /more than one Additional rental unit/)
})
