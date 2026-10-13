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

const { organization } = useTenantOrganization()
const { template } = organization
const isPlatform = template.slug === 'platform'

const organizationShell = template.slug === 'blawby' ? null : useOrganizationShellState()
if (import.meta.server) await organizationShell?.ready
if (organizationShell?.error.value) throw createError(organizationShell.error.value)
const config = organizationShell?.config
useHead(() => {
  const verification = config?.value.search_console_verification
  return {
    link: buildTenantHeadLinks({
      isPlatform,
      organizationMedia: organization.media,
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
