<template>
  <DashboardLeafPanel
    id="product-guests"
    title="Number of guests"
    lead="How many guests can stay comfortably?"
    desktop-cancel
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <div v-if="p.product.value && !p.loadError.value" class="flex items-center justify-between gap-8 py-6">
      <label for="stay-guests" class="text-lg text-highlighted">Guests</label>
      <UInputNumber
        id="stay-guests"
        :model-value="Number(p.form.max_guests)"
        :min="1"
        :max="99"
        :step="1"
        :disabled="p.saving.value"
        :increment="{ color: 'neutral', variant: 'outline', class: 'rounded-full' }"
        :decrement="{ color: 'neutral', variant: 'outline', class: 'rounded-full' }"
        variant="none"
        class="w-36"
        aria-label="Guests"
        @update:model-value="p.form.max_guests = $event == null ? '' : String($event)"
      />
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
onBeforeRouteLeave(() => p.revert())
</script>
