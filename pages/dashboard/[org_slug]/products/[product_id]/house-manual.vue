<template>
  <DashboardLeafPanel
    id="product-house-manual"
    title="House manual"
    desktop-cancel
    :saving="p.saving.value"
    :disabled="!p.arrivalManage.value || !p.arrivalChanged(['house_manual'])"
    :error="p.loadError.value || p.arrivalError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.saveArrival(['house_manual'])"
  >
    <template v-if="p.arrivalDraft.value && !p.arrivalError.value">
      <UTextarea :model-value="p.arrivalDraft.value.house_manual ?? ''" @update:model-value="p.arrivalDraft.value.house_manual = ($event ?? '') === '' ? null : String($event)" aria-label="House manual" :rows="12" :maxlength="STAY_ARRIVAL_TEXT_LIMITS.house_manual" :disabled="p.saving.value || !p.arrivalManage.value" autofocus class="w-full" />
      <p class="mt-2 text-sm text-muted">{{ (p.arrivalDraft.value.house_manual ?? '').length }}/{{ STAY_ARRIVAL_TEXT_LIMITS.house_manual }}</p>
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { STAY_ARRIVAL_TEXT_LIMITS } from '~/shared/stay-arrival'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
onBeforeRouteLeave(() => p.revert())
</script>
