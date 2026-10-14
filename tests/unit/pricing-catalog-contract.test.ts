import assert from 'node:assert/strict'
import test from 'node:test'
import type Stripe from 'stripe'
import { assertStripeCatalogPrices, selectStripeCatalogPrice } from '../../server/utils/stripe-catalog.ts'
import { PRICING_COMPARISON, comparisonValue } from '../../shared/pricing-comparison.ts'
import { getPlanEntitlements } from '../../server/utils/billing-entitlements.ts'
import { classifyStripePlanChange } from '../../shared/stripe-ga4.ts'
import { additionalLocationPrice, coveredLocations } from '../../shared/billing-model.ts'
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
  assert.throws(() => assertStripeCatalogPrices('commerce', price('price-commerce-month', 'month', 8900, 8900)), /monthly price/)
  assert.equal(coveredLocations('free', null), 2)
  assert.equal(coveredLocations('growth', 1), 2)
  assert.equal(coveredLocations('growth', 2), 2)
  assert.equal(coveredLocations('commerce', 5), 5)
  assert.throws(() => coveredLocations('growth', null), /quantity/)
  assert.equal(additionalLocationPrice(), '$49 per additional location per month')
  assert.equal(additionalLocationPrice('year'), '$588 per additional location per year')
})

test('Commerce requires the approved USD 89 monthly offer and rejects an invented annual offer', () => {
  const commerce = price('price-commerce-month', 'month', 8900)
  assertStripeCatalogPrices('commerce', commerce)
  for (const amount of [0, 4900, 9900, 14900]) {
    assert.throws(() => assertStripeCatalogPrices('commerce', withPlanAmount(commerce, amount)), /monthly price/)
  }
  assert.throws(() => assertStripeCatalogPrices('commerce', { ...commerce, currency: 'eur' }), /monthly price/)
  assert.throws(() => assertStripeCatalogPrices('commerce', commerce, price('price-commerce-year', 'year', 106800)), /no authorized annual price/)
  assert.throws(() => assertStripeCatalogPrices('invented_plan', commerce), /Unknown paid plan/)
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

test('Marketing is Commerce plus ad management at USD 99, above Commerce', () => {
  const marketing = getPlanEntitlements('marketing')
  const commerce = getPlanEntitlements('commerce')
  for (const [capability, value] of Object.entries(commerce)) {
    if (capability !== 'plan' && capability !== 'marketing') assert.equal(marketing[capability], value)
  }
  assert.equal(marketing.payments, true)
  assert.equal(marketing.marketing, true)
  assert.equal(commerce.marketing, false)
  assert.equal(getPlanEntitlements('growth').marketing, false)
  assertStripeCatalogPrices('marketing', price('price-marketing-month', 'month', 9900))
  assert.throws(() => assertStripeCatalogPrices('marketing', price('price-marketing-month', 'month', 8900)), /monthly price/)
  assert.throws(() => assertStripeCatalogPrices('marketing', price('price-marketing-month', 'month', 9900), price('price-marketing-year', 'year', 118800)), /no authorized annual price/)
  assert.equal(classifyStripePlanChange('commerce', 'marketing', true), 'upgrade')
  assert.equal(classifyStripePlanChange('marketing', 'growth', true), 'downgrade')
  const ads = PRICING_COMPARISON.flatMap(group => [...group.rows]).find(row => row.id === 'ads.google')!
  assert.equal(comparisonValue(ads, 'commerce'), 'Not included')
  assert.equal(comparisonValue(ads, 'marketing'), 'Included')
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
  assert.ok(md.includes('# Krabiclaw Pricing & Plans'))
  assert.ok(md.includes('## Free'))
  assert.ok(md.includes('Free ($0/month)'))
  assert.ok(md.includes('## Growth'))
  assert.ok(md.includes('$49/month'))
  assert.ok(md.includes('Custom Domain: Included'))
  assert.ok(md.includes('Custom Domain: Not included'))
  assert.ok(md.includes('- **Locations**: 2 included\n'))
  assert.ok(md.includes('- **Locations**: 2 included, then $49 per additional location per month\n'))
})
