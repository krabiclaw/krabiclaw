import assert from 'node:assert/strict'
import test from 'node:test'
import { currencyForCountry, isCurrencyCode, SUPPORTED_CURRENCIES } from '../../shared/currencies.ts'
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

test('a country proposes the currency its businesses price in', () => {
  assert.equal(currencyForCountry('TH'), 'THB')
  assert.equal(currencyForCountry('US'), 'USD')
  assert.equal(currencyForCountry('FR'), 'EUR')
  assert.equal(currencyForCountry('DE'), 'EUR')
  assert.equal(currencyForCountry('JP'), 'JPY')
  // Case and surrounding space come from form input, not from a normalized store.
  assert.equal(currencyForCountry(' th '), 'THB')
  assert.equal(currencyForCountry('th'), 'THB')
})

test('a country with no supported currency proposes nothing rather than USD', () => {
  // Mexico, Brazil and the UAE are real countries this platform cannot price in
  // yet. Answering USD for them is the bug, not the fallback.
  for (const country of ['MX', 'BR', 'AE', 'ZA', 'NG']) {
    assert.equal(currencyForCountry(country), null, `${country} must not propose a currency`)
  }
  assert.equal(currencyForCountry(''), null)
  assert.equal(currencyForCountry(null), null)
  assert.equal(currencyForCountry(undefined), null)
  assert.equal(currencyForCountry('not a country'), null)
})

test('every proposed currency is one the platform supports', () => {
  for (const country of ['TH', 'US', 'GB', 'JP', 'AU', 'CA', 'SG', 'HK', 'MY', 'ID', 'PH', 'VN', 'IN', 'IE', 'PT']) {
    const currency = currencyForCountry(country)
    assert.ok(currency && isCurrencyCode(currency), `${country} proposed an unsupported ${currency}`)
    assert.ok((SUPPORTED_CURRENCIES as readonly string[]).includes(currency))
  }
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

