<template>
  <DashboardIndexPanel v-if="isStay" id="product-photo" title="Photos" column="wide">
    <template #right>
      <UButton :to="p.sectionPath('photo/photos')" label="All photos" color="neutral" variant="soft" :disabled="p.saving.value" data-testid="stay-all-photos" />
      <MediaPicker :organization-id="p.organizationId" accept="image" title="Add photos" :disabled="p.saving.value" @change="addPhoto">
        <span class="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-elevated px-4 text-sm font-medium text-highlighted"><UIcon name="i-lucide-plus" class="size-4" />Add photos</span>
      </MediaPicker>
    </template>
    <UAlert v-if="p.loadError.value || p.photoError.value" color="error" variant="soft" :description="p.loadError.value || p.photoError.value || ''" class="mb-6" />
    <NuxtLink v-if="p.photoAssets.value.length" :to="p.sectionPath('photo/photos')" class="grid grid-cols-2 gap-3 overflow-hidden rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-highlighted" aria-label="View all listing photos" data-testid="stay-photo-overview">
      <div v-for="(photo, index) in p.photoAssets.value.slice(0, 5)" :key="photo.asset_id" class="relative min-h-36 overflow-hidden bg-elevated" :class="index === 0 ? 'col-span-2 aspect-[16/9]' : 'aspect-[4/3]'">
        <img v-if="mediaStillUrl(photo)" :src="mediaStillUrl(photo) || undefined" :alt="photo.alt_text || ''" class="h-full w-full object-cover" :loading="index === 0 ? 'eager' : 'lazy'">
        <UIcon v-else name="i-lucide-image" class="absolute left-1/2 top-1/2 size-10 -translate-x-1/2 -translate-y-1/2 text-muted" />
        <span v-if="p.product.value?.image?.asset_id === photo.asset_id" class="absolute left-4 top-4 rounded-full bg-default px-3 py-1.5 text-sm font-medium text-highlighted">Cover photo</span>
      </div>
    </NuxtLink>
    <UEmpty v-else-if="!p.loadError.value" title="Add your first photo" icon="i-lucide-image-plus" />
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
import DashboardMediaGalleryField from '~/components/dashboard/DashboardMediaGalleryField.vue'
import MediaPicker from '~/lib/components/workspace/media/MediaPicker.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { mediaStillUrl } from '~/shared/media-placement-contract'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const level = useRouteLevel()
const isStay = computed(() => p.product.value?.kind === 'stay')

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
