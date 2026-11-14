<template>
  <DashboardLeafPanel id="organization-website-reviews" :title="screen?.title ?? 'Review settings'" :footer="false" :error="error ? getErrorMessage(error, 'Could not load review settings') : ''">
    <EditorNavigationList v-if="screen" :groups="[{ id: 'reviews', items: screen.rows }]" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import EditorNavigationList from '~/components/dashboard/EditorNavigationList.vue'
import type { CatalogScreen } from '~/shared/catalog-screen'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })
const dashboardApi = useDashboardApi()
const organizationId = useDashboardOrganizationId()
const { data: screen, error } = await useAsyncData(`website-review-settings:${organizationId}`,
  () => dashboardApi('/api/dashboard/offering', {
    query: { view: 'website-review-settings' },
    validate: (value): value is CatalogScreen => isRecord(value) && typeof value.title === 'string' && Array.isArray(value.rows),
  }))
</script>
