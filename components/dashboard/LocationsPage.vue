<template>
  <DashboardIndexPanel id="locations" :title="choosingHours ? 'Choose a location' : locationsLabel">
    <template #right>
      <UButton
        v-if="organizationPaths && !choosingHours"
        :to="organizationPaths.newLocation"
        icon="i-lucide-plus"
        color="neutral"
        variant="soft"
        square
        :aria-label="`Add a ${locationNoun}`"
      />
    </template>
    <UAlert v-if="locationsError" color="error" variant="soft" icon="i-lucide-triangle-alert" title="Could not load locations" :description="getErrorMessage(locationsError, 'Locations could not be loaded')" />
    <div v-else-if="!locations.length" class="rounded-2xl border border-default bg-elevated px-6 py-20 text-center">
      <UIcon name="i-lucide-map-pin" class="mx-auto size-6 text-muted" />
      <h2 class="mt-5 text-base font-semibold text-highlighted">No {{ locationsLabel.toLowerCase() }} yet</h2>
      <UButton
        v-if="organizationPaths"
        :label="`Add your first ${locationNoun}`"
        icon="i-lucide-plus"
        class="mt-6"
        :to="organizationPaths.newLocation"
      />
    </div>

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
import { locationHoursPath } from '~/server/utils/dashboard-links'

const route = useRoute()
const choosingHours = computed(() => route.query.action === 'hours')
const dashboard = useDashboardOrganization()
const { organizationPaths } = dashboard

const organization = computed(() => dashboard.organization.value)

const orgSlug = computed(() => String(route.params.orgSlug || ''))
const { locations, error: locationsError } = await useOrganizationLocations()

// A professional services site calls these offices. The vocabulary comes from
// the same capabilities the rest of the dashboard reads; it depends on the
// vertical alone, so the site summary is enough.
const capabilities = computed(() => {
  const vertical = organization.value?.vertical
  if (!vertical) return null
  return resolveCmsCapabilities(normalizeVertical(vertical) as OrganizationVertical, resolvePublicTemplate({ vertical }).slug)
})
const usesServiceAreaVocabulary = computed(() => capabilities.value?.locationVocabulary === 'office/service area')
const locationsLabel = computed(() => (usesServiceAreaVocabulary.value ? 'Offices / Service Areas' : 'Locations'))
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
    to: choosingHours.value ? locationHoursPath(orgSlug.value, location.slug) : `/dashboard/${orgSlug.value}/locations/${location.slug}`,
  }
}))

useSeoMeta({ title: () => `${locationsLabel.value} | KrabiClaw`, robots: 'noindex, nofollow' })
</script>
