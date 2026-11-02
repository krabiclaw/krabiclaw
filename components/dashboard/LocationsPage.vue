<template>
  <DashboardIndexPanel id="locations" :title="locationsLabel">
    <template #right>
      <UButton
        v-if="organizationPaths"
        :to="organizationPaths.newLocation"
        icon="i-lucide-plus"
        color="neutral"
        variant="soft"
        square
        :aria-label="`Add ${locationNoun}`"
      />
    </template>
    <UAlert v-if="locationsError" color="error" variant="soft" icon="i-lucide-triangle-alert" title="Could not load locations" :description="getErrorMessage(locationsError, 'Locations could not be loaded')" />
    <div
      v-else-if="locationsPending && !locations.length"
      class="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-6 animate-pulse"
      role="status"
      aria-label="Loading locations..."
    >
      <div v-for="i in 3" :key="i" class="space-y-3">
        <div class="aspect-[20/19] w-full rounded-2xl bg-elevated/70" />
        <div class="h-4 w-2/3 rounded bg-elevated/80" />
        <div class="h-3 w-1/3 rounded bg-elevated/40" />
      </div>
    </div>
    <UEmpty
      v-else-if="!locations.length"
      icon="i-lucide-map-pin"
      :title="`No ${locationsLabel.toLowerCase()} yet`"
      :actions="organizationPaths ? [{ label: `Add your first ${locationNoun}`, icon: 'i-lucide-plus', to: organizationPaths.newLocation }] : undefined"
    />

    <DashboardOrganizationLocationSelector
      v-else
      :items="tiles"
      missing-image-label="No hero photo"
      missing-image-hint="Add one under this location's photos."
    />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import DashboardOrganizationLocationSelector, { type OrganizationLocationSelectorItem } from '~/components/dashboard/OrganizationLocationSelector.vue'
import { getErrorMessage } from '~/utils/errors'
import { resolveCmsCapabilities } from '~/config/cms-registry'
import { resolvePublicTemplate } from '~/utils/template-registry'
import { normalizeVertical, type OrganizationVertical } from '~/utils/vertical-copy'

const route = useRoute()
const dashboard = useDashboardOrganization()
const { organizationPaths } = dashboard

const organization = computed(() => dashboard.organization.value)

const orgSlug = computed(() => String(route.params.orgSlug || ''))
const { locations, error: locationsError, pending: locationsPending } = await useOrganizationLocations()

// A Legal Services site calls these offices. The vocabulary comes from
// the same capabilities the rest of the dashboard reads; it depends on the
// vertical alone, so the site summary is enough.
const capabilities = computed(() => {
  const vertical = organization.value?.vertical
  if (!vertical) return null
  return resolveCmsCapabilities(normalizeVertical(vertical) as OrganizationVertical, resolvePublicTemplate({ vertical }).slug)
})
const usesServiceAreaVocabulary = computed(() => capabilities.value?.locationVocabulary === 'office/service area')
const locationsLabel = computed(() => (usesServiceAreaVocabulary.value ? 'Offices' : 'Locations'))
const locationNoun = computed(() => (usesServiceAreaVocabulary.value ? 'office' : 'location'))

/**
 * A location is identified by where it is, so the tile carries its address
 * and its own hero photograph. The name belongs under the tile, in text.
 */
const tiles = computed<OrganizationLocationSelectorItem[]>(() => locations.value.map((location) => {
  const lines = location.address?.addressLines?.filter(line => line.trim()) ?? []
  return {
    id: location.id,
    label: location.title,
    imageUrl: location.picture_url,
    eyebrow: '',
    summary: lines.length ? lines.join(', ') : 'Address not set',
    to: `/dashboard/${orgSlug.value}/locations/${location.slug}`,
  }
}))

useSeoMeta({ title: () => `${locationsLabel.value} | KrabiClaw`, robots: 'noindex, nofollow' })
</script>
