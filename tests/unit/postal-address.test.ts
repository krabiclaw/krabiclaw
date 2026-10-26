import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePostalAddress, postalAddressFromAnswers } from '../../utils/postal-address.ts'

test('postal addresses retain all supported Google business fields and ordered address lines', () => {
  const address = {
    regionCode: 'TH',
    addressLines: ['157 Moo 3', 'Khlong Muang Road', 'Nong Thale'],
    languageCode: 'en',
    locality: 'Krabi',
    sublocality: 'Nong Thale',
    administrativeArea: 'Krabi',
    postalCode: '81000',
  }
  assert.deepEqual(parsePostalAddress(address), address)
  assert.deepEqual(parsePostalAddress(JSON.stringify(address)), address)
})

test('postal addresses preserve absent and blank optional values without inventing content', () => {
  for (const value of [null, undefined, '']) assert.equal(parsePostalAddress(value), null)
  assert.deepEqual(parsePostalAddress({ regionCode: 'US', addressLines: ['123 Shore Road', ' '], locality: null, postalCode: '' }), {
    regionCode: 'US', addressLines: ['123 Shore Road'],
  })
})

test('postal addresses reject malformed country-code formats and unsupported fields', () => {
  for (const regionCode of ['', 'us', 'USA', 'U', '1A', ' US ', null]) {
    assert.throws(() => parsePostalAddress({ regionCode, addressLines: ['123 Shore Road'] }), /regionCode uses two uppercase letters/)
  }
  assert.throws(() => parsePostalAddress({ regionCode: 'US', addressLines: ['123 Shore Road'], streetAddress: 'discarded before' }), /does not support streetAddress/)
})

test('location answers use the same postal-address validation after assembling their address', () => {
  const answers = { streetAddress: '123 Shore Road', addressLine2: null, city: 'Santa Monica', region: 'CA', postalCode: '90401', country: 'US' }
  assert.deepEqual(postalAddressFromAnswers(answers), {
    regionCode: 'US', addressLines: ['123 Shore Road'], locality: 'Santa Monica', administrativeArea: 'CA', postalCode: '90401',
  })
  assert.throws(() => postalAddressFromAnswers({ ...answers, country: 'USA' }), /regionCode uses two uppercase letters/)
  assert.equal(postalAddressFromAnswers({ ...answers, streetAddress: null, city: null, region: null }), null)
})
