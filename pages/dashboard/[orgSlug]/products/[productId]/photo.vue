<template>
  <DashboardLeafPanel
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
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
</script>
