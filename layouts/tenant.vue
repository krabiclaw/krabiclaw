<template>
  <div
    class="tenant-layout tenant-theme min-h-screen flex flex-col font-sans bg-default text-default"
    :class="[isBlawby ? 'blawby-shell blawby-theme' : 'saya-theme']"
    :style="paletteStyle"
    :data-hydrated="hydrated ? 'true' : 'false'"
    :data-public-critical-shell="isHome ? 'true' : undefined"
    :data-font-preset="fontPreset"
  >
    <!--
      Universal portal root for modal and command palette escape.
      Legacy #saya-portal-root and #blawby-portal-root are preserved so existing
      Teleport sources retain their target in document order during SSR.
    -->
    <div id="tenant-portal-root" />
    <div id="saya-portal-root" />
    <div id="blawby-portal-root" />

    <AnnouncementBanner />

    <BlawbyHeader
      v-if="isBlawby && blawbyIdentity && blawbyConsultation"
      :organization="blawbyIdentity"
      :consultation="blawbyConsultation"
      :can-schedule="blawbyCanSchedule"
      :page-links="blawbyPageLinks"
    />
    <SayaHeader
      v-else
      :organization="shellOrganization"
      :locations="locations"
      :sections="shell.sections.value"
    />

    <main class="grow" :data-route-shell="route.path">
      <slot />
      <!-- A firm's articles carry its legal disclaimer, under every article and index -->
      <p v-if="route.meta.articleCollection && blawbyCompliance?.disclaimer" class="blawby-container mb-12 text-sm italic text-muted">
        {{ blawbyCompliance.disclaimer }}
      </p>
    </main>

    <BlawbyFooter
      v-if="isBlawby && blawbyIdentity"
      :organization="blawbyIdentity"
      :compliance="blawbyCompliance"
      :page-links="blawbyPageLinks"
    />
    <LazySayaFooter
      v-else
      :organization="shellOrganization"
      :locations="footerLocations"
      :error="bootstrapError"
      :sections="shell.sections.value"
    />
  </div>
</template>

<script setup lang="ts">
import type { Ref } from 'vue'
import sayaCriticalCss from '~/assets/css/saya-critical.css?raw'
import blawbyCriticalCss from '~/assets/css/blawby-critical.css?raw'
import '~/assets/css/saya-entry.css'
import '~/assets/css/blawby-entry.css'
import type { PublicBlawbyRouteData } from '~/types/blawby'
import type { BlawbyDocumentPayload } from '~/utils/blawby-document-contract'

const route = useRoute()
const hydrated = ref(false)
onMounted(() => { hydrated.value = true })

const { organization } = useTenantOrganization()
const { template } = organization
const isBlawby = computed(() => template.slug === 'blawby')

const { locale: i18nLocale } = useI18n()
const publicLocale = useState<string>('public-locale', () => i18nLocale.value || 'en')
const activeLocale = computed(() => isBlawby.value ? publicLocale.value : (i18nLocale.value || 'en'))

const isHome = computed(() => route.path === '/'
  || (activeLocale.value !== 'en' && route.path === `/${activeLocale.value}`)
  || (isBlawby.value && /^\/preview\/(?:site|draft)\/[^/]+\/?$/.test(route.path)))

const { fontPreset, paletteStyle } = usePublicSiteBrand()

// ── Blawby Shell State ───────────────────────────────────────
let blawbyDocument: Ref<BlawbyDocumentPayload> | null = null
if (isBlawby.value) {
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
  blawbyDocument = document
}

const blawbyIdentity = computed(() => blawbyDocument?.value?.shell.identity ?? null)
const blawbyConsultation = computed(() => blawbyDocument?.value?.shell.consultation ?? null)
const blawbyCanSchedule = computed(() => blawbyDocument?.value?.shell.canSchedule ?? false)
const blawbyCompliance = computed(() => blawbyDocument?.value?.shell.compliance ?? null)
const blawbyPageLinks = computed(() => blawbyDocument?.value?.shell.pageLinks ?? [])

useHead(() => {
  const surfaceHref = isBlawby.value ? '/_nuxt/surfaces/blawby.css' : '/_nuxt/surfaces/saya.css'
  const criticalCss = isBlawby.value ? blawbyCriticalCss : sayaCriticalCss
  const stylesheetKey = isBlawby.value
    ? (isHome.value ? 'blawby-home-stylesheet' : 'blawby-surface-stylesheet')
    : (isHome.value ? 'saya-home-stylesheet' : 'saya-surface-stylesheet')

  return {
    htmlAttrs: { lang: activeLocale.value },
    link: [
      { rel: 'preconnect', href: 'https://imagedelivery.net' },
      { rel: 'preconnect', href: 'https://media.krabiclaw.com' },
      ...(import.meta.dev ? [] : [{
        key: stylesheetKey,
        rel: 'stylesheet' as const,
        href: surfaceHref,
      }]),
    ],
    style: isHome.value ? [{ innerHTML: criticalCss, tagPriority: 'critical' }] : [],
    meta: isBlawby.value && blawbyDocument?.value?.shell.searchConsoleVerification
      ? [{ name: 'google-site-verification', content: blawbyDocument.value.shell.searchConsoleVerification }]
      : [],
  }
})

if (import.meta.dev && !isBlawby.value) useDebugLCP()

// ── Saya / Universal Shell State ─────────────────────────────
const shell = useOrganizationShellState()
if (import.meta.server && !isBlawby.value) await shell.ready
const { locations, error: bootstrapError, organization: shellOrganization } = shell

const scopedLocationSlug = computed(() => {
  const path = route.path
  const localePrefix = `/${activeLocale.value}`
  const sourcePath = activeLocale.value !== 'en' && path.startsWith(localePrefix)
    ? path.slice(localePrefix.length)
    : path
  const matched = sourcePath.match(/^\/locations\/([^/]+)/)?.[1]
  if (matched === undefined) return null
  try {
    return decodeURIComponent(matched)
  }
  catch {
    return null
  }
})
const footerLocations = computed(() => (scopedLocationSlug.value === null
  ? locations.value
  : locations.value.filter(location => location.slug === scopedLocationSlug.value)))
</script>
