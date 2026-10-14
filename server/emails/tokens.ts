/**
 * The product's palette and type scale, for email.
 *
 * Email cannot read CSS variables, so these values are copied from
 * assets/css/base.css and must move with it. Nothing under server/emails/ may
 * write a colour of its own — `lint:email-previews` fails the build on a hex
 * outside this file, because 22 of 23 templates used to carry their own and the
 * result was zinc greys inside a navy-and-cream shell.
 */

export const light = {
  /** --kc-cream */
  bg: '#F8F6F3',
  /** --kc-cream-elev */
  surface: '#FFFFFF',
  /** --kc-navy */
  text: '#1F2547',
  /** --kc-navy-500 */
  textMuted: '#4A5380',
  /** --kc-navy-300 */
  textDimmed: '#8C92B0',
  /** --kc-border */
  border: '#E6E1D9',
} as const

export const dark = {
  /** --ui-bg dark */
  bg: '#0F1225',
  /** --ui-bg-elevated dark */
  surface: '#1F2547',
  /** --ui-text-highlighted dark */
  text: '#F5F4FB',
  /** --ui-text dark */
  textMuted: '#C4C6DE',
  /** --ui-text-muted dark */
  textDimmed: '#A0A3C4',
  /** --kc-navy-700 */
  border: '#2C3360',
} as const

/**
 * Coral marks, never a button: actions are monochrome like the product's,
 * navy on light and white on dark (the light and dark text tokens above).
 */
export const brand = {
  /** --kc-coral */
  primary: '#EE4237',
} as const

/**
 * --font-sans and --font-display, named first so a reader who already has them
 * sees the brand face, each backed by a real system stack for everyone else.
 *
 * Deliberately no webfont request. A stylesheet link in an email tells whoever
 * hosts it when each recipient opened the message and from which address — that
 * is a tracking beacon pointed at a tenant's guests, and most clients strip it
 * anyway, so it would cost privacy and buy almost nothing.
 */
export const font = {
  body: "Poppins, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, Helvetica, sans-serif",
  display: "Fredoka, Poppins, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif",
} as const

/** One content column. 600px is what the reference uses and what clients expect. */
export const layout = {
  width: '600px',
  gutter: '24px',
} as const

export const type = {
  title: 'font-size:30px;line-height:1.2;font-weight:700;letter-spacing:-0.5px',
  sectionTitle: 'font-size:18px;line-height:1.35;font-weight:700',
  body: 'font-size:16px;line-height:1.6',
  label: 'font-size:13px;line-height:1.4;font-weight:600;letter-spacing:0.01em',
  value: 'font-size:16px;line-height:1.45;font-weight:600',
  footer: 'font-size:12px;line-height:1.6',
} as const
