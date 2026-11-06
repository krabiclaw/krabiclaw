import assert from 'node:assert/strict'
import { test } from 'node:test'
import { siteRecipeStyle } from '../../shared/site-recipe.ts'


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


