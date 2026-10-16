<template>
  <div class="blawby-shell blawby-theme min-h-screen bg-default text-default" :style="paletteStyle" :data-hydrated="hydrated ? 'true' : 'false'" :data-public-critical-shell="isHome ? 'true' : undefined" :data-font-preset="fontPreset">
    <!-- Teleport target for components (e.g. PlatformCommandSearchModal) that need to
         escape page overflow/stacking contexts but still must render inside this div to
         inherit the Blawby --ui-* and --blawby-* tokens. Teleporting straight to <body>
         puts them outside this scope entirely, which reads as the modal falling back to
         the platform's default (non-Blawby) theme — mirrors #saya-portal-root in
         layouts/saya.vue. Placed before the page content so it precedes any Teleport
         source in document order during SSR. -->
    <div id="blawby-portal-root" />

    <AnnouncementBanner />
    <BlawbyHeader :organization="identity" :consultation="consultation" :can-schedule="canSchedule" :page-links="pageLinks" />
    <main>
      <slot />
      <!-- A firm's articles carry its legal disclaimer, under every article and index, wrapped to the full width: the stored text carries line breaks from where it was pasted. -->
      <p v-if="route.meta.articleCollection && compliance?.disclaimer" class="blawby-container mb-12 whitespace-pre-line text-sm italic text-muted">{{ compliance.disclaimer }}</p>
    </main>
    <BlawbyFooter
      :organization="identity"
      :compliance="compliance"
      :page-links="pageLinks"
    />
  </div>
</template>

<script setup lang="ts">
import blawbyCriticalCss from '~/assets/css/blawby-critical.css?raw'
import '~/assets/css/blawby-entry.css'
import type { PublicBlawbyRouteData } from '~/types/blawby'

const route = useRoute()
const publicLocale = useState<string>('public-locale', () => 'en')
const { fontPreset, paletteStyle } = usePublicSiteBrand()
const isHome = computed(() => route.path === '/'
  || (publicLocale.value !== 'en' && route.path === `/${publicLocale.value}`)
  || /^\/preview\/(?:site|draft)\/[^/]+\/?$/.test(route.path))

useHead(() => ({
  link: [
    // The stable surface file is written by `nuxt build`; under `nuxt dev`
    // Vite serves the imported entry itself.
    ...(import.meta.dev ? [] : [{
      key: isHome.value ? 'blawby-home-stylesheet' : 'blawby-surface-stylesheet',
      rel: 'stylesheet' as const,
      href: '/_nuxt/surfaces/blawby.css',
    }]),
    { rel: 'preconnect', href: 'https://media.krabiclaw.com' },
  ],
  style: isHome.value
    ? [{ innerHTML: blawbyCriticalCss, tagPriority: 'critical' }]
    : [],
}))

const blawbyRoutePath = computed(() => resolveTenantLocalePath(
  route.path,
  publicLocale.value === 'en' ? [] : [publicLocale.value],
).sourcePath)
const target = resolveBlawbyRouteTarget(blawbyRoutePath.value)
const { data: document } = await useBlawbyDocument(target.recipe, target.slug)
if (target.recipe !== 'links' && target.recipe !== 'experiences') {
  useState<PublicBlawbyRouteData['localeRepresentations']>('public-locale-representations', () => []).value = document.value.route.localeRepresentations
}
provide('blawby-document', document)
const identity = computed(() => document.value.shell.identity)
const consultation = computed(() => document.value.shell.consultation)
const canSchedule = computed(() => document.value.shell.canSchedule)
const compliance = computed(() => document.value.shell.compliance)
const pageLinks = computed(() => document.value.shell.pageLinks)
const hydrated = ref(false)
onMounted(() => { hydrated.value = true })

useHead(() => ({
  htmlAttrs: { lang: publicLocale.value },
  // Google fetches the site to verify Search Console ownership (server/utils/google-search-console.ts).
  meta: document.value.shell.searchConsoleVerification
    ? [{ name: 'google-site-verification', content: document.value.shell.searchConsoleVerification }]
    : [],
}))
</script>
