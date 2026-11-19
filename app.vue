<template>
  <NuxtLoadingIndicator :color="loadingColor" :height="2" :throttle="0" />
  <NuxtLayout>
    <NuxtPage />
    <PublicAnnouncement format="modal" v-if="isPublicSurface" />
    <ZarazConsentNotice />
  </NuxtLayout>
</template>

<script setup lang="ts">
import publicDocumentScript from '#build/public-document-script.mjs'
import { installPublicDocumentControls } from '~/utils/public-document-controls'
import { ZARAZ_ANALYTICS_PURPOSE_ID, ZARAZ_CONSENT_COOKIE_NAME } from '~/utils/zaraz-consent'
import { isDocumentOnlyPublicPath } from '~/shared/public-locale-routes'
import { buildTenantHeadLinks } from '~/utils/tenant-head'
import { isPublicMenuProduct } from '~/utils/public-resource-contracts'

const { organization, previewAuthorized } = useTenantOrganization()
const { site } = organization
const isPlatform = site.slug === 'platform'
const route = useRoute()
const isPublicSurface = computed(() => !route.path.startsWith('/dashboard') && !route.path.startsWith('/api'))

if (import.meta.server) {
  const path = route.path.replace(/\/$/, '')
  const source = typeof route.params.locale === 'string' ? path.slice(route.params.locale.length + 1) : path
  if (isDocumentOnlyPublicPath(source)) {
    // Nuxt emits a rule for every app route and locale on noScripts pages.
    // Warm links between the document-only pages without sending that route tree.
    useNuxtApp().ssrContext?.head.hooks?.hook('tags:resolve', ({ tags }) => {
      const hints = tags.find(tag => tag.tag === 'script' && tag.props.type === 'speculationrules')
      if (!hints) return
      const where = { or: ['/menu', '/*/menu', '/reviews', '/*/reviews'].map(path => ({ href_matches: `${path}{/}?` })) }
      hints.innerHTML = JSON.stringify({ prerender: [{ where, eagerness: 'moderate' }] })
    })
    useHead({ script: [{
      key: 'public-document-controls',
      tagPosition: 'bodyClose',
      ...(previewAuthorized ? { 'data-preview': '' } : {}),
      innerHTML: publicDocumentScript,
    }] })
  }
} else {
  const { trackAnnouncementView, trackAnnouncementCtaClick } = useOrganizationConversionTracking()
  onMounted(() => {
    installPublicDocumentControls(ZARAZ_ANALYTICS_PURPOSE_ID, ZARAZ_CONSENT_COOKIE_NAME,
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
