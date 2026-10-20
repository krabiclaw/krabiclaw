<template>
  <main class="dev-perf-page">
    <h1>KrabiClaw local text performance page</h1>
    <p>
      This page intentionally renders plain text through Nuxt with no layout,
      no components, no images, and no data fetching.
    </p>
    <p>
      Use it to compare the baseline Nuxt app shell against real pages before
      changing production speed code.
    </p>

    <section v-if="mode === 'text-no-icons'" class="dev-perf-section" aria-label="No-icons baseline test">
      <h2>No-icons baseline test</h2>
      <p>
        Explicit alias for the plain-text baseline — same as the default
        <code>text</code> mode, given its own name so the timing script's
        mode list is self-documenting and can't silently fall back to
        <code>text</code> on a typo.
      </p>
    </section>

    <LazyPerfTextModeUi v-else-if="mode === 'ui'" />
    <LazyPerfTextModeIcons
      v-else-if="mode === 'icons'"
      v-bind="iconModeVariants.icons"
    />
    <LazyPerfTextModeIcons
      v-else-if="mode === 'icons-client-only'"
      v-bind="iconModeVariants['icons-client-only']"
    />
    <LazyPerfTextModeIcons
      v-else-if="mode === 'icon-placeholders'"
      v-bind="iconModeVariants['icon-placeholders']"
    />
    <LazyPerfTextModePlatformShell v-else-if="mode === 'platform-shell'" />
    <LazyPerfTextModeStaticShell
      v-else-if="mode === 'static-shell'"
      :static-nav-items="staticNavItems"
    />
    <LazyPerfTextModeTenantHeader v-else-if="mode === 'tenant-header'" />
    <LazyPerfTextModeTenantFooter v-else-if="mode === 'tenant-footer'" />
    <LazyPerfTextModeTenantShell v-else-if="mode === 'tenant-shell'" />
    <LazyPerfTextModeTenantStaticShell
      v-else-if="mode === 'tenant-static-shell'"
      :tenant-static-nav-items="tenantStaticNavItems"
    />
    <LazyPerfTextModeIcons
      v-else-if="mode === 'simple-icons'"
      v-bind="iconModeVariants['simple-icons']"
    />
    <LazyPerfTextModeSingleIcon v-else-if="mode === 'text-with-one-icon'" />
    <LazyPerfTextModeUIButton v-else-if="mode === 'text-with-ui-button'" />
    <LazyPerfTextModeI18n v-else-if="mode === 'text-with-i18n'" />
    <LazyPerfTextModeAnalytics v-else-if="mode === 'text-with-analytics-plugin'" />
    <LazyPerfTextModeLayout v-else-if="mode === 'text-with-layout'" />
    <LazyPerfTextModeTenantCss v-else-if="mode === 'text-with-tenant-css'" />
  </main>
</template>

<script setup lang="ts">
import { isDevPerfHostAllowed } from '~/shared/dev-perf'

definePageMeta({
  layout: false,
})

const requestHeaders = useRequestHeaders(['host', 'cf-ray'])
const runtimeConfig = useRuntimeConfig()
const route = useRoute()
const modes = new Set([
  'text',
  'ui',
  'icons',
  'icons-client-only',
  'icon-placeholders',
  'platform-shell',
  'static-shell',
  'tenant-header',
  'tenant-footer',
  'tenant-shell',
  'tenant-static-shell',
  'simple-icons',
  'text-no-icons',
  'text-with-one-icon',
  'text-with-ui-button',
  'text-with-i18n',
  'text-with-analytics-plugin',
  'text-with-layout',
  'text-with-tenant-css',
])
const mode = computed(() => {
  const requestedMode = Array.isArray(route.query.mode) ? route.query.mode[0] : route.query.mode
  return requestedMode && modes.has(requestedMode) ? requestedMode : 'text'
})

