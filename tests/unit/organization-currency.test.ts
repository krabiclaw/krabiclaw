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
  country: '',
  timezone: 'Asia/Bangkok',
  currency: null,
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

test('country is required, and a known time zone is editable in Location', () => {
  assert.equal(step('location').canAdvance, false)
  const known = onboardingFlow({ ...answers, country: 'TH', timezone: '' })
  assert.equal(known.proposedTimezone, 'Asia/Bangkok')
  assert.equal(known.steps.some(entry => entry.id === 'timezone'), false)
  assert.equal(known.steps.find(entry => entry.id === 'location')?.fields.at(-1)?.key, 'timezone')
  assert.equal(step('location', { country: 'TH' }).canAdvance, true)
})

test('the time zone step remains available after answering it', () => {
  const unresolved = onboardingFlow({ ...answers, country: 'US', timezone: '' })
  assert.equal(unresolved.resumeStep, 'timezone')
  assert.equal(unresolved.steps.find(entry => entry.id === 'location')?.fields.some(field => field.key === 'timezone'), false)
  const answered = { ...answers, country: 'US', timezone: 'America/Los_Angeles', timezoneStepVisited: true }
  assert.equal(step('timezone', answered).canAdvance, true)
  assert.equal(onboardingFlow(answered).resumeStep, 'currency')
})

test('currency confirms an editable proposal and finishes the website setup', () => {
  assert.equal(step('currency', { country: 'ZA' }).canAdvance, false)
  assert.equal(step('currency', { country: 'ZA', currency: 'ZAR' }).canAdvance, true)
  assert.equal(step('currency', { country: 'TH' }).canAdvance, true)
  const flow = onboardingFlow({ ...answers, country: 'TH' })
  assert.equal(flow.proposedCurrency, 'THB')
  assert.equal(flow.resumeStep, 'currency')
  assert.deepEqual(flow.steps.map(entry => entry.id), ['type', 'business', 'location', 'language', 'currency'])
  assert.equal(flow.steps.at(-1)?.nextLabel, 'Finish')
})
