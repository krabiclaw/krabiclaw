<template>
  <DashboardLeafPanel
    id="product-check-in-method-choice"
    title="Check-in method"
    desktop-cancel
    :saving="p.saving.value"
    :disabled="!p.arrivalManage.value || !p.arrivalChanged(['check_in_method'])"
    :error="p.loadError.value || p.arrivalError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.saveArrival(['check_in_method'], level.to.value ?? undefined)"
  >
    <URadioGroup v-if="p.arrivalDraft.value && !p.arrivalError.value" :model-value="p.arrivalDraft.value.check_in_method ?? undefined" :items="items" variant="card" indicator="hidden" :disabled="p.saving.value || !p.arrivalManage.value" aria-label="Check-in method" class="w-full" @update:model-value="choose" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { STAY_CHECK_IN_METHODS } from '~/shared/stay-listing'
import { isStayCheckInMethod } from '~/shared/stay-arrival'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const level = useRouteLevel()
const items = Object.entries(STAY_CHECK_IN_METHODS).map(([value, method]) => ({ value, label: method.label, description: method.description, icon: method.icon }))
function choose(value: unknown) {
  if (p.arrivalDraft.value && isStayCheckInMethod(value)) p.arrivalDraft.value.check_in_method = value
}
onBeforeRouteLeave(() => p.revert())
</script>
