<template>
  <DashboardLeafPanel
    id="menu-section-description"
    title="Description"
    lead="What introduces the section on your site, under its name and picture, and what search engines read for it."
    :saving="c.saving.value"
    :disabled="c.saveDisabled.value"
    :save-label="c.saveLabel.value"
    :error="c.errorMessage.value"
    @cancel="c.revert"
    @save="c.save"
  >
    <p class="mb-2 text-sm font-semibold text-muted">{{ charactersRemaining }}/2000 available</p>
    <UTextarea v-model="c.form.description" aria-label="Description" :rows="10" :maxlength="PRODUCT_LIMITS.collectionDescription" autofocus class="w-full" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { PRODUCT_LIMITS } from '~/shared/product-limits'
import { collectionEditorKey } from '../[collectionId].vue'

definePageMeta({ layout: 'dashboard' })

const c = inject(collectionEditorKey)!
const charactersRemaining = computed(() => PRODUCT_LIMITS.collectionDescription - (c.form.description?.length ?? 0))
</script>
