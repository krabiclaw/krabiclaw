<template>
  <DashboardLeafPanel
    id="product-room-accessibility-feature"
    :title="definition.label"
    :lead="definition.description"
    :saving="p.saving.value"
    :disabled="!room || !changed || Boolean(p.loadError.value) || (available === true && photoIds.length === 0)"
    :error="p.loadError.value || p.photoError.value || ''"
    desktop-cancel
    @cancel="reset"
    @save="save"
  >
    <template #right>
      <UButton label="Clear details" color="neutral" variant="ghost" :disabled="p.saving.value || available === null" @click="choose(null)" />
    </template>
    <template v-if="room">
      <p class="mb-6 text-sm text-muted">{{ roomName }}</p>
      <UButton label="Review photo guidelines" color="neutral" variant="link" class="mb-6 px-0 underline" :disabled="p.saving.value" @click="guidelinesOpen = true" />
      <p v-if="available === null" class="mb-4 text-sm text-muted" role="status">This feature hasn’t been specified.</p>
      <UButton v-if="p.photoError.value" label="Use saved details" color="neutral" variant="soft" :disabled="p.saving.value || Boolean(p.loadError.value)" class="mb-6" @click="reset" />
      <URadioGroup
        :model-value="available === null ? undefined : available ? 'yes' : 'no'"
        :items="[{ value: 'no', label: 'I don’t have this feature' }, { value: 'yes', label: 'I have this feature' }]"
        :disabled="p.saving.value"
        :aria-label="definition.label"
        variant="card"
        indicator="end"
        class="w-full"
        @update:model-value="choose($event === 'yes')"
      />
      <section v-if="available === true" class="mt-8">
        <h2 class="text-xl font-semibold text-highlighted">Add photos of this feature</h2>
        <ul class="my-5 list-disc space-y-3 pl-5 text-sm leading-relaxed text-muted"><li v-for="guideline in definition.guidelines" :key="guideline">{{ guideline }}</li></ul>
        <p class="mb-5 text-sm text-muted">Choose photos that show this feature. They will appear on your listing when you save.</p>
        <div v-if="photos.length" class="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <button
            v-for="(photo, index) in photos"
            :key="photo.asset_id"
            type="button"
            :aria-label="`Use photo ${index + 1} as evidence`"
            :aria-pressed="photoIds.includes(photo.asset_id)"
            :disabled="p.saving.value"
            class="relative aspect-square overflow-hidden rounded-xl border-2 focus-visible:outline-2 focus-visible:outline-offset-4"
            :class="photoIds.includes(photo.asset_id) ? 'border-highlighted' : 'border-transparent'"
            @click="togglePhoto(photo.asset_id)"
          >
            <img v-if="photo.url" :src="photo.url" :alt="photo.alt_text || ''" class="size-full object-cover">
            <span v-else class="flex size-full items-center justify-center bg-elevated"><UIcon name="i-lucide-image" class="size-8" /></span>
            <span class="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full bg-default"><UIcon v-if="photoIds.includes(photo.asset_id)" name="i-lucide-check" class="size-4" /></span>
          </button>
        </div>
        <MediaPicker :organization-id="p.organizationId" accept="image" title="Add evidence photo" :disabled="p.saving.value" @change="selectPhoto">
          <span class="inline-flex h-10 items-center gap-2 rounded-full bg-elevated px-4 font-medium text-highlighted"><UIcon name="i-lucide-image-plus" class="size-4" />Add photos</span>
        </MediaPicker>
        <p v-if="!photoIds.length" class="mt-4 text-sm text-muted" role="status">Add at least one photo to save this feature.</p>
      </section>
    </template>
  </DashboardLeafPanel>
  <DashboardListItemDialog v-model:open="guidelinesOpen" title="Photo guidelines" save-label="Got it" @save="guidelinesOpen = false">
    <ul class="list-disc space-y-4 pl-5 text-base text-muted"><li v-for="guideline in definition.guidelines" :key="guideline">{{ guideline }}</li></ul>
  </DashboardListItemDialog>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import MediaPicker from '~/lib/components/workspace/media/MediaPicker.vue'
