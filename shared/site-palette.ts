import { getContrastRatio, getOptimalForeground } from '../utils/color-utils.ts'

// A site's colors: six roles, each with a light and a dark value. Everything
// else a theme paints (borders, tints, inverted bands, hover states) is derived
// from these in the theme's CSS, so an owner never has to balance a border.
export const SITE_PALETTE_ROLES = [
  { role: 'ground', label: 'Ground', rule: 'The page background.' },
  { role: 'surface', label: 'Surface', rule: 'Cards, the header and footer, dialogs and fields.' },
  { role: 'text', label: 'Text', rule: 'Body copy and headings.' },
  { role: 'muted', label: 'Secondary text', rule: 'Captions, details and supporting copy.' },
  { role: 'action', label: 'Action', rule: 'Buttons, links and selected states.' },
  { role: 'accent', label: 'Accent', rule: 'Emphasis, decoration and highlighted buttons.' },
] as const

export type SitePaletteRole = typeof SITE_PALETTE_ROLES[number]['role']
export type SitePaletteMode = 'light' | 'dark'
export type SitePaletteColors = Record<SitePaletteRole, string>
export interface SitePalette { light: SitePaletteColors; dark: SitePaletteColors }

export const SITE_PALETTE_MODES: readonly SitePaletteMode[] = ['light', 'dark']
const ROLE_NAMES = SITE_PALETTE_ROLES.map(entry => entry.role)
const HEX = /^#[0-9a-f]{6}$/i

function parseColors(value: unknown, path: string): SitePaletteColors {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object of colors`)
  const entries = Object.entries(value as Record<string, unknown>)
  for (const [key] of entries) if (!ROLE_NAMES.includes(key as SitePaletteRole)) throw new Error(`${path}.${key} is not a palette role`)
  return Object.fromEntries(ROLE_NAMES.map((role) => {
    const color = (value as Record<string, unknown>)[role]
    if (typeof color !== 'string' || !HEX.test(color)) throw new Error(`${path}.${role} must be a #RRGGBB color`)
    return [role, color.toUpperCase()]
  })) as SitePaletteColors
}

/** A complete stored palette, or a visible error naming what is wrong. */
export function parseSitePalette(value: unknown): SitePalette {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('palette must be an object with light and dark colors')
  for (const key of Object.keys(value)) if (key !== 'light' && key !== 'dark') throw new Error(`palette.${key} is not a palette mode`)
  const palette = value as Record<string, unknown>
  return { light: parseColors(palette.light, 'palette.light'), dark: parseColors(palette.dark, 'palette.dark') }
}

const palette = (light: SitePaletteColors, dark: SitePaletteColors): SitePalette => ({ light, dark })
const colors = (ground: string, surface: string, text: string, muted: string, action: string, accent: string): SitePaletteColors =>
  ({ ground, surface, text, muted, action, accent })

// What every customer site wears until its owner chooses its own colors. Its
// light action is a deeper coral than the platform's, which read at 2.7:1 on white.
export const DEFAULT_SITE_PALETTE: SitePalette = palette(
  colors('#FFFFFF', '#FAFAFA', '#18181B', '#52525B', '#C8452E', '#6366F1'),
  colors('#09090B', '#121216', '#F4F4F5', '#D4D4D8', '#FB7461', '#818CF8'),
)

