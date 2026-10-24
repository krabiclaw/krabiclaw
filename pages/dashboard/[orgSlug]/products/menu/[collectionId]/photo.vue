<template>
  <DashboardLeafPanel
    id="menu-section-photo"
    title="Photo"
    :error="c.imageError.value"
    :footer="false"
  >
    <!-- The picture that introduces the section on your site and on its tile in Catalog. -->
    <DashboardCoverPhotoField
      :organization-id="c.organizationId"
      :model-value="c.image.value?.asset_id ?? null"
      :preview-url="c.image.value?.public_url ?? null"
      :preview-alt="c.image.value?.alt_text || c.form.name"
      :title="c.noun.value === 'section' ? 'Section photo' : 'Collection photo'"
      testid="menu-section-photo"
      @update:model-value="c.setImage"
    />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import DashboardCoverPhotoField from '~/components/dashboard/DashboardCoverPhotoField.vue'
import { collectionEditorKey } from '../[collectionId].vue'

definePageMeta({ layout: 'dashboard' })

const c = inject(collectionEditorKey)!
</script>
