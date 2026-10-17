<template>
  <DashboardLeafPanel
    id="product-rooms"
    :title="p.sectionLabels['rooms']"
    lead="Set the number of bedrooms, beds, and bathrooms available to guests."
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <div v-if="p.isNew.value || p.product.value" class="space-y-6">
      <div class="grid gap-6 sm:grid-cols-3">
        <UFormField label="Bedrooms" description="0 for a studio">
          <UInput
            :model-value="p.form.stay_bedrooms"
            type="number"
            min="0"
            max="50"
            step="1"
            placeholder="e.g. 2"
            class="w-full"
            @update:model-value="p.form.stay_bedrooms = $event === null || $event === undefined ? '' : String($event)"
          />
        </UFormField>

        <UFormField label="Beds">
          <UInput
            :model-value="p.form.stay_beds"
            type="number"
            min="1"
            max="50"
            step="1"
            placeholder="e.g. 3"
            class="w-full"
            @update:model-value="p.form.stay_beds = $event === null || $event === undefined ? '' : String($event)"
          />
        </UFormField>

        <UFormField label="Bathrooms" description="Supports half baths">
          <UInput
            :model-value="p.form.stay_bathrooms"
            type="number"
            min="0"
            max="50"
            step="0.5"
            placeholder="e.g. 1.5"
            class="w-full"
            @update:model-value="p.form.stay_bathrooms = $event === null || $event === undefined ? '' : String($event)"
          />
        </UFormField>
      </div>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
</script>