export const STARTER_PALETTES = [
  { id: 'coastal', label: 'Coastal', palette: palette(
    colors('#FAF6EF', '#FFFFFF', '#24282B', '#5B6166', '#0F766E', '#E0694F'),
    colors('#0F1A1C', '#16252A', '#ECEFEA', '#A9B5B3', '#2DD4BF', '#F08A6E')) },
  { id: 'forest', label: 'Forest', palette: palette(
    colors('#F4F7F2', '#FFFFFF', '#1B2A1F', '#4F6354', '#2F6B3B', '#B07A22'),
    colors('#0E1711', '#15221A', '#E6EFE7', '#A3B5A7', '#6FCF86', '#E0B25A')) },
  { id: 'terracotta', label: 'Terracotta', palette: palette(
    colors('#FBF5F0', '#FFFFFF', '#2B1D17', '#6B5146', '#A84C25', '#2F6D6A'),
    colors('#1A120E', '#241914', '#F3E9E2', '#C3ADA2', '#EE8A5F', '#6FC2BC')) },
  { id: 'ink', label: 'Ink', palette: palette(
    colors('#FFFFFF', '#F6F6F7', '#111114', '#55555E', '#111114', '#8F1D21'),
    colors('#0B0B0D', '#151518', '#F4F4F5', '#A9A9B2', '#F4F4F5', '#E5676B')) },
  { id: 'blossom', label: 'Blossom', palette: palette(
    colors('#FFF7F9', '#FFFFFF', '#2A1B22', '#6A5560', '#B03063', '#6E50C0'),
    colors('#1A1015', '#24161D', '#F6E9EF', '#C7AEB9', '#F07AA6', '#B5A0F0')) },
  { id: 'saffron', label: 'Saffron', palette: palette(
    colors('#FFFBF2', '#FFFFFF', '#2A2210', '#665A3C', '#955300', '#1F6F8B'),
    colors('#17130A', '#221C0F', '#F5EEDC', '#C2B593', '#F2B13C', '#6CC3E0')) },
  { id: 'slate', label: 'Slate', palette: palette(
    colors('#F7F9FC', '#FFFFFF', '#152033', '#4D5A70', '#1D4ED8', '#0E8C7E'),
    colors('#0C121D', '#131B2A', '#E7ECF5', '#A3AEC2', '#7AA2FF', '#4FD1C0')) },
  { id: 'midnight', label: 'Midnight', palette: palette(
    colors('#F6F5F2', '#FFFFFF', '#1C1B22', '#5A5866', '#4B3FA0', '#9A7632'),
    colors('#0E0D14', '#17161F', '#EDEBF5', '#ADAAC0', '#A89BFF', '#D9B66C')) },
] as const

export type StarterPaletteId = typeof STARTER_PALETTES[number]['id']

export function starterPalette(id: string): SitePalette {
  const starter = STARTER_PALETTES.find(entry => entry.id === id)
  if (!starter) throw new Error(`Unknown starter palette: ${id}`)
  return starter.palette
}

/** The palette a customer site renders: its own, or the default when it has none. */
export function resolveSitePalette(stored: SitePalette | undefined): SitePalette {
  return stored ?? DEFAULT_SITE_PALETTE
}

export interface PaletteContrastCheck { mode: SitePaletteMode; pair: string; ratio: number; minimum: number }

// The pairs a reader depends on, with WCAG AA minimums: 4.5 for normal text,
// 3 for the action color as a control boundary and large text.
export function paletteContrast(value: SitePalette): PaletteContrastCheck[] {
  return SITE_PALETTE_MODES.flatMap((mode) => {
    const c = value[mode]
    const check = (pair: string, a: string, b: string, minimum: number) =>
      ({ mode, pair, ratio: Math.round(getContrastRatio(a, b) * 10) / 10, minimum })
    return [
      check('text on ground', c.text, c.ground, 4.5),
      check('text on surface', c.text, c.surface, 4.5),
      check('secondary text on ground', c.muted, c.ground, 4.5),
      check('secondary text on surface', c.muted, c.surface, 4.5),
      check('action on ground', c.action, c.ground, 3),
      check('button label on action', getOptimalForeground(c.action), c.action, 4.5),
      check('button label on accent', getOptimalForeground(c.accent), c.accent, 4.5),
    ]
  })
}

/** CSS custom properties a public layout root carries for its palette. */
export function sitePaletteStyle(value: SitePalette): Record<string, string> {
  const style: Record<string, string> = {}
  for (const mode of SITE_PALETTE_MODES) {
    for (const role of ROLE_NAMES) style[`--site-${role}-${mode}`] = value[mode][role]
    // Text on an action- or accent-filled control: whichever of black or white reads.
    style[`--site-on-action-${mode}`] = getOptimalForeground(value[mode].action)
    style[`--site-on-accent-${mode}`] = getOptimalForeground(value[mode].accent)
  }
  return style
}

/**
 * A change to a site's palette: start from a starter (or the site's current
 * palette) and replace any roles named per mode. CMS saves send whole modes;
 * MCP may name one color.
 */
export interface SitePalettePatch {
  starter?: string
  light?: Partial<Record<SitePaletteRole, string>>
  dark?: Partial<Record<SitePaletteRole, string>>
}

export function applySitePalettePatch(current: SitePalette, patch: SitePalettePatch): SitePalette {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('palette must be an object, or null to reset')
  for (const key of Object.keys(patch)) if (key !== 'starter' && key !== 'light' && key !== 'dark') throw new Error(`palette.${key} is not a palette field`)
  const base = patch.starter === undefined ? current : starterPalette(patch.starter)
  return parseSitePalette({
    light: { ...base.light, ...patch.light },
    dark: { ...base.dark, ...patch.dark },
  })
}
