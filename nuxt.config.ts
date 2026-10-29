// https://nuxt.com/docs/api/configuration/nuxt-config
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { getIcons } from '@iconify/utils'
import { visualizer } from 'rollup-plugin-visualizer'
import { ROBOTS_DISABLED_DIRECTIVE, ROBOTS_ENABLED_DIRECTIVE } from './shared/robots-directive'
import { localizedPublicRouteAliases } from './build/localized-public-routes'
import { mountBookingRoutes } from './build/booking-routes'
// One source for the entry -> public path map; patch.cjs rewrites the built
// manifest from the same file, so a surface cannot be registered in one place
// and missed in the other.
import publicSurfaceCssPaths from './build/public-surface-css.json'
import {
  claimedRoutesFromHandlers,
  claimedRoutesFromPages,
  mergeClaimedRoutes,
  nonRouteClaimedRoutes,
  type ClaimedRoute,
} from './build/claimed-public-routes'

// Filled by pages:extend and read by nitro:init after server routes are scanned.
let claimedPageRoutes: ClaimedRoute[] = []
const claimedRoutesModulePath = resolve(import.meta.dirname, '.nuxt-generated/claimed-public-routes.mjs')

// nuxt/icon's serverBundle bundles a named collection in full — no usage-based
// tree-shaking. Lucide supplies general UI glyphs; the small local collections
// supply provider logos and original domain pictograms. The client bundle
// includes their data at build time, with no icon API or Worker collection.
const requireFromConfig = createRequire(import.meta.url)
const customIconData = requireFromConfig('./build/icon-data/custom-icons.json')
function pickIcons(collection: string, names: string[]) {
  const data = customIconData[collection]
  if (!data) throw new Error(`No local icon data for collection: ${collection}`)
  const subset = getIcons(data, names, true)
  if (!subset) throw new Error(`Missing icon(s) in local ${collection} data: ${names.join(', ')}`)

  if (subset.not_found && subset.not_found.length > 0) {
    throw new Error(`Missing icon(s) in local ${collection} data: ${subset.not_found.join(', ')}`)
  }

  return subset
}
// Optional build analysis for bundle inspection; it has no runtime effect.
const analyzeBundle = process.env.PERF_BUNDLE_ANALYZE === 'true'
const publicPerfTestPage = process.env.PERF_PUBLIC_TEST_PAGE !== 'false'
const workerWasmExternal = /(?:index_bg|yoga|webp_dec|squoosh_png_bg)\.wasm$/


function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function surfaceCssAssetPath(fileName: string) {
  const basename = fileName.replaceAll('\\', '/').split('/').pop()
  if (!basename) return null

  for (const [sourceName, targetPath] of Object.entries(publicSurfaceCssPaths)) {
    const sourcePattern = new RegExp(`^${escapeRegExp(sourceName)}(?:\\.[A-Za-z0-9_-]+)?\\.css$`)
    if (sourcePattern.test(basename)) {
      return targetPath
    }
  }

  return null
}

function publicSurfaceCssAssetFileName(assetInfo: { name?: string; fileName?: string }) {
  const fileName = assetInfo.name || assetInfo.fileName || ''
  return surfaceCssAssetPath(fileName)
    ? `_nuxt/${surfaceCssAssetPath(fileName)}`
    : '_nuxt/assets/[name]-[hash][extname]'
}

