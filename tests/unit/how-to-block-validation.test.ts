import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateContentBlockData } from '../../utils/tenant-page-blocks.ts'

test('a stored HowTo has at least one named step; text cannot substitute for its name', () => {
  for (const data of [{}, { steps: [] }, { steps: [{ text: 'Only instructions' }] }, { steps: [{ name: ' ' }] }, { steps: [{ name: null }] }]) {
    assert.throws(() => validateContentBlockData('how_to', data), /requires at least 1 item|name is required/)
  }
  const data = { steps: [{ name: 'Choose a time' }, { name: 'Confirm', text: 'Review the details before booking.' }] }
  assert.deepEqual(validateContentBlockData('how_to', data), data)
})

test('HowTo optional instructions and materials retain their authored types', () => {
  assert.throws(() => validateContentBlockData('how_to', { steps: [{ name: 'Prepare', text: 12 }] }), /text must be a string/)
  assert.throws(() => validateContentBlockData('how_to', { steps: [{ name: 'Prepare' }], tool_items: [12] }), /tool_items must be an array of strings/)
  assert.throws(() => validateContentBlockData('how_to', { steps: [{ name: 'Prepare' }], estimated_time: 12 }), /estimated_time must be a string/)
  const data = { steps: [{ name: 'Prepare', text: null }], tool_items: ['Notebook'], supply_items: [], estimated_time: 'PT5M' }
  assert.deepEqual(validateContentBlockData('how_to', data), data)
})
