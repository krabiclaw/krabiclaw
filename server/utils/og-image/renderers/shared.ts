import type { SocialCardRenderPayload } from '~/utils/social-metadata'
import { node, type SatoriNode } from '../satori-node.ts'
import { OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT } from '~/utils/social-metadata'

export interface OgImageCardVariant {
  /** Label/badge accent color. */
  accentColor: string
}

const TITLE_MAX_CHARS = 90
const DESCRIPTION_MAX_CHARS = 140

function clip(text: string | null | undefined, max: number): string {
  if (!text) return ''
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`
}

export interface RenderInputs extends SocialCardRenderPayload {
  backgroundImageDataUri: string
  logoDataUri?: string | null
}

/**
 * Shared 1200×630 card layout used by every template renderer. Templates differ only in
 * accent (see renderers/platform.ts and tenant.ts) — the structure itself
 * (background photo + legibility overlay, label pill, title, description, brand footer)
 * is the one shape every generated OG image follows, matching ADR 0010's template-driven
 * (not per-page) rendering approach.
 */
export function buildOgImageCard(payload: RenderInputs, variant: OgImageCardVariant): SatoriNode {
  const background = node('img', {
    position: 'absolute',
    top: 0,
    left: 0,
    width: OG_IMAGE_WIDTH,
    height: OG_IMAGE_HEIGHT,
    objectFit: 'cover',
  }, undefined, { src: payload.backgroundImageDataUri })

  const overlay = node('div', {
    position: 'absolute',
    top: 0,
    left: 0,
    width: OG_IMAGE_WIDTH,
    height: OG_IMAGE_HEIGHT,
    backgroundImage: 'linear-gradient(0deg, rgba(15,23,42,0.92) 0%, rgba(15,23,42,0.55) 55%, rgba(15,23,42,0.25) 100%)',
    display: 'flex',
  })

  const headerRow = node(
    'div',
    { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12 },
    [
      payload.label
        ? node(
            'div',
            {
              display: 'flex',
              backgroundColor: variant.accentColor,
              color: '#0f172a',
              fontSize: 22,
              fontWeight: 700,
              padding: '6px 18px',
              borderRadius: 999,
            },
            clip(payload.label, 40),
          )
        : false,
      payload.location
        ? node('div', { display: 'flex', color: 'rgba(255,255,255,0.75)', fontSize: 22 }, clip(payload.location, 60))
        : false,
    ],
  )

  const titleNode = node(
    'div',
    {
      display: 'flex',
      color: '#ffffff',
      fontSize: 58,
      fontWeight: 700,
      lineHeight: 1.15,
      marginTop: 20,
      maxWidth: 1040,
    },
    clip(payload.title, TITLE_MAX_CHARS),
  )

  const descriptionNode = payload.description
    ? node(
        'div',
        {
          display: 'flex',
          color: 'rgba(255,255,255,0.85)',
          fontSize: 28,
          lineHeight: 1.4,
          marginTop: 18,
          maxWidth: 980,
        },
        clip(payload.description, DESCRIPTION_MAX_CHARS),
      )
    : false

  const brandRow = node(
    'div',
    { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 36 },
    [
      // No logo means no mark. An accent-coloured square here is not the
      // business's mark; it shipped to social previews looking deliberate.
      payload.logoDataUri
        ? node(
            'img',
            { width: 44, height: 44, borderRadius: 8, objectFit: 'contain' },
            undefined,
            { src: payload.logoDataUri, width: 44, height: 44 },
          )
        : false,
      node(
        'div',
        { display: 'flex', color: '#ffffff', fontSize: 26, fontWeight: 700 },
        clip(payload.organizationName, 60),
      ),
    ],
  )

  const content = node(
    'div',
    {
      position: 'absolute',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'flex-end',
      top: 0,
      left: 0,
      width: OG_IMAGE_WIDTH,
      height: OG_IMAGE_HEIGHT,
      padding: 64,
    },
    [headerRow, titleNode, descriptionNode, brandRow],
  )

  return node(
    'div',
    {
      display: 'flex',
      position: 'relative',
      width: OG_IMAGE_WIDTH,
      height: OG_IMAGE_HEIGHT,
      fontFamily: 'Inter',
    },
    [background, overlay, content],
  )
}
