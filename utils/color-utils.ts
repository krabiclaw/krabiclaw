/**
 * Color utility functions for site palette configurability
 * Handles color manipulation, dark mode variants, and WCAG contrast compliance
 */

/**
 * Parse hex color to RGB values
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{3}|[a-f\d]{6})$/i.exec(hex)
  if (!result || !result[1]) return null

  let hexValue = result[1]
  if (hexValue.length === 3) {
    hexValue = hexValue.split('').map(c => c + c).join('')
  }

  const r = parseInt(hexValue.slice(0, 2), 16)
  const g = parseInt(hexValue.slice(2, 4), 16)
  const b = parseInt(hexValue.slice(4, 6), 16)

  return { r, g, b }
}

/**
 * Calculate relative luminance of a color (WCAG standard)
 */
export function getLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map(c => {
    const normalized = c / 255
    return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * (rs ?? 0) + 0.7152 * (gs ?? 0) + 0.0722 * (bs ?? 0)
}

/**
 * Calculate contrast ratio between two colors (WCAG standard)
 */
export function getContrastRatio(color1: string, color2: string): number {
  const rgb1 = hexToRgb(color1)
  const rgb2 = hexToRgb(color2)
  if (!rgb1 || !rgb2) return 0

  const lum1 = getLuminance(rgb1.r, rgb1.g, rgb1.b)
  const lum2 = getLuminance(rgb2.r, rgb2.g, rgb2.b)
  const lighter = Math.max(lum1, lum2)
  const darker = Math.min(lum1, lum2)

  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * The label for a filled control: white on any saturated or dark fill, black
 * only on a light one. A brand red or gold takes white even where black
 * scores a higher WCAG ratio; paletteContrast reports the ratio either way.
 */
export function getOptimalForeground(backgroundColor: string): '#ffffff' | '#000000' {
  const rgb = hexToRgb(backgroundColor)
  if (!rgb) throw new Error(`Not a hex color: ${backgroundColor}`)
  return getLuminance(rgb.r, rgb.g, rgb.b) > 0.4 ? '#000000' : '#ffffff'
}

/**
 * Lighten a hex color by a percentage
 */
export function lightenColor(hex: string, percent: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex

  const factor = 1 + percent / 100
  const r = Math.min(255, Math.round(rgb.r * factor))
  const g = Math.min(255, Math.round(rgb.g * factor))
  const b = Math.min(255, Math.round(rgb.b * factor))

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

/**
 * Calculate dark mode variant of a color
 * Lightens the color for dark mode to maintain visual hierarchy
 */
export function getDarkModeVariant(hex: string): string {
  return lightenColor(hex, 30)
}

/**
 * Natural language color interpretation
 * Maps descriptive color terms to appropriate hex codes
 */
const COLOR_MAPPINGS: Record<string, string> = {
  // Earthy tones
  'earthy': '#78350F',
  'terracotta': '#C27803',
  'clay': '#B45309',
  'brown': '#78350F',
  'tan': '#D4A574',
  'beige': '#F5F5DC',
  'sand': '#E8D4B8',
  'warm brown': '#8B4513',
  'rust': '#B7410E',
  'copper': '#B87333',
  'bronze': '#CD7F32',
  
  // Blue tones
  'ocean blue': '#1E40AF',
  'sky blue': '#0EA5E9',
  'navy': '#1E3A8A',
  'teal': '#0D9488',
  'cyan': '#06B6D4',
  'azure': '#0284C7',
  'cobalt': '#0047AB',
  
  // Green tones
  'forest green': '#166534',
  'sage': '#4A7C59',
  'olive': '#556B2F',
  'emerald': '#10B981',
  'mint': '#34D399',
  'lime': '#84CC16',
  
  // Red tones
  'red': '#DC2626',
  'crimson': '#DC143C',
  'burgundy': '#800020',
  'maroon': '#800000',
  'rose': '#E11D48',
  'coral': '#FF6B6B',
  
  // Purple tones
  'purple': '#7C3AED',
  'lavender': '#A78BFA',
  'violet': '#8B5CF6',
  'plum': '#9333EA',
  'indigo': '#4F46E5',
  
  // Orange tones
  'orange': '#F97316',
  'amber': '#F59E0B',
  'gold': '#EAB308',
  'peach': '#FB923C',
  'apricot': '#FB923C',
  
  // Yellow tones
  'yellow': '#EAB308',
  'mustard': '#CA8A04',
  
  // Pink tones
  'pink': '#EC4899',
  'magenta': '#D946EF',
  'fuchsia': '#E879F9',
  'blush': '#FDA4AF',
  
  // Gray tones
  'gray': '#6B7280',
  'charcoal': '#374151',
  'slate': '#475569',
  'silver': '#9CA3AF',
  
  // Neutral
  'black': '#000000',
  'white': '#FFFFFF',
  'cream': '#FEF3C7',
  'ivory': '#FFFFF0',
}

/**
 * Interpret natural language color description and return hex code
 * Supports compound descriptions like "warm terracotta", "deep ocean blue"
 */
export function interpretColorDescription(description: string): string | null {
  const lowerDesc = description.toLowerCase().trim()
  
  // Check for exact matches first
  if (COLOR_MAPPINGS[lowerDesc]) {
    return COLOR_MAPPINGS[lowerDesc]
  }
  
  // Check for compound descriptions (e.g., "warm terracotta")
  const words = lowerDesc.split(/\s+/)
  for (const word of words) {
    if (COLOR_MAPPINGS[word]) {
      return COLOR_MAPPINGS[word]
    }
  }
  
  // Check for partial matches with minimum length requirement
  for (const [key, value] of Object.entries(COLOR_MAPPINGS)) {
    if ((lowerDesc.includes(key) && key.length >= 3) || (key.includes(lowerDesc) && lowerDesc.length >= 3)) {
      return value
    }
  }
  
  // No mapping found - signal invalid input to caller
  return null
}

/**
 * Smart color resolver - accepts hex codes or natural language
 */
export function resolveColor(input: string): string | null {
  // A #RRGGBB or #RGB hex code is returned as #RRGGBB.
  const rgb = /^#([a-f\d]{3}|[a-f\d]{6})$/i.test(input.trim()) ? hexToRgb(input.trim()) : null
  if (rgb) return `#${[rgb.r, rgb.g, rgb.b].map(c => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`

  // Otherwise, try to interpret as natural language
  return interpretColorDescription(input)
}
