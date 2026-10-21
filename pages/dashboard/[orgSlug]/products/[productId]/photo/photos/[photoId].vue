<template>
  <DashboardIndexPanel id="product-photo-detail" :title="title">
    <template #leading><DashboardNavbarLeading :disabled="p.saving.value" /></template>
    <template v-if="photo" #right>
      <UButton v-if="!cover" label="Make cover photo" color="neutral" variant="soft" :loading="p.saving.value && !removing" :disabled="p.saving.value" @click="makeCover" />
      <UButton icon="i-lucide-trash-2" aria-label="Remove photo" color="neutral" variant="soft" square :loading="removing" :disabled="p.saving.value" @click="removePhoto" />
    </template>
    <UAlert v-if="p.loadError.value || p.photoError.value" color="error" variant="soft" :description="p.loadError.value || p.photoError.value || ''" class="mb-6" />
    <div v-if="photo" class="mx-auto w-full max-w-3xl" data-testid="stay-photo-detail">
      <div class="relative overflow-hidden rounded-2xl bg-elevated">
        <img v-if="mediaStillUrl(photo)" :src="mediaStillUrl(photo) || undefined" :alt="photo.alt_text || ''" class="max-h-[65dvh] min-h-48 w-full object-contain">
        <span v-else class="flex aspect-[4/3] items-center justify-center"><UIcon name="i-lucide-image" class="size-12 text-muted" /></span>
        <span v-if="cover" class="absolute left-4 top-4 rounded-full bg-default px-3 py-1.5 text-sm font-medium text-highlighted">Cover photo</span>
        <UButton
          :to="p.sectionPath(`photo/photos/${encodeURIComponent(photo.asset_id)}/visual-description`)"
          :label="photo.alt_text ? 'Edit visual description' : 'Add a visual description'"
          :icon="photo.alt_text ? 'i-lucide-pencil' : 'i-lucide-plus'"
          color="neutral"
          variant="solid"
          class="absolute bottom-4 right-4 rounded-full shadow-sm"
          :disabled="p.saving.value"
        />
      </div>
      <UButton :label="`Move from ${roomName}?`" trailing-icon="i-lucide-chevron-right" color="neutral" variant="ghost" class="mt-6 w-full justify-between px-0 py-4 text-base" :disabled="p.saving.value" @click="openMove" />
    </div>
  </DashboardIndexPanel>
  <StayPhotoRoomDialog v-model:open="moving" :photos="moveDraft" />
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import StayPhotoRoomDialog from '~/components/dashboard/StayPhotoRoomDialog.vue'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import { isNavigationFailure } from 'vue-router'
import { getErrorMessage } from '~/utils/errors'
import { stayPhotoRoomName } from '~/shared/stay-photos'

definePageMeta({ layout: 'dashboard', dashboardFrame: true })

const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
const photoId = computed(() => String(route.params.photoId ?? ''))
const photo = computed(() => p.photoAssets.value.find(asset => asset.asset_id === photoId.value) ?? null)
const cover = computed(() => p.product.value?.image?.asset_id === photoId.value)
const title = computed(() => {
  const index = p.photoAssets.value.findIndex(asset => asset.asset_id === photoId.value)
  return index >= 0 ? `Photo ${index + 1}` : 'Photo'
})
const removing = ref(false)
const moving = ref(false)
const moveDraft = ref<Array<{ photo_id: string; expected_room_id: string | null }>>([])
const room = computed(() => p.photoRooms.value.find(entry => entry.photo_ids.includes(photoId.value)) ?? null)
const roomName = computed(() => room.value ? stayPhotoRoomName(room.value, p.photoRooms.value) : 'Additional photos')
p.photoError.value = null

function openMove() {
  moveDraft.value = [{ photo_id: photoId.value, expected_room_id: room.value?.id ?? null }]
  moving.value = true
}

async function makeCover() {
  if (!photo.value || p.saving.value) return
  await p.reorderStayPhotos([photoId.value, ...p.photoAssets.value.filter(asset => asset.asset_id !== photoId.value).map(asset => asset.asset_id)])
}

async function removePhoto() {
  if (!photo.value || p.saving.value) return
  removing.value = true
  try {
    if (await p.removeStayPhotos([photoId.value])) {
      const result = await navigateTo(level.to.value!)
      if (isNavigationFailure(result)) throw result
    }
  } catch (error) {
    p.photoError.value = getErrorMessage(error, 'The photo was removed, but the photo grid could not be opened')
  } finally {
    removing.value = false
  }
}

watch(photoId, () => { p.photoError.value = null })
watchEffect(() => {
  if (p.product.value && !p.loadError.value && !p.saving.value && !removing.value && !p.photoError.value && !photo.value) showError(createError({ statusCode: 404, statusMessage: 'Photo not found' }))
})
</script>
