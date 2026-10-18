<template>
  <DashboardLeafPanel
    id="product-stay-availability"
    title="Availability"
    lead="Choose the minimum number of nights guests can book."
    desktop-cancel
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <div v-if="p.product.value && !p.loadError.value" class="flex items-center justify-between gap-8 py-6">
      <label for="stay-minimum-nights" class="text-lg text-highlighted">Minimum nights</label>
      <UInputNumber
        id="stay-minimum-nights"
        :model-value="Number(p.form.min_nights)"
        :min="1"
        :max="365"
        :step="1"
        :disabled="p.saving.value"
        :increment="{ color: 'neutral', variant: 'outline', class: 'rounded-full' }"
        :decrement="{ color: 'neutral', variant: 'outline', class: 'rounded-full' }"
        variant="none"
        class="w-36"
        aria-label="Minimum nights"
        @update:model-value="p.form.min_nights = $event == null ? '' : String($event)"
      />
    </div>
    <UButton
      v-if="p.product.value && !p.loadError.value"
      :to="{ name: 'dashboard-orgSlug-calendar', params: { orgSlug: String(route.params.orgSlug) }, query: { product_id: p.product.value.id } }"
      label="Open nightly calendar"
      icon="i-lucide-calendar-days"
      color="neutral"
      variant="outline"
      class="mt-6"
    />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const route = useRoute()
onBeforeRouteLeave(() => p.revert())
</script>
