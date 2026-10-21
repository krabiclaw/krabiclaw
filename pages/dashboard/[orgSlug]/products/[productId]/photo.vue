<template>
  <DashboardIndexPanel v-if="isStay" id="product-photo" title="Photo tour">
    <template #right>
      <UButton :to="p.sectionPath('photo/photos')" label="All photos" color="neutral" variant="soft" :disabled="p.saving.value" data-testid="stay-all-photos" />
      <UDropdownMenu :items="[{ label: 'Add photos', onSelect: () => library?.open() }, { label: 'Add a room or space', onSelect: () => addingRoom = true }]">
        <UButton icon="i-lucide-plus" aria-label="Add photos, room, or space" color="neutral" variant="soft" square :disabled="p.saving.value || Boolean(p.loadError.value)" />
      </UDropdownMenu>
    </template>
    <UAlert v-if="p.loadError.value || p.photoError.value" color="error" variant="soft" :description="p.loadError.value || p.photoError.value || ''" class="mb-6" />
    <template v-if="!p.loadError.value">
      <p class="mb-8 text-base text-muted">Manage photos by room or space. Guests see your photo tour once every room has a photo.</p>
      <div class="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 xl:grid-cols-4" data-testid="stay-photo-overview">
        <NuxtLink v-for="room in p.photoRooms.value" :key="room.id" :to="p.sectionPath(`photo/rooms/${encodeURIComponent(room.id)}`)" class="group min-w-0 rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-highlighted" :data-testid="`stay-photo-room-${room.id}`">
          <span class="flex aspect-square items-center justify-center overflow-hidden rounded-2xl bg-elevated">
            <img v-if="roomPhoto(room)" :src="roomPhoto(room) || undefined" alt="" class="size-full object-cover transition-transform group-hover:scale-105">
            <UIcon v-else :name="STAY_PHOTO_ROOM_TYPES[room.type].icon" class="size-16 text-muted" />
          </span>
          <span class="mt-3 block text-base font-medium text-highlighted">{{ stayPhotoRoomName(room, p.photoRooms.value) }}</span>
          <span class="mt-1 block text-sm text-muted">{{ room.photo_ids.length ? `${room.photo_ids.length} ${room.photo_ids.length === 1 ? 'photo' : 'photos'}` : 'Add photos' }}</span>
        </NuxtLink>
        <NuxtLink :to="p.sectionPath('photo/additional-photos')" class="group min-w-0 rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-highlighted" data-testid="stay-additional-photos">
          <span class="flex aspect-square items-center justify-center overflow-hidden rounded-2xl bg-elevated">
            <img v-if="mediaStillUrl(additionalPhotos[0])" :src="mediaStillUrl(additionalPhotos[0]) || undefined" alt="" class="size-full object-cover transition-transform group-hover:scale-105">
            <UIcon v-else name="i-lucide-images" class="size-16 text-muted" />
          </span>
          <span class="mt-3 block text-base font-medium text-highlighted">Additional photos</span>
          <span class="mt-1 block text-sm text-muted">{{ additionalPhotos.length ? `${additionalPhotos.length} ${additionalPhotos.length === 1 ? 'photo' : 'photos'}` : 'Add photos' }}</span>
        </NuxtLink>
      </div>
    </template>
    <div class="hidden"><MediaPicker ref="library" :organization-id="p.organizationId" accept="image" title="Add photos" :disabled="p.saving.value" @change="addPhoto" /></div>
    <StayPhotoRoomDialog v-model:open="addingRoom" @created="openRoom" />
  </DashboardIndexPanel>
  <DashboardLeafPanel
    v-else
    id="product-photo"
    :title="p.sectionLabels['photo']"
    lead="The picture guests recognise this by, in the list and on your site."
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || p.photoError.value || ''"
    :footer="false"
    @cancel="p.revert"
    @save="p.save"
  >
    <div v-if="p.isNew.value || p.product.value" class="space-y-6">
      <DashboardCoverPhotoField
        :organization-id="p.organizationId"
        :location-id="p.locationId.value"
        :model-value="p.form.image_asset_id"
        :preview-url="p.product.value?.image?.public_url ?? null"
        :preview-alt="p.product.value?.image?.alt_text || p.form.name"
        :title="`${p.itemLabel.value} photo`"
        testid="product-photo"
        @update:model-value="p.setPrimaryImage"
      />
      <UFormField v-if="p.product.value" label="More photos">
        <DashboardMediaGalleryField
          :items="p.galleryRows.value"
          :organization-id="p.organizationId"
          :cover-first="false"
          @add="p.addGalleryRow"
          @remove="p.removeGalleryPhoto"
          @move="(index: number, direction: -1 | 1) => p.moveGalleryPhoto(index, index + direction)"
          @reorder="p.moveGalleryPhoto"
          @asset-change="p.setGalleryAsset"
        />
      </UFormField>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import DashboardCoverPhotoField from '~/components/dashboard/DashboardCoverPhotoField.vue'
import StayPhotoRoomDialog from '~/components/dashboard/StayPhotoRoomDialog.vue'
import DashboardMediaGalleryField from '~/components/dashboard/DashboardMediaGalleryField.vue'
import MediaPicker from '~/lib/components/workspace/media/MediaPicker.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import { STAY_PHOTO_ROOM_TYPES, stayPhotoRoomName, type StayPhotoRoom } from '~/shared/stay-photos'
import { isNavigationFailure } from 'vue-router'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const level = useRouteLevel()
const isStay = computed(() => p.product.value?.kind === 'stay')
const library = useTemplateRef('library')
const addingRoom = ref(false)
const additionalPhotos = computed(() => {
  const assigned = new Set(p.photoRooms.value.flatMap(room => room.photo_ids))
  return p.photoAssets.value.filter(photo => !assigned.has(photo.asset_id))
})

function roomPhoto(room: StayPhotoRoom) {
  return mediaStillUrl(p.photoAssets.value.find(photo => room.photo_ids.includes(photo.asset_id)))
}

async function openRoom(room: StayPhotoRoom) {
  try {
    const result = await navigateTo(p.sectionPath(`photo/rooms/${encodeURIComponent(room.id)}`))
    if (isNavigationFailure(result)) throw result
  } catch (error) {
    p.photoError.value = getErrorMessage(error, 'The room was added, but it could not be opened')
  }
}

async function addPhoto(asset: { asset_id: string } | null) {
  if (asset) await p.addStayPhoto(asset.asset_id)
}

watchEffect(() => {
  if (p.product.value && !p.loadError.value && !isStay.value && level.child.value) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})

// Keep the targeted Product mounted until its placement and readback finish.
onBeforeRouteLeave(() => !p.saving.value)
onBeforeRouteUpdate(() => !p.saving.value)
</script>
