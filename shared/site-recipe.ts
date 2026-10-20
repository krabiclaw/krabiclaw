// Semantic recipe tokens that allow organizations or templates to adjust
// atomic styles (button radius, casing, display headings) via CSS variables.

export interface SiteRecipe {
  buttonShape?: 'pill' | 'rounded' | 'sharp'
  buttonCasing?: 'uppercase' | 'none'
  headingCasing?: 'uppercase' | 'none'
}

/** CSS custom properties a public layout carries for its recipe overrides. */
export function siteRecipeStyle(recipe?: SiteRecipe): Record<string, string> {
  if (!recipe) return {}
  const style: Record<string, string> = {}
  if (recipe.buttonShape === 'pill') {
    style['--site-button-radius'] = '9999px'
  } else if (recipe.buttonShape === 'rounded') {
    style['--site-button-radius'] = '0.5rem'
  } else if (recipe.buttonShape === 'sharp') {
    style['--site-button-radius'] = '0px'
  }

  if (recipe.buttonCasing === 'uppercase') {
    style['--site-button-transform'] = 'uppercase'
    style['--site-button-tracking'] = '0.05em'
    style['--site-button-weight'] = '600'
  } else if (recipe.buttonCasing === 'none') {
    style['--site-button-transform'] = 'none'
    style['--site-button-tracking'] = 'normal'
    style['--site-button-weight'] = '500'
  }

  if (recipe.headingCasing === 'uppercase') {
    style['--site-display-transform'] = 'uppercase'
  } else if (recipe.headingCasing === 'none') {
    style['--site-display-transform'] = 'none'
  }
  return style
}