import { stayPhotoRoomName } from '~/shared/stay-photos'
import { STAY_ROOM_ACCESSIBILITY_FEATURES, type StayRoomAccessibility } from '~/shared/stay-accessibility'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import { isNavigationFailure } from 'vue-router'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
const feature = computed(() => {
  const value = String(route.params.feature)
  if (!Object.hasOwn(STAY_ROOM_ACCESSIBILITY_FEATURES, value)) throw createError({ statusCode: 404, statusMessage: 'Accessibility feature not found' })
  return value as StayRoomAccessibility['feature']
})
const definition = computed(() => STAY_ROOM_ACCESSIBILITY_FEATURES[feature.value])
const room = computed(() => p.photoRooms.value.find(entry => entry.id === route.params.roomId))
const roomName = computed(() => room.value ? stayPhotoRoomName(room.value, p.photoRooms.value) : '')
const available = ref<boolean | null>(null)
const photoIds = ref<string[]>([])
const original = ref<StayRoomAccessibility | null>(null)
const version = ref<number | null>(null)
const guidelinesOpen = ref(false)
const addedPhotos = ref<Array<{ asset_id: string; public_url: string | null; kind: string | null; alt_text: string }>>([])
const photos = computed(() => [
  ...p.photoAssets.value.filter(photo => photo.kind === 'image').map(photo => ({ asset_id: photo.asset_id, url: mediaStillUrl(photo), alt_text: photo.alt_text })),
  ...addedPhotos.value.filter(photo => !p.photoAssets.value.some(saved => saved.asset_id === photo.asset_id)).map(photo => ({ ...photo, url: photo.public_url })),
])
const changed = computed(() => original.value !== null && (available.value !== original.value.available || photoIds.value.length !== original.value.photo_ids.length || photoIds.value.some(id => !original.value!.photo_ids.includes(id))))
function choose(value: boolean | null) {
  available.value = value
  if (value !== true) photoIds.value = []
}
function togglePhoto(id: string) {
  if (p.saving.value) return
  photoIds.value = photoIds.value.includes(id) ? photoIds.value.filter(value => value !== id) : [...photoIds.value, id]
}
function selectPhoto(asset: { asset_id: string; public_url: string | null; kind: string | null; alt_text: string } | null) {
  if (!asset) return
  if (asset.kind !== 'image' || !asset.public_url) { p.photoError.value = 'Choose an image that can be displayed.'; return }
  if (!addedPhotos.value.some(photo => photo.asset_id === asset.asset_id)) addedPhotos.value.push(asset)
  if (!photoIds.value.includes(asset.asset_id)) photoIds.value.push(asset.asset_id)
}
function reset() {
  if (!room.value || room.value.type !== 'bedroom') return
  const saved = room.value.accessibility.find(answer => answer.feature === feature.value)
  if (!saved) throw createError({ statusCode: 500, statusMessage: 'The bedroom accessibility details could not be read' })
  original.value = { ...saved, photo_ids: [...saved.photo_ids] }
  available.value = saved.available
  photoIds.value = [...saved.photo_ids]
  version.value = room.value.details_version
  addedPhotos.value = []
  p.photoError.value = null
}
watch(room, () => {
  if (room.value && room.value.type !== 'bedroom') showError(createError({ statusCode: 404, statusMessage: 'Bedroom not found' }))
  if (version.value === null && room.value?.type === 'bedroom') reset()
}, { immediate: true })
watch(() => [route.params.roomId, feature.value], () => { version.value = null; reset() })
async function save() {
  if (!room.value || version.value === null || !changed.value || (available.value === true && photoIds.value.length === 0)) return
  if (!await p.updateStayPhotoRoom(room.value.id, { details_version: version.value, accessibility: { feature: feature.value, available: available.value, photo_ids: [...photoIds.value] } })) return
  reset()
  try {
    const result = await navigateTo(level.to.value!)
    if (isNavigationFailure(result)) throw result
  } catch (error) {
    p.photoError.value = getErrorMessage(error, 'The accessibility details were saved, but the feature list could not be opened')
  }
}
onBeforeRouteLeave(() => !p.saving.value)
onBeforeRouteUpdate(() => !p.saving.value)
</script>
