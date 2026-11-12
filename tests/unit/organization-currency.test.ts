import assert from 'node:assert/strict'
import test from 'node:test'
import { currencyForCountry, currencyFractionDigits, isCurrencyCode } from '../../shared/currencies.ts'
import { onboardingFlow } from '../../server/utils/onboarding-flow.ts'

const answers = {
  vertical: 'restaurant' as const,
  source: 'manual' as const,
  placeId: null,
  name: 'Cozy Cafe',
  sourceLocale: 'en',
  streetAddress: '',
  city: '',
  country: '',
  timezone: 'Asia/Bangkok',
  currency: null,
  phone: '',
  productCount: 0,
  heroHeadline: '',
}

const step = (id: string, overrides: Partial<Parameters<typeof onboardingFlow>[0]> = {}) => {
  const found = onboardingFlow({ ...answers, ...overrides }).steps.find(entry => entry.id === id)
  assert.ok(found, `the flow has no '${id}' step`)
  return found
}

test('any ISO 4217 code is a currency; Stripe answers which ones the business can charge in', () => {
  for (const code of ['THB', 'USD', 'KRW', 'CHF', 'NZD', 'MXN', 'BRL', 'AED', 'ZAR', 'NGN']) assert.equal(isCurrencyCode(code), true, code)
  for (const value of ['usd', 'XYZ', '', 'US', null, undefined, 840]) assert.equal(isCurrencyCode(value), false, String(value))
})

test('minor units follow Stripe’s API representation', () => {
  for (const code of ['JPY', 'KRW', 'VND', 'CLP', 'XOF']) assert.equal(currencyFractionDigits(code), 0, code)
  for (const code of ['KWD', 'BHD', 'JOD', 'OMR', 'TND']) assert.equal(currencyFractionDigits(code), 3, code)
  // Zero-decimal currencies Stripe still represents with two decimals.
  for (const code of ['ISK', 'UGX', 'HUF', 'TWD', 'USD', 'THB', 'IDR']) assert.equal(currencyFractionDigits(code), 2, code)
  assert.throws(() => currencyFractionDigits('XYZ'), /not an ISO 4217/)
})

test('proposes a default currency for known countries without restricting options', () => {
  assert.equal(currencyForCountry('TH'), 'THB')
  assert.equal(currencyForCountry('US'), 'USD')
  assert.equal(currencyForCountry('GB'), 'GBP')
  assert.equal(currencyForCountry('DE'), 'EUR')
  assert.equal(currencyForCountry('JP'), 'JPY')
  assert.equal(currencyForCountry('unknown'), null)
  assert.equal(currencyForCountry(null), null)
})

test('the optional location step accepts authored partial addresses', () => {
  assert.equal(step('location').canAdvance, true)
  assert.equal(step('location').nextLabel, 'Skip for now')
  for (const authored of [{ country: 'TH' }, { city: 'Krabi' }, { streetAddress: '123 Main Street' }]) {
    assert.equal(step('location', authored).nextLabel, 'Next')
  }
})

test('the currency step is not complete until the currency is answered', () => {
  assert.equal(step('currency').canAdvance, false)
  assert.equal(step('currency', { currency: 'THB' }).canAdvance, true)
  assert.equal(onboardingFlow(answers).resumeStep, 'currency')
})

test('the currency step is asked before anything is priced', () => {
  const order = onboardingFlow(answers).steps.map(entry => entry.id)
  assert.ok(order.indexOf('currency') > order.indexOf('location'), 'the country must be answered first')
  assert.ok(order.indexOf('currency') < order.indexOf('products'), 'prices must not be entered first')
  assert.ok(order.indexOf('currency') < order.indexOf('review'))
})