export default defineNuxtConfig({
  modules: [
    '@nuxt/scripts',
    '@nuxtjs/robots',
    '@nuxtjs/sitemap',
    'nuxt-schema-org',
    '@nuxt/ui',
    './build/guest-inbox-hub-dev',
  ],

  ui: {
    colorMode: false,
    // Font faces are the @fontsource packages' own rules, imported by the
    // stylesheets that use them (assets/css/font-presets.css), so a build
    // fetches nothing from a font service.
    fonts: false,
  },

  app: {
    head: {
      htmlAttrs: {
        lang: 'en',
      },
      bodyAttrs: {
        class: 'platform-theme',
      },
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'theme-color', content: '#1F2547' }
      ],
      script: [
        {
          key: 'platform-theme-init',
          innerHTML: "if(document.documentElement.dataset.theme!=='dark'){const p=localStorage.getItem('krabiclaw-theme')||'system';const d=p==='dark'||(p==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d)}",
        },
      ],
      link: [
        // Every tenant hero/content image is served from Cloudflare Images
        // (imagedelivery.net) — a third-party origin the browser otherwise
        // doesn't discover until it parses the <img> tag deep in <body>,
        // paying DNS+TCP+TLS setup serially after that. Preconnecting lets
        // that handshake happen in parallel with initial HTML parsing,
        // which matters most for the LCP image on image-heavy hero pages.
        // No `crossorigin` here deliberately — our <img> tags don't set it
        // either (plain no-cors requests), and Chrome only reuses a
        // preconnected connection when its CORS mode matches the real
        // request; a mismatched crossorigin attribute makes this a no-op.
        { rel: 'preconnect', href: 'https://imagedelivery.net' },
      ],
    },
  },

  alias: {
    '#claimed-public-routes': claimedRoutesModulePath,
  },

  compatibilityDate: '2024-11-01',

  // Each layout links its surface stylesheet (/_nuxt/surfaces/*.css), preloaded
  // by server/plugins/public-resource-hints.ts and cached across pages. Inlining
  // it as well put the whole stylesheet into every HTML response a second time.
  features: {
    inlineStyles: false,
  },

  experimental: {
    // Nuxt 5 consumes this runtime option before the current schema exposes it.
    // @ts-expect-error Nuxt 5 native Nitro mode is required for this Worker.
    nitroViteEnvironment: false,
    defaults: {
      nuxtLink: {
        prefetch: false,
      },
    },
  },
  imports: {
    transform: {
      include: [/node_modules[\\/]@nuxt[\\/]icon[\\/]/],
    },
  },
  debug: false,
  devtools: { enabled: false },
  icon: {
    provider: 'none',
    fallbackToApi: false,
    serverBundle: false,
    clientBundle: {
      scan: {
        globInclude: ['**/*.{vue,jsx,tsx,md,mdc,mdx}', '{composables,shared,utils}/**/*.ts', 'app.config.ts', 'server/utils/dashboard-today.ts'],
      },
      icons: [
        'lucide:menu',
        'lucide:panel-left-close',
        'lucide:panel-left-open',
        'lucide:house',
        'lucide:users',
        'lucide:credit-card',
        'lucide:calendar',
        'lucide:globe',
      ],
    },
    customCollections: [
      pickIcons('simple-icons', ['afterpay', 'airbnb', 'claude', 'facebook', 'google', 'googlemaps', 'instagram', 'klarna', 'modelcontextprotocol', 'openai', 'whatsapp']),
      pickIcons('logos', ['amex', 'apple-pay', 'discord-icon', 'discover', 'facebook', 'google-ads', 'google-analytics', 'google-calendar', 'google-icon', 'google-maps', 'google-pay', 'google-search-console', 'mastercard', 'visa', 'whatsapp-icon']),
      pickIcons('skill-icons', ['instagram']),
      customIconData.krabi,
    ],
  },
  runtimeConfig: {
    public: {
      platformDomain: process.env.NUXT_PUBLIC_PLATFORM_DOMAIN || '',
      freeOrganizationDomain: process.env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN || '',
      appName: process.env.NUXT_PUBLIC_APP_NAME || '',
      siteUrl: process.env.NUXT_PUBLIC_SITE_URL || '',
      helpUrl: process.env.NUXT_PUBLIC_HELP_URL || 'https://krabiclaw.com/help',
      stripePublishableKey: process.env.NUXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '',
      vapidPublicKey: process.env.NUXT_PUBLIC_VAPID_PUBLIC_KEY || '',

      whatsappNumber: process.env.NUXT_PUBLIC_WHATSAPP_NUMBER || process.env.WHATSAPP_NUMBER || '16197200000',
      perfPublicTestPage: publicPerfTestPage,
    },

  },

  vite: {
    // Preserve Vue's concrete server/client mismatch details in production builds.
    define: { __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: true },
    build: {
      modulePreload: false,
      rollupOptions: {
        // Nitro bundles shared modules after Vite; retain their resolved source paths.
        makeAbsoluteExternalsRelative: false,
        external: [workerWasmExternal],
        output: {
          assetFileNames: publicSurfaceCssAssetFileName,
        },
      },
    },
    server: {
      watch: {
        ignored: ['**/.wrangler/**', '**/.data/**', '**/node_modules/**', '**/.git/**', '**/.nuxt/**', '**/.output/**', '**/dist/**']
      },
      allowedHosts: ['.krabiclaw.com']
    },
  },

  hooks: {
    ready(nuxt) {
      const clientComposables = nuxt.options.optimization.treeShake.composables.client
      if (clientComposables.vue) clientComposables.vue = clientComposables.vue.filter(name => name !== 'onServerPrefetch')
    },
    'pages:extend'(pages) {
      pages.push(...localizedPublicRouteAliases(pages))
      mountBookingRoutes(pages)
      // Captured here because this is where the resolved route tree exists. The
      // Worker needs it to answer "does anything already claim this path?" — see
      // build/claimed-public-routes.ts.
      claimedPageRoutes = claimedRoutesFromPages(pages)
    },
    'nitro:config'(nitroConfig) {
      if (typeof nitroConfig.errorHandler !== 'string') throw new Error('Nuxt must provide one native error handler')
      nitroConfig.alias = { ...nitroConfig.alias, '#nuxt-native-error-handler': nitroConfig.errorHandler }
      nitroConfig.errorHandler = resolve(import.meta.dirname, 'server/error-handler.ts')
      nitroConfig.handlers = nitroConfig.handlers?.filter(
        handler => handler.route !== '/api/_nuxt_icon/:collection',
      )
    },
    'nitro:init'(nitro) {
      // Nitro has now scanned both server/api and server/routes.
      // Written to a real file rather than a Nitro virtual module because the
      // page loader is reachable from the Vite SSR graph too (TenantPublicPage
      // imports it), and both builders have to resolve the same artifact.
      const claimed = mergeClaimedRoutes(
        claimedPageRoutes,
        claimedRoutesFromHandlers([...nitro.options.handlers, ...nitro.scannedHandlers]),
        nonRouteClaimedRoutes(),
      )
      mkdirSync(dirname(claimedRoutesModulePath), { recursive: true })
      writeFileSync(claimedRoutesModulePath, `export const CLAIMED_PUBLIC_ROUTES = ${JSON.stringify(claimed)}\n`)
    },
    'vite:extendConfig'(viteConfig, { isClient }) {
      if (analyzeBundle && isClient) {
        viteConfig.plugins?.push(visualizer({
          filename: process.env.PERF_BUNDLE_ANALYZE_OUT || 'bundle-analysis.html',
          template: 'treemap',
          gzipSize: true,
          brotliSize: true,
        }))
      }

    },
  },

  site: {
    url: 'https://krabiclaw.com',
    name: 'KrabiClaw - AI Website Builder',
    description: 'Beautiful websites powered by AI. Build your business website in minutes with our SaaS platform.',
    defaultLocale: 'en',
  },

  schemaOrg: {
    defaults: false,
    reactive: true,
  },

  // Crawler guidance. @nuxtjs/robots owns /robots.txt and the X-Robots-Tag
  // response header, which stays the authoritative indexing control for private
  // routes and non-production hosts. It does not own the `<meta name="robots">`
  // tag: `metaTag: false` leaves that to useSocialMetadata, so one derivation
  // (shared/robots-directive.ts) produces the served directive for every page —
  // CMS-driven and hardcoded alike — instead of two emitters racing through
  // useHead's dedupe. The enabled/disabled values come from the same derivation
  // so the header and the meta tag agree byte for byte.
  robots: {
    metaTag: false,
    robotsEnabledValue: ROBOTS_ENABLED_DIRECTIVE,
    robotsDisabledValue: ROBOTS_DISABLED_DIRECTIVE,
    groups: [
      {
        userAgent: ['*'],
        allow: ['/'],
        disallow: [
          '/api',
          '/auth',
          '/dashboard',
          '/dev',
          '/oauth',
          '/transfer',
          '/accept-invitation',
          '/invite/',
          '/contact/confirmed',
          '/forgot-password',
          '/login',
          '/reservations/cancel',
          '/reservations/confirmed',
          '/reset-password',
          '/signup',
          '/tenant-404',
        ],
      },
    ],
    sitemap: '/sitemap.xml',
  },

  // The shared pages tree is not an SEO inventory. All automatic application
  // sources are disabled; server/plugins/sitemap.ts owns the complete URL set
  // on the original host-aware request event. Shared runtime caching is disabled
  // so a sitemap generated for one hostname can never be reused for another.
  sitemap: {
    excludeAppSources: true,
    cacheMaxAgeSeconds: 0,
    runtimeCacheStorage: false,
  },

  // Components configuration
  components: [
    {
      path: '~/components',
      pattern: '*.vue',
      pathPrefix: false,
    },
    {
      path: '~/components/tenant-pages',
      pathPrefix: false,
    },
    {
      path: '~/components/tenant',
      pathPrefix: false,
    },
    {
      path: '~/components/platform',
      prefix: 'Platform',
    },
    {
      path: '~/components/auth',
      prefix: 'Auth',
      pathPrefix: false,
    },
    {
      path: '~/components/ui',
      pathPrefix: false,
    },
    {
      path: '~/components/dev-perf',
      pathPrefix: false,
    },
    {
      path: '~/components/billing',
      prefix: 'Billing',
      pathPrefix: false,
    },
    {
      path: '~/components/blog',
      pathPrefix: false,
    },
    {
      path: '~/lib/components/workspace/dashboard',
      pathPrefix: false,
    },
    {
      path: '~/lib/components/workspace/blog',
      pathPrefix: false,
    },
    {
      path: '~/lib/components/workspace/messages',
      pathPrefix: false,
    },
    {
      path: '~/lib/components/workspace/media',
      pathPrefix: false,
    },
    {
      path: '~/lib/components/workspace/location',
      pathPrefix: false,
    },
    {
      path: '~/lib/components/workspace/onboarding',
      pathPrefix: false,
    },
    {
      path: '~/lib/components/workspace/settings',
      pathPrefix: false,
    },
  ],

  // Global watcher exclusions
  watchers: {
    chokidar: {
      ignored: ['**/.wrangler/**', '**/.data/**', '**/node_modules/**', '**/.git/**', '**/.nuxt/**', '**/.output/**', '**/dist/**']
    }
  },

  routeRules: {
    // Versioned static assets — immutable forever
    '/assets/**': { headers: { 'cache-control': 'public, max-age=31536000, immutable' } },
    '/_nuxt/**':  { headers: { 'cache-control': 'public, max-age=31536000, immutable' } },
    '/_nuxt/surfaces/**': { headers: { 'cache-control': 'no-cache, max-age=0, must-revalidate' } },

    // OAuth consent + login pages — anti-framing required by OpenAI MCP CSP spec.
    // frame-ancestors 'none' prevents clickjacking on the consent/auth flow.
    // Keep the legacy framing header alongside the CSP for older clients.
    '/oauth/**': {
      headers: {
        'cache-control': 'no-store',
        'content-security-policy': "frame-ancestors 'none'",
        'x-frame-options': 'DENY',
      },
    },

    // Auth/API/dashboard — never cache
    '/api/**':       { headers: { 'cache-control': 'no-store' } },
    // Native client-only components own the CMS rendering boundary; Nuxt still
    // renders the app shell and transports the host's public identity normally.
    '/dashboard/**': { headers: { 'cache-control': 'no-store' } },
    '/auth/**':      { headers: { 'cache-control': 'no-store' } },
    '/signup':       { headers: { 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" } },
    '/login':        { headers: { 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" } },
    '/links':        { headers: { 'cache-control': 'private, no-store' } },

  },

  // Nitro configuration for Cloudflare deployment
  nitro: {
    preset: 'cloudflare-module',
    cloudflare: {
      deployConfig: false,
    },
    rolldownConfig: {
      output: {
        strictExecutionOrder: true,
      },
    },
    // Leave the resolved WASM import for Wrangler, which uploads .wasm as a precompiled
    // module. Nitro's Rollup pass cannot parse the binary, and Workers cannot compile raw
    // R2 bytes at runtime.
    rollupConfig: {
      external: [workerWasmExternal]
    },
    serverAssets: [{
      baseName: 'platform',
      dir: '..',
      pattern: 'PRODUCT.md'
    }]
  }
})
