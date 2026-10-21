<template>
  <div
    class="tenant-layout tenant-theme min-h-screen flex flex-col font-sans bg-default text-default"
    :style="paletteStyle"
    :data-hydrated="hydrated ? 'true' : 'false'"
    :data-public-critical-shell="isHome ? 'true' : undefined"
    :data-font-preset="fontPreset"
  >
    <!-- Modals and the command palette teleport here, inside the site's theme scope. -->
    <div id="tenant-portal-root" />

    <AnnouncementBanner />

    <TenantHeader
      :organization="tenantChromeOrganization"
      :locations="locations"
      :sections="shellSections"
      :consultation="shellConsultation"
      :can-schedule="shellCanSchedule"
      :page-links="shellPageLinks"
    />

    <main class="grow" :data-route-shell="route.path">
      <slot />
      <!-- A firm's articles carry its legal disclaimer, under every article and index -->
      <p v-if="route.meta.articleCollection && shellCompliance?.disclaimer" class="tenant-container mb-12 text-sm italic text-muted">
        {{ shellCompliance.disclaimer }}
      </p>
    </main>

    <TenantFooter
      :organization="tenantChromeOrganization"
      :locations="footerLocations"
      :error="bootstrapError"
      :sections="shellSections"
      :compliance="shellCompliance"
      :page-links="shellPageLinks"
    />
  </div>
</template>

<script setup lang="ts">
import tenantCriticalCss from '~/assets/css/tenant-critical.css?raw'
import '~/assets/css/tenant-entry.css'

const route = useRoute()
const hydrated = ref(false)
onMounted(() => { hydrated.value = true })


const { locale: i18nLocale } = useI18n()
const activeLocale = computed(() => i18nLocale.value || 'en')

const isHome = computed(() => route.path === '/'
  || (activeLocale.value !== 'en' && route.path === `/${activeLocale.value}`)
  || (/^\/preview\/(?:site|draft)\/[^/]+\/?$/.test(route.path)))

const { organization } = useTenantOrganization()
const { fontPreset, paletteStyle } = usePublicSiteBrand()

// ── Universal Shell State ─────────────────────────────────────
const shell = useOrganizationShellState()
if (import.meta.server) await shell.ready
const locations = computed(() => shell.locations.value)
const bootstrapError = computed(() => shell.error.value)
const shellOrganization = computed(() => shell.organization.value)
const shellSections = computed(() => shell.sections.value)
const shellConsultation = computed(() => shell.consultation.value)
const shellCanSchedule = computed(() => shell.canSchedule.value)
const shellCompliance = computed(() => shell.compliance.value)
const shellPageLinks = computed(() => shell.pageLinks.value)
const shellSearchConsoleVerification = computed(() => shell.searchConsoleVerification.value)

const tenantChromeOrganization = computed(() => {
  if (shellOrganization.value) {
    return {
      ...shellOrganization.value,
      vertical: organization.vertical,
    }
  }
  return null
})

useHead(() => {
  return {
    htmlAttrs: { lang: activeLocale.value },
    link: [
      { rel: 'preconnect', href: 'https://imagedelivery.net' },
      { rel: 'preconnect', href: 'https://media.krabiclaw.com' },
      ...(import.meta.dev ? [] : [{
        key: 'tenant-surface-stylesheet',
        rel: 'stylesheet' as const,
        href: '/_nuxt/surfaces/tenant.css',
      }]),
    ],
    style: isHome.value ? [{ innerHTML: tenantCriticalCss, tagPriority: 'critical' }] : [],
    meta: shellSearchConsoleVerification.value
      ? [{ name: 'google-site-verification', content: shellSearchConsoleVerification.value }]
      : [],
  }
})

if (import.meta.dev) useDebugLCP()

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
