import satori, { init as initSatori } from 'satori/standalone'
import { Resvg, type InitInput } from '@resvg/resvg-wasm'
import { OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT, resolveSeoUrl, type SocialCardRenderPayload } from '~/utils/social-metadata'
import { getOgImageFonts } from './fonts.ts'
import { resolveOgImageRenderer } from './renderers/index.ts'
import { fetchTransformedImageAsDataUri } from './fetch-image.ts'
import { ensureResvgInitialized, loadLocalWasmModule } from '~/server/utils/resvg-runtime'
// The brand mark comes from the site's own logo placement (a media asset URL),
// Krabiclaw's site included.
function resolveLogoDataUri(images: ImagesBinding, logoUrl: string | null | undefined, publicOrigin: string): Promise<string | null> {
  return fetchTransformedImageAsDataUri(images, logoUrl ? resolveSeoUrl(logoUrl, publicOrigin) : null, { width: 160, height: 160, fit: 'contain' }, { format: 'image/png' })
}

// initWasm() may only run once per isolate. Cached at module scope so repeated renders in
// the same Worker isolate (or the same test process) reuse the initialized module.
let satoriInit: Promise<void> | null = null

async function loadBundledYogaWasm(): Promise<WebAssembly.Module> {
  if (import.meta.dev) return await loadLocalWasmModule('satori/yoga.wasm')
  const { default: wasmModule } = await import('satori/yoga.wasm')
  return wasmModule
}

async function ensureSatoriInitialized(wasmModule?: InitInput): Promise<void> {
  if (!satoriInit) {
    satoriInit = Promise.resolve(wasmModule ?? loadBundledYogaWasm())
      .then(module => initSatori(module))
      .catch((error) => {
        satoriInit = null
        throw error
      })
  }
  await satoriInit
}

export interface RenderOgImageDeps {
  images: ImagesBinding
  /** Explicit configured origin for root-relative public page media. */
  publicOrigin: string
  /**
   * Tests and local scripts can provide raw bytes. Deployed Workers omit this so Wrangler
   * supplies the statically imported file as a precompiled WebAssembly.Module.
   */
  wasmModule?: InitInput
  yogaModule?: InitInput
}

/** Renders one OG image payload to real, decodable 1200×630 PNG bytes. */
export async function renderOgImagePng(
  payload: SocialCardRenderPayload,
  deps: RenderOgImageDeps,
): Promise<Uint8Array> {
  await Promise.all([
    ensureResvgInitialized(deps.wasmModule),
    ensureSatoriInitialized(deps.yogaModule),
  ])

  const [backgroundImageDataUri, logoDataUri] = await Promise.all([
    fetchTransformedImageAsDataUri(deps.images, resolveSeoUrl(payload.backgroundImageUrl, deps.publicOrigin), {
      width: OG_IMAGE_WIDTH,
      height: OG_IMAGE_HEIGHT,
      fit: 'cover',
    }, {
      format: 'image/jpeg',
      quality: 85,
    }, {
      acceptedContentTypes: ['image/png', 'image/jpeg', 'image/webp'],
    }),
    resolveLogoDataUri(deps.images, payload.logoUrl, deps.publicOrigin),
  ])
  if (!backgroundImageDataUri) {
    throw new Error(`OG page media could not be loaded: ${payload.backgroundImageUrl}`)
  }
  if (payload.logoUrl && !logoDataUri) throw new Error(`OG logo could not be loaded: ${payload.logoUrl}`)
  const renderer = resolveOgImageRenderer(payload.template)
  const tree = renderer({ ...payload, backgroundImageDataUri, logoDataUri })

  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width: OG_IMAGE_WIDTH,
    height: OG_IMAGE_HEIGHT,
    fonts: getOgImageFonts(),
  })

  // Resvg/RenderedImage hold WASM linear memory that isn't GC'd by JS — free()
  // both regardless of outcome so repeated renders in the same Worker isolate
  // (resvgInit is cached at module scope) don't leak memory across requests.
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: OG_IMAGE_WIDTH } })
  try {
    const rendered = resvg.render()
    try {
      return rendered.asPng()
    } finally {
      rendered.free()
    }
  } finally {
    resvg.free()
  }
}
