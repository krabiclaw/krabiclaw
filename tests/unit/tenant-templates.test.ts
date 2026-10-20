import assert from 'node:assert/strict'
import { test } from 'node:test'
import { publicTemplateRegistry, resolvePublicTemplate } from '../../utils/template-registry.ts'
import { siteRecipeStyle } from '../../shared/site-recipe.ts'


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
  assert.equal(blawbyTemplate.serviceRoutes.articleDetailPrefix, '/blog')
})

test('all templates use the canonical /blog article route', () => {
  for (const template of Object.values(publicTemplateRegistry)) {
    assert.equal(template.serviceRoutes.articleDetailPrefix, '/blog')
    assert.equal(template.serviceRoutes.articleIndex, '/blog')
  }
})

test('siteRecipeStyle maps recipe tokens to css variables', () => {
  const emptyStyle = siteRecipeStyle()
  assert.deepEqual(emptyStyle, {})

  const customStyle = siteRecipeStyle({
    buttonShape: 'pill',
    buttonCasing: 'uppercase',
    headingCasing: 'uppercase',
  })
  assert.equal(customStyle['--site-button-radius'], '9999px')
  assert.equal(customStyle['--site-button-transform'], 'uppercase')
  assert.equal(customStyle['--site-button-tracking'], '0.05em')
  assert.equal(customStyle['--site-button-weight'], '600')
  assert.equal(customStyle['--site-display-transform'], 'uppercase')

  const roundedStyle = siteRecipeStyle({
    buttonShape: 'rounded',
  })
  assert.equal(roundedStyle['--site-button-radius'], '0.5rem')

  const sharpStyle = siteRecipeStyle({
    buttonShape: 'sharp',
    buttonCasing: 'none',
    headingCasing: 'none',
  })
  assert.equal(sharpStyle['--site-button-radius'], '0px')
  assert.equal(sharpStyle['--site-button-transform'], 'none')
  assert.equal(sharpStyle['--site-button-tracking'], 'normal')
  assert.equal(sharpStyle['--site-button-weight'], '500')
  assert.equal(sharpStyle['--site-display-transform'], 'none')
})


