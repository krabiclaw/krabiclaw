// A site's recipe: the choices that make every customer site look like itself
// rather than like its vertical — button shape, casing and color, and heading
// casing. Each is stored in organization settings_json.config under its key,
// is optional, and when absent the default in assets/css/tenant.css applies.
// This is the one list: settings validation, the stored-config reader, tenant
// resolution and the MCP schema all read it.

export const SITE_RECIPE_OPTIONS = {
  button_shape: ['pill', 'rounded', 'sharp'],
  button_casing: ['uppercase', 'none'],
  button_color: ['action', 'accent'],
  heading_casing: ['uppercase', 'none'],
} as const

export type SiteRecipeKey = keyof typeof SITE_RECIPE_OPTIONS
export type SiteRecipe = { [K in SiteRecipeKey]?: typeof SITE_RECIPE_OPTIONS[K][number] }

export const SITE_RECIPE_KEYS = Object.keys(SITE_RECIPE_OPTIONS) as SiteRecipeKey[]

/** What MCP and the dashboard say each choice does. */
export const SITE_RECIPE_DESCRIPTIONS: Record<SiteRecipeKey, string> = {
  button_shape: 'Button corner styling: pill (fully rounded), rounded (subtle radius), or sharp (square corners).',
  button_casing: 'Button text casing: uppercase or none (natural case).',
  button_color: "Button fill: action (the palette's action color) or accent (the palette's accent color).",
  heading_casing: 'Display heading casing: uppercase or none (natural case).',
}

export function isSiteRecipeKey(key: string): key is SiteRecipeKey {
  return Object.hasOwn(SITE_RECIPE_OPTIONS, key)
}

export function isSiteRecipeValue<K extends SiteRecipeKey>(key: K, value: unknown): value is typeof SITE_RECIPE_OPTIONS[K][number] {
  return typeof value === 'string' && (SITE_RECIPE_OPTIONS[key] as readonly string[]).includes(value)
}

/**
 * A stored recipe, read strictly: an absent choice is absent, and a stored value
 * outside the list is an error rather than a silently dropped setting.
 */
export function parseSiteRecipe(stored: Partial<Record<SiteRecipeKey, unknown>>): SiteRecipe {
  const recipe: SiteRecipe = {}
  for (const key of SITE_RECIPE_KEYS) {
    const value = stored[key]
    if (value === null || value === undefined) continue
    if (!isSiteRecipeValue(key, value)) throw new Error(`Invalid stored site setting: ${key}`)
    ;(recipe as Record<SiteRecipeKey, string>)[key] = value
  }
  return recipe
}

/** CSS custom properties a public layout carries for its recipe overrides. */
export function siteRecipeStyle(recipe?: SiteRecipe): Record<string, string> {
  if (!recipe) return {}
  const style: Record<string, string> = {}
  if (recipe.button_shape === 'pill') style['--site-button-radius'] = '9999px'
  else if (recipe.button_shape === 'rounded') style['--site-button-radius'] = '0.5rem'
  else if (recipe.button_shape === 'sharp') style['--site-button-radius'] = '0px'

  if (recipe.button_casing === 'uppercase') {
    style['--site-button-transform'] = 'uppercase'
    style['--site-button-tracking'] = '0.05em'
    style['--site-button-weight'] = '600'
  } else if (recipe.button_casing === 'none') {
    style['--site-button-transform'] = 'none'
    style['--site-button-tracking'] = 'normal'
    style['--site-button-weight'] = '500'
  }

  if (recipe.button_color === 'accent') {
    style['--site-button-bg'] = 'var(--site-accent)'
    style['--site-button-text'] = 'var(--site-on-accent)'
  } else if (recipe.button_color === 'action') {
    style['--site-button-bg'] = 'var(--site-action)'
    style['--site-button-text'] = 'var(--site-on-action)'
  }

  if (recipe.heading_casing === 'uppercase') style['--site-display-transform'] = 'uppercase'
  else if (recipe.heading_casing === 'none') style['--site-display-transform'] = 'none'
  return style
}
