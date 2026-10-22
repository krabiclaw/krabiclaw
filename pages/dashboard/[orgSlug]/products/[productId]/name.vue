<template>
  <DashboardLeafPanel
    id="product-name"
    :title="stayTitle ? 'Title' : p.sectionLabels['name']"
    :desktop-cancel="!p.isNew.value"
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || p.photoError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <template v-if="p.isNew.value || p.product.value">
      <p class="mb-2 text-sm font-semibold text-muted">{{ charactersRemaining }}/240 available</p>
      <UInput v-model="p.form.name" :aria-label="stayTitle ? 'Title' : 'Name'" maxlength="240" autofocus class="w-full" />
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const stayTitle = computed(() => !p.isNew.value && p.form.kind === 'stay')
const charactersRemaining = computed(() => 240 - (p.form.name?.length ?? 0))
</script>
