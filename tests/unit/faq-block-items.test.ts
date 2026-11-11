import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  validateContentBlockData,
  createTenantPageBlock,
  CONTENT_BLOCK_TEXT_FIELDS,
  expandContentFieldPath,
  readContentFieldValue,
} from '../../utils/tenant-page-blocks.ts'
import { validateTenantPageBlock } from '../../utils/tenant-page-editor.ts'
import { tenantPageRecordSections, tenantPageRecordTitle } from '../../utils/tenant-page-block-sections.ts'

test('an FAQ block accepts items when source is page_qa', () => {
  const data = {
    title: 'Common Questions',
    source: 'page_qa',
    items: [
      { title: 'What is your consultation fee?', description: 'Initial consultations are free.' },
      { title: 'Do you offer remote appointments?', description: 'Yes, via video call.' },
    ],
  }
  assert.deepEqual(validateContentBlockData('faq', data), data)
})

test('an FAQ block requires title for each item', () => {
  assert.throws(
    () => validateContentBlockData('faq', {
      source: 'page_qa',
      items: [{ description: 'Answer without question' }],
    }),
    /faq\.items\[0\]\.title is required/,
  )

  const block = createTenantPageBlock('faq', {
    source: 'page_qa',
    items: [{ title: '', description: 'Some answer' }],
  }, 0)
  const errors = validateTenantPageBlock(block)
  assert.ok(errors.some(err => err.includes('Question 1 needs a question')))
})

test('an FAQ block validates source enum', () => {
  assert.throws(
    () => validateContentBlockData('faq', { source: 'invalid_source' }),
    /faq\.source must select page_qa or organization_qa/,
  )
})

test('FAQ block record sections and title are tailored for questions', () => {
  assert.deepEqual(tenantPageRecordSections('faq', 'items'), [])
  assert.equal(
    tenantPageRecordTitle({ title: 'How does it work?' }, 'faq', 'items', 0),
    'How does it work?',
  )
  assert.equal(
    tenantPageRecordTitle({}, 'faq', 'items', 2),
    'Question 3',
  )
})

test('FAQ block item text fields are translatable and localized', () => {
  const fields = CONTENT_BLOCK_TEXT_FIELDS.faq
  const paths = fields.map(f => f.path.join('.'))
  assert.ok(paths.includes('title'))
  assert.ok(paths.includes('items.*.title'))
  assert.ok(paths.includes('items.*.description'))

  const blockData = {
    title: 'FAQ',
    source: 'page_qa',
    items: [
      { title: 'Q1', description: 'A1' },
      { title: 'Q2', description: 'A2' },
    ],
  }

  const titleField = fields.find(f => f.path.join('.') === 'items.*.title')!
  const expanded = expandContentFieldPath(blockData, titleField.path)
  assert.equal(expanded.length, 2)
  assert.equal(readContentFieldValue(blockData, expanded[0]!), 'Q1')
  assert.equal(readContentFieldValue(blockData, expanded[1]!), 'Q2')
})
