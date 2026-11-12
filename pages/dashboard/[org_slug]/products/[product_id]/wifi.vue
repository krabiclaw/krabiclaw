<template>
  <DashboardLeafPanel
    id="product-wifi"
    title="Wifi details"
    desktop-cancel
    :saving="p.saving.value"
    :disabled="!p.arrivalManage.value || !p.arrivalChanged(['wifi_network', 'wifi_password'])"
    :error="p.loadError.value || p.arrivalError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.saveArrival(['wifi_network', 'wifi_password'])"
  >
    <div v-if="p.arrivalDraft.value && !p.arrivalError.value" class="space-y-8">
      <UFormField label="Wifi network">
        <UInput :model-value="p.arrivalDraft.value.wifi_network ?? ''" @update:model-value="p.arrivalDraft.value.wifi_network = ($event ?? '') === '' ? null : String($event)" aria-label="Wifi network" :maxlength="STAY_ARRIVAL_TEXT_LIMITS.wifi_network" :disabled="p.saving.value || !p.arrivalManage.value" autocomplete="off" autofocus class="w-full" />
      </UFormField>
      <UFormField label="Wifi password">
        <UInput :model-value="p.arrivalDraft.value.wifi_password ?? ''" @update:model-value="p.arrivalDraft.value.wifi_password = ($event ?? '') === '' ? null : String($event)" aria-label="Wifi password" :maxlength="STAY_ARRIVAL_TEXT_LIMITS.wifi_password" :disabled="p.saving.value || !p.arrivalManage.value" autocomplete="off" class="w-full" />
      </UFormField>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { STAY_ARRIVAL_TEXT_LIMITS } from '~/shared/stay-arrival'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
onBeforeRouteLeave(() => p.revert())
</script>