const icons = [
  'i-lucide-zap',
  'i-lucide-globe',
  'i-lucide-circle-check',
  'i-lucide-arrow-right',
  'i-lucide-calendar-days',
  'i-lucide-file-text',
  'i-lucide-shopping-bag',
  'i-lucide-chart-bar',
  'i-lucide-presentation',
  'i-lucide-circle-help',
  'i-lucide-moon',
  'i-lucide-sun',
]
const simpleIcons = [
  'i-simple-icons-facebook',
  'i-simple-icons-google',
  'i-simple-icons-googlemaps',
]
const iconModeVariants = {
  icons: {
    heading: 'Icon render test',
    description: 'This mode adds the same Nuxt UI icon component used across public pages.',
    ariaLabel: 'Icon render test',
    renderMode: 'icons',
    icons,
  },
  'icons-client-only': {
    heading: 'Client-only icon render test',
    description: 'This mode keeps UIcon in the page but removes it from SSR.',
    ariaLabel: 'Client-only icon render test',
    renderMode: 'client-only',
    icons,
  },
  'icon-placeholders': {
    heading: 'Icon placeholder render test',
    description: 'This mode keeps the icon-sized layout slots but does not render UIcon.',
    ariaLabel: 'Icon placeholder render test',
    renderMode: 'placeholders',
    icons,
  },
  'simple-icons': {
    heading: 'Simple Icons render test',
    description: 'This mode renders the social icon collection used by tenant footer social links.',
    ariaLabel: 'Simple Icons render test',
    renderMode: 'icons',
    icons: simpleIcons,
  },
} as const
const staticNavItems = [
  { label: 'Plugin', to: '/plugin' },
  { label: 'Features', to: '/features' },
  { label: 'Pricing', to: '/pricing' },
  { label: 'Templates', to: '/templates' },
  { label: 'Docs', to: '/docs' },
  { label: 'Blog', to: '/blog' },
]
const tenantStaticNavItems = [
  { label: 'Menu', to: '/menu' },
  { label: 'Reservations', to: '/reservations' },
  { label: 'Experiences', to: '/experiences' },
  { label: 'Contact', to: '/contact' },
]

if (!isDevPerfHostAllowed(requestHeaders.host, !!requestHeaders['cf-ray'], runtimeConfig.public.perfPublicTestPage)) {
  throw createError({
    statusCode: 404,
    statusMessage: 'Not Found',
  })
}

useHead({
  title: 'Local Text Performance',
  meta: [
    {
      name: 'robots',
      content: 'noindex, nofollow',
    },
  ],
})
</script>

<style>
.dev-perf-page {
  max-width: 68ch;
  margin: 0 auto;
  padding: 48px 20px;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #111827;
  background: #ffffff;
}

h1 {
  margin: 0 0 16px;
  font-size: 32px;
  line-height: 1.15;
  font-weight: 700;
}

p {
  margin: 0 0 12px;
  font-size: 18px;
  line-height: 1.6;
}

.dev-perf-section {
  margin-top: 32px;
  padding-top: 24px;
  border-top: 1px solid #e5e7eb;
}

h2 {
  margin: 0 0 12px;
  font-size: 22px;
  line-height: 1.25;
}

ul {
  display: grid;
  gap: 10px;
  margin: 18px 0 0;
  padding: 0;
  list-style: none;
}

li {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 24px;
}

.dev-perf-icon {
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
}

.dev-perf-icon-placeholder {
  display: inline-block;
  border: 1px solid #9ca3af;
  border-radius: 5px;
  background: #f9fafb;
}

.dev-perf-card {
  margin-top: 18px;
}

.dev-perf-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 16px;
}

.dev-perf-platform-shell {
  max-width: none;
}

.dev-perf-shell-frame {
  margin-top: 18px;
  overflow: hidden;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
}

.dev-perf-shell-body {
  padding: 40px 24px;
}

.dev-perf-shell-body h3 {
  margin: 0 0 10px;
  font-size: 20px;
  line-height: 1.3;
}

.dev-perf-static-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  min-height: 64px;
  padding: 0 24px;
  border-bottom: 1px solid #e5e7eb;
}

.dev-perf-static-brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: #111827;
  font-weight: 700;
  text-decoration: none;
}

.dev-perf-static-brand img {
  border-radius: 9px;
}

.dev-perf-static-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  background: #111827;
  color: #ffffff;
}

.dev-perf-static-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
}

.dev-perf-static-nav a {
  color: #4b5563;
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
}

.dev-perf-static-footer {
  padding: 24px;
  border-top: 1px solid #e5e7eb;
  color: #6b7280;
  font-size: 14px;
}

.dev-perf-tenant-css-frame {
  margin-top: 18px;
  padding: 24px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: var(--ui-primary, transparent);
  color: var(--primary-foreground, inherit);
}
</style>
