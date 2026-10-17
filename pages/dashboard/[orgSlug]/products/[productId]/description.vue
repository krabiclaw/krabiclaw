<template>
  <DashboardLeafPanel
    id="product-description"
    :title="p.sectionLabels['description']"
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || p.photoError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <template v-if="p.isNew.value || p.product.value">
      <p class="mb-2 text-sm font-semibold text-muted">{{ charactersRemaining }}/10000 available</p>
      <UTextarea v-model="p.form.description" aria-label="Description" :rows="10" maxlength="10000" autofocus class="w-full" />
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const charactersRemaining = computed(() => 10000 - (p.form.description?.length ?? 0))
</script>
