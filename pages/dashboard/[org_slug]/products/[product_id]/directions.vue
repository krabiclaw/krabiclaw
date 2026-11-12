<template>
  <DashboardLeafPanel
    id="product-directions"
    title="Directions"
    desktop-cancel
    :saving="p.saving.value"
    :disabled="!p.arrivalManage.value || !p.arrivalChanged(['directions'])"
    :error="p.loadError.value || p.arrivalError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.saveArrival(['directions'])"
  >
    <template v-if="p.arrivalDraft.value && !p.arrivalError.value">
      <UTextarea :model-value="p.arrivalDraft.value.directions ?? ''" @update:model-value="p.arrivalDraft.value.directions = ($event ?? '') === '' ? null : String($event)" aria-label="Directions" :rows="9" :maxlength="STAY_ARRIVAL_TEXT_LIMITS.directions" :disabled="p.saving.value || !p.arrivalManage.value" autofocus class="w-full" />
      <p class="mt-2 text-sm text-muted">{{ (p.arrivalDraft.value.directions ?? '').length }}/{{ STAY_ARRIVAL_TEXT_LIMITS.directions }}</p>
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
