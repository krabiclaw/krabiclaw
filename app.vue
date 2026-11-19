<template>
  <NuxtLoadingIndicator :color="loadingColor" :height="2" :throttle="0" />
  <NuxtLayout>
    <NuxtPage />
    <AnnouncementModal />
    <ZarazConsentNotice />
  </NuxtLayout>
</template>

<script setup lang="ts">
import { buildTenantHeadLinks } from '~/utils/tenant-head'
import { isPublicMenuProduct } from '~/utils/public-resource-contracts'

const { organization } = useTenantOrganization()
const { site } = organization
const isPlatform = site.slug === 'platform'

const organizationShell = isPlatform ? null : useOrganizationShellState()
if (import.meta.server && organizationShell) {
  const page = String(useRoute().name).replace(/^localized-/, '')
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
