import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateContentBlockData, createTenantPageBlock } from '../../utils/tenant-page-blocks.ts'
import { validateTenantPageBlock } from '../../utils/tenant-page-editor.ts'

test('an FAQ block requires title for each item', () => {
  const data = {
    title: 'Common Questions',
    source: 'page_qa',
    items: [
      { title: 'What is your consultation fee?', description: 'Initial consultations are free.' },
      { title: 'Do you offer remote appointments?', description: 'Yes, via video call.' },
    ],
  }
  assert.deepEqual(validateContentBlockData('faq', data), data)

  assert.throws(
    () => validateContentBlockData('faq', {
      source: 'page_qa',
      items: [{ description: 'Answer without question' }],
    }),
    /faq\.items\[0\]\.title is required/,
  )
  assert.throws(
    () => validateContentBlockData('faq', { source: 'invalid_source' }),
    /faq\.source must select page_qa or organization_qa/,
  )

  const block = createTenantPageBlock('faq', {
    source: 'page_qa',
    items: [{ title: '', description: 'Some answer' }],
  }, 0)
  const errors = validateTenantPageBlock(block)
  assert.ok(errors.some(err => err.includes('Question 1 needs a question')))
})
