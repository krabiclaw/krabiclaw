<template>
  <NuxtLayout :name="site.layout">
    <TenantPublicPage :path="routing.sourcePath" :locale="routing.localeSegment" />
  </NuxtLayout>
</template>

<script setup lang="ts">
import { platformLocale } from '~/shared/platform-locales'
import { resolveTenantLocalePath, splitLocalePrefix } from '~/utils/tenant-locale-path'

definePageMeta({ layout: false })

const route = useRoute()
const { site } = useTenantOrganization().organization
const routing = computed(() => {
  const candidate = splitLocalePrefix(route.path).localeSegment
  return resolveTenantLocalePath(route.path, candidate && platformLocale(candidate) ? [candidate] : [])
})
</script>
