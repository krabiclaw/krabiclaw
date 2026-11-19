<template>
  <NuxtLoadingIndicator :color="loadingColor" :height="2" :throttle="0" />
  <NuxtLayout>
    <NuxtPage />
    <PublicAnnouncement format="modal" v-if="isPublicSurface" />
    <ZarazConsentNotice />
  </NuxtLayout>
</template>

<script setup lang="ts">
import { browserPageviewTransport, postPublicInteraction } from '~/utils/browser-pageview'
import { bootPublicDocument, installPublicDocumentControls } from '~/utils/public-document-controls'
import { ATTRIBUTION_KEYS } from '~/utils/analytics-attribution'
import { NATIVE_PAGEVIEW_ZARAZ_EVENT, ZARAZ_ANALYTICS_PURPOSE_ID, ZARAZ_CONSENT_COOKIE_NAME } from '~/utils/zaraz-consent'
import { isDocumentOnlyPublicPath } from '~/shared/public-locale-routes'
import { buildTenantHeadLinks } from '~/utils/tenant-head'
import { isPublicMenuProduct } from '~/utils/public-resource-contracts'

const { organization, previewAuthorized } = useTenantOrganization()
const { site } = organization
const isPlatform = site.slug === 'platform'
const route = useRoute()
const isPublicSurface = computed(() => !route.path.startsWith('/dashboard') && !route.path.startsWith('/api'))

const documentConfig = { purpose: ZARAZ_ANALYTICS_PURPOSE_ID, consentCookie: ZARAZ_CONSENT_COOKIE_NAME, gaEvent: NATIVE_PAGEVIEW_ZARAZ_EVENT, attributionKeys: ATTRIBUTION_KEYS, preview: previewAuthorized }
if (import.meta.server) {
  const path = route.path.replace(/\/$/, '')
  const source = typeof route.params.locale === 'string' ? path.slice(route.params.locale.length + 1) : path
  if (isDocumentOnlyPublicPath(source)) {
    // These browser functions are self-contained and also run in the hydrated app.
    const scripts = [installPublicDocumentControls, browserPageviewTransport, postPublicInteraction].map(fn => fn.toString())
    useHead({ script: [{
      key: 'public-document-controls', tagPosition: 'bodyClose',
      innerHTML: `(${bootPublicDocument.toString()})(${scripts.join(',')},${JSON.stringify(documentConfig)})`,
    }] })
  }
} else {
  const { trackAnnouncementView, trackAnnouncementCtaClick } = useOrganizationConversionTracking()
  onMounted(() => {
    installPublicDocumentControls(documentConfig.purpose, documentConfig.consentCookie,
      action => (action === 'announcement_view' ? trackAnnouncementView : trackAnnouncementCtaClick)(route.path), true)
  })
}

const organizationShell = isPlatform ? null : useOrganizationShellState()
if (import.meta.server && organizationShell) {
  const page = String(route.name).replace(/^localized-/, '')
  const content = page === 'menu'
    ? usePublicPageData({ datasets: ['menu_cards'], validateProduct: isPublicMenuProduct })
    : page === 'reviews' ? usePublicPageData() : undefined
  await Promise.all([organizationShell.ready, content])
}
if (organizationShell?.error.value) throw createError(organizationShell.error.value)
useHead(() => {
  const verification = organizationShell?.search_console_verification.value ?? organizationShell?.config.value.search_console_verification
  return {
    link: buildTenantHeadLinks({
      isPlatform,
      organizationMedia: organization.media,
    }),
    // Google fetches the organization's domain to verify Search Console
    // ownership (server/utils/google-search-console.ts); every public layout carries it.
    meta: verification ? [{ name: 'google-site-verification', content: verification }] : [],
  }
})

const loadingColor = computed(() => {
  if (isPlatform) return 'var(--kc-loading-rainbow)'
  // The site's action color, which usePublicSiteBrand also puts on <html>.
  return 'var(--site-action-light)'
})
</script>
