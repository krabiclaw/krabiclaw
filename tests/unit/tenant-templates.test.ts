import assert from 'node:assert/strict'
import { test } from 'node:test'
import { publicTemplateRegistry, resolvePublicTemplate } from '../../utils/template-registry.ts'

test('all tenant templates share the unified tenant layout', () => {
  assert.equal(publicTemplateRegistry.saya.layout, 'tenant')
  assert.equal(publicTemplateRegistry.blawby.layout, 'tenant')
  assert.equal(publicTemplateRegistry.platform.layout, 'platform')
})

test('template resolution correctly resolves templates with unified tenant layout', () => {
  const sayaTemplate = resolvePublicTemplate({ themeId: 'saya-theme-v1' })
  assert.equal(sayaTemplate.slug, 'saya')
  assert.equal(sayaTemplate.layout, 'tenant')

  const blawbyTemplate = resolvePublicTemplate({ themeId: 'blawby-theme-v1' })
  assert.equal(blawbyTemplate.slug, 'blawby')
  assert.equal(blawbyTemplate.layout, 'tenant')
})
