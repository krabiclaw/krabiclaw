<template>
  <DashboardLeafPanel
    id="product-arrival-time"
    title="Check-in & checkout"
    desktop-cancel
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <div v-if="p.product.value && !p.loadError.value" class="space-y-8">
      <UFormField label="Check-in from" required>
        <UInput v-model="p.form.check_in_time" type="time" :disabled="p.saving.value" class="w-full" />
      </UFormField>
      <UFormField label="Checkout by" required>
        <UInput v-model="p.form.check_out_time" type="time" :disabled="p.saving.value" class="w-full" />
      </UFormField>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
onBeforeRouteLeave(() => p.revert())
</script>
