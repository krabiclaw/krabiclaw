import assert from 'node:assert/strict'
import test from 'node:test'
import { agreementTemplateFields, fillAgreementTemplate } from '~/shared/agreement-templates'

test('a template names only booking fields, and every field it uses must be filled', () => {
  const text = '# Engagement letter\nFor {{client_name}}\n\nOur fee is {{ price }}. {{client_name}} signs below.'
  assert.deepEqual(agreementTemplateFields(text), { fields: ['client_name', 'price'], unknown: null })
  assert.equal(agreementTemplateFields('Hello {{client_nmae}}').unknown, 'client_nmae')
  assert.deepEqual(fillAgreementTemplate(text, { client_name: 'Maria Lopez', price: '$250.00' }), [
    { type: 'heading', text: 'Engagement letter' },
    { type: 'paragraph', text: 'For Maria Lopez' },
    { type: 'paragraph', text: 'Our fee is $250.00. Maria Lopez signs below.' },
  ])
  assert.throws(() => fillAgreementTemplate(text, { client_name: 'Maria Lopez' }), /price has no value/)
})
