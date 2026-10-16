<template>
  <!--
    Google Maps is per location: each KrabiClaw location is matched to at most
    one Google Maps place, so this is a list of locations, each a leaf.
  -->
  <DashboardIndexPanel id="integration-google-maps" title="Google Maps">
    <UAlert v-if="integrations.failure.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="integrations.failure.value" />
    <p v-else-if="!items.length" class="text-sm text-muted">Add a location first, then connect it to its Google Maps place.</p>
    <EditorNavigationList v-else :groups="[{ id: 'locations', items }]" :active-item="level.child.value" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'
import { integrationsKey } from '../integrations.vue'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const level = useRouteLevel()
const integrations = inject(integrationsKey)!

// A row reads the way Google Maps shows the place: its picture, its rating, where it is.
const items = computed<EditorNavigationItem[]>(() => (integrations.summary.value?.google_maps ?? []).map(location => ({
  id: location.slug,
  label: location.title,
  lead: { image: location.image, icon: 'i-lucide-map-pin' },
  ...(location.google_place_id
    ? {
        status: 'success' as const,
        summary: [
          location.rating === null ? 'No rating yet' : `★ ${location.rating} · ${location.review_count ?? 0} reviews`,
          location.address,
        ].filter(Boolean).join(' · '),
      }
    : { summary: 'Not connected', status: 'neutral' as const }),
  to: `/dashboard/${String(route.params.orgSlug)}/integrations/google-maps/${location.slug}`,
})))
</script>
