import assert from 'node:assert/strict'
import test from 'node:test'
import { assertProductKind, productDetailFields, validateProductDetails, ProductDetailError } from '../../shared/product-details.ts'

test('a product kind closes its descriptive fields and defaults to unfeatured', () => {
  assert.equal(assertProductKind('dish'), 'dish')
  assert.throws(() => assertProductKind(undefined), ProductDetailError)
  assert.throws(() => assertProductKind('other'), ProductDetailError)
  assert.deepEqual(validateProductDetails('dish', { allergens: ['Peanuts'], dietary_notes: ['Vegetarian'] }), { featured: false, allergens: ['Peanuts'], dietary_notes: ['Vegetarian'] })
  assert.throws(() => validateProductDetails('dish', { arbitrary: 'value' }), /not a field/)
  assert.throws(() => validateProductDetails('service', { allergens: ['Peanuts'] }), /not a field for service/)
  assert.throws(() => validateProductDetails('item', { meeting_point: 'Gate 3' }), /not a field for item/)
})

test('inclusions and what to bring remain independent customer facts', () => {
  assert.deepEqual(validateProductDetails('experience', { included_items: ['Clay', 'Apron'], what_to_bring: ['Towel'], meeting_point: 'Gate 3\nBy the fountain' }), { featured: false, included_items: ['Clay', 'Apron'], what_to_bring: ['Towel'], meeting_point: 'Gate 3\nBy the fountain' })
  assert(productDetailFields('service').some(field => field.key === 'preparation'))
  assert(productDetailFields('item').some(field => field.key === 'care_instructions'))
})

test('customer facts reject wrong types, blanks, duplicate lists and excessive values', () => {
  assert.throws(() => validateProductDetails('dish', { allergens: 'Peanuts' }), /must be a list/)
  assert.throws(() => validateProductDetails('dish', { allergens: ['Peanuts', 'Peanuts'] }), /distinct/)
  assert.throws(() => validateProductDetails('dish', { allergens: [''] }), /must not be blank/)
  assert.throws(() => validateProductDetails('dish', { tagline: 'two\nlines' }), /single line/)
  assert.throws(() => validateProductDetails('item', { dimensions: 5 }), /must be a string/)
  assert.throws(() => validateProductDetails('item', { care_instructions: 'a'.repeat(10001) }), /at most/)
})

test('stay descriptions preserve multiline content up to the existing product text limit', () => {
  const longText = `${'A'.repeat(9998)}\nZ`
  const details = validateProductDetails('stay', {
    your_property: longText,
    guest_access: '  The courtyard\n  The upstairs terrace\n',
    interaction_with_guests: 'Message us in the guest conversation.',
    other_details_to_note: 'The lane is shared with our neighbours.',
  })
  assert.equal(details.your_property, longText)
  assert.equal(details.guest_access, '  The courtyard\n  The upstairs terrace\n')
  assert.equal(details.interaction_with_guests, 'Message us in the guest conversation.')
  assert.equal(details.other_details_to_note, 'The lane is shared with our neighbours.')
  assert.throws(() => validateProductDetails('stay', { guest_access: `${longText}Z` }), /at most 10000/)
  assert.throws(() => validateProductDetails('service', { your_property: 'A courtyard home.' }), /not a field for service/)
})
