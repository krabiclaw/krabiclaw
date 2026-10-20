import assert from 'node:assert/strict'
import test from 'node:test'
import { assertProductKind, patchProductDetails, productDetailFields, validateProductDetails, ProductDetailError } from '../../shared/product-details.ts'

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

test('focused detail edits distinguish an explicit no, an omitted answer and a cleared answer', () => {
  const saved = { featured: true, house_rules: 'Leave muddy shoes outside.', your_property: 'A sheltered terrace.', pets_allowed: true }
  assert.deepEqual(patchProductDetails('stay', saved, { pets_allowed: false, events_allowed: true }, 'merge'), {
    ...saved, pets_allowed: false, events_allowed: true,
  })
  assert.deepEqual(patchProductDetails('stay', saved, { pets_allowed: null }, 'merge'), {
    featured: true, house_rules: 'Leave muddy shoes outside.', your_property: 'A sheltered terrace.',
  })
  assert.deepEqual(patchProductDetails('stay', saved), saved)
  assert.equal(saved.pets_allowed, true)
})

test('complete detail replacement retains featured while merge clearing remains explicit', () => {
  const saved = { featured: true, house_rules: 'Shoes outside.', pets_allowed: false }
  assert.deepEqual(patchProductDetails('stay', saved, { house_rules: 'Shoes by the door.' }), { featured: true, house_rules: 'Shoes by the door.' })
  assert.deepEqual(patchProductDetails('stay', saved, { featured: false }, 'replace'), { featured: false })
  assert.throws(() => patchProductDetails('stay', saved, { pets_allowed: null }), /boolean/)
  assert.throws(() => patchProductDetails('stay', saved, { house_rules: null }, 'replace'), /string/)
  assert.throws(() => patchProductDetails('stay', saved, { unknown: null } as never, 'merge'), /not a field/)
  assert.throws(() => patchProductDetails('service', {}, { pets_allowed: null }, 'merge'), /not a field for service/)
  assert.throws(() => patchProductDetails('stay', saved, undefined, 'merge'), /details_mode requires details/)
  assert.throws(() => patchProductDetails('stay', saved, {}, 'unknown' as never), /merge or replace/)
})

test('quiet hours require two authored hourly choices and clearing removes the whole answer', () => {
  const saved = { featured: false, quiet_hours: true, quiet_hours_start: '22:00', quiet_hours_end: '07:00' }
  assert.deepEqual(validateProductDetails('stay', saved), saved)
  assert.deepEqual(patchProductDetails('stay', saved, { quiet_hours: false, quiet_hours_start: null, quiet_hours_end: null }, 'merge'), {
    featured: false, quiet_hours: false,
  })
  assert.deepEqual(patchProductDetails('stay', saved, { quiet_hours: null, quiet_hours_start: null, quiet_hours_end: null }, 'merge'), { featured: false })
  assert.throws(() => validateProductDetails('stay', { quiet_hours: true }), /Quiet hours need both a start time and an end time/)
  assert.throws(() => validateProductDetails('stay', { quiet_hours: false, quiet_hours_start: '22:00', quiet_hours_end: '07:00' }), /Quiet hours must be enabled/)
  assert.throws(() => validateProductDetails('stay', { quiet_hours_start: '22:00', quiet_hours_end: '07:00' }), /Quiet hours must be enabled/)
  assert.throws(() => patchProductDetails('stay', saved, { quiet_hours_start: null }, 'merge'), /Quiet hours need both a start time and an end time/)
  assert.throws(() => patchProductDetails('stay', saved, { quiet_hours_start: '22:30' }, 'merge'), /one of/)
  // Translations change the additional prose, never a property's clock or yes/no choice.
  assert.deepEqual(validateProductDetails('stay', { house_rules: 'Leave shoes by the door.' }, true), { house_rules: 'Leave shoes by the door.' })
  assert.throws(() => validateProductDetails('stay', { quiet_hours_start: '22:00' }, true), /not a field/)
  assert.throws(() => validateProductDetails('stay', { pets_allowed: false }, true), /not a field/)
})
