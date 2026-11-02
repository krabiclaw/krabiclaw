import assert from 'node:assert/strict'
import test from 'node:test'
import { currencyForCountry, currencyFractionDigits, isCurrencyCode } from '../../shared/currencies.ts'
import { ONBOARDING_STEPS, type OnboardingFlowState } from '../../composables/useOnboardingFlow.ts'

const step = (id: string) => {
  const found = ONBOARDING_STEPS.find(entry => entry.id === id)
  assert.ok(found, `the flow has no '${id}' step`)
  return found
}

// The wizard's authored answers, with only the fields these assertions read.
// An address may be partial; the currency still needs an explicit answer.
const answers = (over: Partial<OnboardingFlowState['details']> = {}) => ({
  details: {
    name: 'Cozy Cafe', city: 'Krabi', streetAddress: '123 Main Street', addressLine2: '',
    region: 'Krabi', postalCode: '', country: '', phone: '', currency: null, ...over,
  },
} as OnboardingFlowState)

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
  const location = step('location')
  assert.equal(location.optional, true)
  const noAddress = { country: '', city: '', streetAddress: '' }
  assert.equal(location.complete(answers(noAddress)), false)
  for (const authored of [{ country: 'TH' }, { city: 'Krabi' }, { streetAddress: '123 Main Street' }]) {
    assert.equal(location.complete(answers({ ...noAddress, ...authored })), true)
  }
})

test('the currency step is not complete until the currency is answered', () => {
  const currency = step('currency')
  assert.equal(currency.complete(answers({ currency: null })), false)
  assert.equal(currency.complete(answers({ currency: 'THB' })), true)
  // It is not optional, so the flow cannot be walked past it without an answer.
  assert.notEqual(currency.optional, true)
  assert.notEqual(currency.intro, true)
})

test('the currency step is asked before anything is priced', () => {
  const order = ONBOARDING_STEPS.map(entry => entry.id)
  assert.ok(order.indexOf('currency') > order.indexOf('location'), 'the country must be answered first')
  assert.ok(order.indexOf('currency') < order.indexOf('products'), 'prices must not be entered first')
  assert.ok(order.indexOf('currency') < order.indexOf('review'))
})

