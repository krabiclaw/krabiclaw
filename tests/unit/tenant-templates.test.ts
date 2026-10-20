import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isLegalPracticeSite, PLATFORM_THEME_ID, resolvePublicTemplate, TENANT_THEME_ID } from '../../utils/template-registry.ts'
import { siteRecipeStyle } from '../../shared/site-recipe.ts'


test('every customer site resolves to the tenant template, KrabiClaw to the platform', () => {
  for (const vertical of ['restaurant', 'experience', 'lodging', 'service']) {
    const template = resolvePublicTemplate({ themeId: TENANT_THEME_ID, vertical })
    assert.equal(template.slug, 'tenant')
    assert.equal(template.layout, 'tenant')
  }
  // A stored theme id from before the merge is a customer site like any other.
  assert.equal(resolvePublicTemplate({ themeId: 'blawby-theme-v1', vertical: 'service' }).slug, 'tenant')
  assert.equal(resolvePublicTemplate({ themeId: PLATFORM_THEME_ID, vertical: 'service' }).slug, 'platform')
})

test('legal practice routes come from the vertical, and KrabiClaw is never a legal practice', () => {
  assert.equal(resolvePublicTemplate({ vertical: 'service' }).serviceRoutes.offeringsIndex, '/services')
  assert.equal(resolvePublicTemplate({ vertical: 'restaurant' }).serviceRoutes.offeringsIndex, null)
  assert.equal(isLegalPracticeSite({ themeId: TENANT_THEME_ID, vertical: 'service' }), true)
  assert.equal(isLegalPracticeSite({ themeId: PLATFORM_THEME_ID, vertical: 'service' }), false)
  assert.equal(isLegalPracticeSite({ themeId: TENANT_THEME_ID, vertical: 'restaurant' }), false)
})

test('siteRecipeStyle maps recipe tokens to css variables', () => {
  const emptyStyle = siteRecipeStyle()
  assert.deepEqual(emptyStyle, {})

  const customStyle = siteRecipeStyle({
    button_shape: 'pill',
    button_casing: 'uppercase',
    heading_casing: 'uppercase',
  })
  assert.equal(customStyle['--site-button-radius'], '9999px')
  assert.equal(customStyle['--site-button-transform'], 'uppercase')
  assert.equal(customStyle['--site-button-tracking'], '0.05em')
  assert.equal(customStyle['--site-button-weight'], '600')
  assert.equal(customStyle['--site-display-transform'], 'uppercase')

  const roundedStyle = siteRecipeStyle({
    button_shape: 'rounded',
  })
  assert.equal(roundedStyle['--site-button-radius'], '0.5rem')

  const sharpStyle = siteRecipeStyle({
    button_shape: 'sharp',
    button_casing: 'none',
    heading_casing: 'none',
  })
  assert.equal(sharpStyle['--site-button-radius'], '0px')
  assert.equal(sharpStyle['--site-button-transform'], 'none')
  assert.equal(sharpStyle['--site-button-tracking'], 'normal')
  assert.equal(sharpStyle['--site-button-weight'], '500')
  assert.equal(sharpStyle['--site-display-transform'], 'none')

  const accentStyle = siteRecipeStyle({ button_color: 'accent' })
  assert.equal(accentStyle['--site-button-bg'], 'var(--site-accent)')
  assert.equal(accentStyle['--site-button-text'], 'var(--site-on-accent)')
})


