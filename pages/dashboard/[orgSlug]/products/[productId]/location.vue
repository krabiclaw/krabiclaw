<template>
  <DashboardIndexPanel id="product-location" title="Location" :lead="sharedAddressLead" column="leaf">
    <template v-if="level.child.value" #leading>
      <DashboardNavbarLeading :to="router.resolve({ path: level.path.value, query: route.query }).fullPath" :disabled="p.saving.value" />
    </template>
    <UAlert v-if="p.loadError.value || p.stayLocationError.value" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="p.loadError.value || p.stayLocationError.value || ''" />
    <template v-else-if="p.product.value?.kind === 'stay' && p.stayLocation.value">
      <figure class="mb-2 overflow-hidden rounded-xl border border-default">
        <iframe v-if="mapEmbedUrl" :src="mapEmbedUrl" title="Saved location pin" class="h-64 w-full" referrerpolicy="strict-origin-when-cross-origin" />
        <p v-else class="p-6 text-muted">No map pin set</p>
      </figure>
      <EditorNavigationList
        :groups="groups"
        :active-item="level.child.value"
        class="[&_.group]:border-0 [&_.group]:py-6 [&_.font-semibold]:font-normal [&_.font-semibold]:text-base"
      />
    </template>
    <p v-else-if="!p.loadError.value && !p.stayLocationError.value" role="status" class="text-muted">Loading location…</p>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { STAY_AMENITIES, STAY_AMENITY_GROUPS, parseStayMapSharing, type StayAmenity } from '~/shared/stay-listing'
import { formatPostalAddress } from '~/utils/postal-address'
import { calculateMapEmbedUrl } from '~/utils/location-map'
import { productDetailFields, STAY_LOCATION_DETAIL_KEYS } from '~/shared/product-details'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const level = useRouteLevel()
const route = useRoute()
const router = useRouter()
const sharedAddressLead = computed(() => p.stayLocation.value ? `Every place to stay at ${p.stayLocation.value.title} uses this address.` : undefined)
const mapEmbedUrl = computed(() => {
  const location = p.stayLocation.value
  return location && location.latitude !== null && location.longitude !== null ? calculateMapEmbedUrl(location) : null
})
const groups = computed<EditorNavigationGroup[]>(() => {
  const location = p.stayLocation.value
  if (!location) return []
  const features = (p.product.value?.stay?.amenities ?? []).filter(code => (STAY_AMENITY_GROUPS.location.amenities as readonly StayAmenity[]).includes(code)).map(code => STAY_AMENITIES[code].label)
  const amenities = router.resolve(p.sectionPath('amenities/add'))
  const scenicViews = (p.product.value?.stay?.amenities ?? []).filter(code => (STAY_AMENITY_GROUPS.scenic_views.amenities as readonly StayAmenity[]).includes(code)).map(code => STAY_AMENITIES[code].label)
  return [{ id: 'location', items: [
    { id: 'address', label: 'Address', summary: formatPostalAddress(location.address) || 'Add address', placeholder: !location.address, to: p.sectionPath('location/address') },
    { id: 'sharing', label: 'Location sharing', summary: parseStayMapSharing(location.stay_map_sharing) === 'specific' ? 'Show specific location' : 'Show general location', to: p.sectionPath('location/sharing') },
    { id: 'features', label: 'Location features', summary: features.join(', ') || 'Add details', placeholder: !features.length, to: router.resolve({ path: amenities.path, query: { ...amenities.query, amenity_group: 'location' } }).fullPath },
    ...productDetailFields('stay').filter(field => STAY_LOCATION_DETAIL_KEYS.some(key => key === field.key)).map(field => {
      const saved = p.product.value?.details[field.key]
      return { id: field.key, label: field.name, summary: typeof saved === 'string' ? saved : 'Add details', placeholder: typeof saved !== 'string', to: p.sectionPath(`location/${field.key}`) }
    }),
    { id: 'scenic-views', label: 'Scenic views', summary: scenicViews.join(', ') || 'Add details', placeholder: !scenicViews.length, to: router.resolve({ path: amenities.path, query: { ...amenities.query, amenity_group: 'scenic_views' } }).fullPath },
  ] }]
})
watchEffect(() => {
  if (p.product.value && !p.loadError.value && p.product.value.kind !== 'stay') showNotFound()
})
</script>
