<template>
  <DashboardLeafPanel
    id="product-check-in-instructions"
    title="Check-in instructions"
    desktop-cancel
    :saving="p.saving.value"
    :disabled="!p.arrivalManage.value || !p.arrivalChanged(['check_in_instructions'])"
    :error="p.loadError.value || p.arrivalError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.saveArrival(['check_in_instructions'], level.to.value ?? undefined)"
  >
    <template v-if="p.arrivalDraft.value && !p.arrivalError.value">
      <UTextarea :model-value="p.arrivalDraft.value.check_in_instructions ?? ''" @update:model-value="p.arrivalDraft.value.check_in_instructions = ($event ?? '') === '' ? null : String($event)" aria-label="Check-in instructions" :rows="12" :maxlength="STAY_ARRIVAL_TEXT_LIMITS.check_in_instructions" :disabled="p.saving.value || !p.arrivalManage.value" autofocus class="w-full" />
      <p class="mt-2 text-sm text-muted">{{ (p.arrivalDraft.value.check_in_instructions ?? '').length }}/{{ STAY_ARRIVAL_TEXT_LIMITS.check_in_instructions }}</p>
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { STAY_ARRIVAL_TEXT_LIMITS } from '~/shared/stay-arrival'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const level = useRouteLevel()
onBeforeRouteLeave(() => p.revert())
</script>
