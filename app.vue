<template>
  <NuxtLoadingIndicator :color="loadingColor" :height="2" :throttle="150" />
  <NuxtLayout>
    <NuxtPage />
    <AnnouncementModal />
    <ZarazConsentNotice />
  </NuxtLayout>
</template>

<script setup lang="ts">
import { buildTenantHeadLinks } from '~/utils/tenant-head'
import { TENANT_TYPES } from '~/utils/tenant-routing'

const { tenantType, isPlatform, template, organization } = useTenantOrganization()
if (tenantType === TENANT_TYPES.TENANT_404) {
  throw createError({
    statusCode: 404,
    statusMessage: 'Site Not Found',
  })
}

const organizationShell = template.slug === 'blawby' ? null : useOrganizationShellState()
const config = organizationShell?.config
const organizationMedia = computed(() => organization?.media ?? organizationShell?.organization.value?.media ?? [])
useHead(() => {
  const verification = config?.value.search_console_verification
  return {
    link: buildTenantHeadLinks({
      isPlatform,
      organizationMedia: organizationMedia.value,
    }),
    // Google fetches the organization's domain to verify Search Console
    // ownership (server/utils/google-search-console.ts); every public layout
    // carries it. Blawby serves its own from its document shell.
    meta: verification ? [{ name: 'google-site-verification', content: verification }] : [],
  }
})

const loadingColor = computed(() => {
  if (isPlatform) return 'var(--kc-loading-rainbow)'
  // The site's action color, which usePublicSiteBrand also puts on <html>.
  return 'var(--site-action-light)'
})
</script>
