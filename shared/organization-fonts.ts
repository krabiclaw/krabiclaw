// The site font presets: a design choice of heading and body families, kept in
// assets/css/font-presets.css. Thai, Vietnamese and Japanese text renders in any preset
// through the script fallbacks every stack ends with (assets/css/base.css).
export const ORGANIZATION_FONT_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'mali', label: 'Mali' },
  { value: 'sarabun', label: 'Sarabun' },
  { value: 'prompt', label: 'Prompt' },
  { value: 'kanit', label: 'Kanit with Sarabun' },
  { value: 'ibm-plex-sans-thai', label: 'IBM Plex Sans Thai' },
  { value: 'noto-serif-thai', label: 'Noto Serif Thai with Noto Sans Thai' },
  { value: 'inter', label: 'Inter' },
  { value: 'dm-sans', label: 'DM Sans' },
  { value: 'montserrat', label: 'Montserrat' },
  { value: 'lora', label: 'Lora' },
  { value: 'playfair-display', label: 'Playfair Display with Inter' },
  { value: 'cormorant-garamond', label: 'Cormorant Garamond with Inter' },
] as const

export type OrganizationFontPreset = typeof ORGANIZATION_FONT_OPTIONS[number]['value']
export const ORGANIZATION_FONT_PRESETS = ORGANIZATION_FONT_OPTIONS.map(option => option.value)

export function isOrganizationFontPreset(value: unknown): value is OrganizationFontPreset {
  return ORGANIZATION_FONT_PRESETS.includes(value as OrganizationFontPreset)
}

// An absent optional setting means the template's existing typography. Invalid
// stored values are errors, never arbitrary CSS or a substitute font choice.
export function resolveOrganizationFontPreset(value: unknown): OrganizationFontPreset {
  if (value === undefined) return 'default'
  if (!isOrganizationFontPreset(value)) throw new Error('Unsupported organization font preset')
  return value
}
