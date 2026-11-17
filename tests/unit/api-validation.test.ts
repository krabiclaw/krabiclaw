import assert from 'node:assert/strict'
import test from 'node:test'

import { validateApiArrayItems, validateApiShape } from '../../utils/api-validation.ts'

test('validateApiShape checks required nested fields and primitive types', () => {
  const validate = validateApiShape({
    balance: 'number',
    profile: {
      name: 'string',
    },
  })

  assert.equal(validate({ balance: 10, profile: { name: 'Ada' } }), true)
  assert.equal(validate({ balance: '10', profile: { name: 'Ada' } }), false)
  assert.equal(validate({ balance: 10, profile: {} }), false)

  const nullable = validateApiShape({
    card: 'nullable-object',
    renewal: 'nullable-string',
  })
  assert.equal(nullable({ card: null, renewal: null }), true)
  assert.equal(nullable({ card: [], renewal: null }), false)
})

test('validateApiShape validates every nested array item', () => {
  const validate = validateApiShape({
    rows: {
      arrayOf: {
        id: 'string',
        label: 'nullable-string',
      },
    },
  })

  assert.equal(validate({ rows: [{ id: 'one', label: null }] }), true)
  assert.equal(validate({ rows: [{ id: 'one', label: 'Parent' }] }), true)
  assert.equal(validate({ rows: [{ id: 'one', label: 3 }] }), false)
  assert.equal(validate({ rows: [{ id: 'one' }] }), false)
  assert.equal(validate({ rows: [{ id: 'one', label: undefined }] }), false)
  assert.equal(validate({ rows: [{ label: null }] }), false)

  const records = validateApiArrayItems({ id: 'string', active: 'boolean' })
  assert.equal(records([{ id: 'one', active: true }]), true)
  assert.equal(records([{ id: 'one' }]), false)
})
