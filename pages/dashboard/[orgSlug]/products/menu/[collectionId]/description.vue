<template>
  <DashboardLeafPanel
    id="menu-section-description"
    title="Description"
    :saving="c.saving.value"
    :disabled="c.saveDisabled.value"
    :save-label="c.saveLabel.value"
    :error="c.errorMessage.value"
    @cancel="c.revert"
    @save="c.save"
  >
    <!-- What introduces the section on your site, under its name and picture, and what search engines read for it. -->
    <UFormField label="Description">
      <UTextarea v-model="c.form.description" :rows="10" :maxlength="PRODUCT_LIMITS.collectionDescription" autofocus class="w-full" />
    </UFormField>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { PRODUCT_LIMITS } from '~/shared/product-limits'
import { collectionEditorKey } from '../[collectionId].vue'

definePageMeta({ layout: 'dashboard' })

const c = inject(collectionEditorKey)!
</script>
