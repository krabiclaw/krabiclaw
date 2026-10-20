<template>
  <DashboardLeafPanel
    id="product-room-amenities"
    :title="searching ? 'Search amenities' : 'Add amenities'"
    lead="Let guests know which amenities are in this room or space."
    :saving="p.saving.value"
    :disabled="!room || !changed || Boolean(p.loadError.value)"
    :error="p.loadError.value || p.photoError.value || ''"
    save-label="Done"
    desktop-cancel
    @cancel="reset"
    @save="save"
  >
    <template #right>
      <UButton v-if="searching" label="Cancel" aria-label="Cancel search" color="neutral" variant="soft" :disabled="p.saving.value" @click="searching = false" />
      <UButton v-else icon="i-lucide-search" aria-label="Search amenities" color="neutral" variant="soft" square :disabled="p.saving.value" @click="searching = true" />
    </template>
    <template v-if="room">
      <UButton v-if="p.photoError.value" label="Use saved details" color="neutral" variant="soft" :disabled="p.saving.value || Boolean(p.loadError.value)" class="mb-6" @click="reset" />
      <StayAmenityPicker
        id="room-amenities"
        v-model="draft"
        v-model:searching="searching"
        v-model:filter="filter"
        :filters="filters"
        :disabled="p.saving.value"
        checkboxes
      />
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import StayAmenityPicker from '~/components/dashboard/StayAmenityPicker.vue'
import type { StayAmenity } from '~/shared/stay-listing'
import { isNavigationFailure } from 'vue-router'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
const roomId = computed(() => String(route.params.roomId))
const room = computed(() => p.photoRooms.value.find(entry => entry.id === roomId.value))
const draft = ref<StayAmenity[]>([])
const original = ref<StayAmenity[]>([])
const version = ref<number | null>(null)
const searching = ref(false)
const filter = ref('all')
// These are the Bedroom suggestions in the live host editor. Suggestions only
// narrow the choices; they never declare an amenity or assign it to a room.
const bedroomSuggestions: StayAmenity[] = ['ac', 'bed_linens', 'wardrobe_or_closet', 'essentials', 'extra_pillows_and_blankets', 'hangers', 'heating', 'iron', 'room_darkening_shades', 'safe', 'tv']
const filters = computed(() => [
  { value: 'all', label: 'All' },
  ...(room.value?.type === 'bedroom' ? [{ value: 'suggested', label: 'Suggested', amenities: bedroomSuggestions }] : []),
])
const changed = computed(() => draft.value.length !== original.value.length || draft.value.some(code => !original.value.includes(code)))

function reset() {
  if (!room.value) return
  original.value = [...room.value.amenities]
  draft.value = [...original.value]
  version.value = room.value.details_version
  p.photoError.value = null
  filter.value = room.value.type === 'bedroom' ? 'suggested' : 'all'
}
watch(room, () => { if (version.value === null && room.value) reset() }, { immediate: true })
watch(roomId, () => { version.value = null; reset() })

async function save() {
  if (!room.value || version.value === null || !changed.value) return
  if (!await p.updateStayPhotoRoom(roomId.value, { details_version: version.value, amenities: [...draft.value] })) return
  reset()
  try {
    const result = await navigateTo(level.to.value!)
    if (isNavigationFailure(result)) throw result
  } catch (error) {
    p.photoError.value = getErrorMessage(error, 'The amenities were saved, but the room could not be opened')
  }
}

onBeforeRouteLeave(() => !p.saving.value)
onBeforeRouteUpdate(() => !p.saving.value)
</script>
