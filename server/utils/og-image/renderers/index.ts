import type { SocialTemplate } from '~/utils/social-metadata'
import type { SatoriNode } from '../satori-node.ts'
import type { RenderInputs } from './shared.ts'
import { renderPlatformCard } from './platform.ts'
import { renderTenantCard } from './tenant.ts'

export type OgImageRenderer = (_payload: RenderInputs) => SatoriNode

/**
 * Template registry for OG image rendering — like utils/template-registry.ts, the
 * render pipeline dispatches on `template`, never on scattered per-page checks.
 */
export const ogImageRenderers: Record<SocialTemplate, OgImageRenderer> = {
  platform: renderPlatformCard,
  tenant: renderTenantCard,
}

export function resolveOgImageRenderer(template: string): OgImageRenderer {
  if (!Object.hasOwn(ogImageRenderers, template)) {
    throw new Error(`Unsupported OG image template: ${template}`)
  }
  const renderer = ogImageRenderers[template as SocialTemplate]
  return renderer
}
