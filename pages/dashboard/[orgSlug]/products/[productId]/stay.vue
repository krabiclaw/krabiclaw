<template>
  <DashboardLeafPanel
    id="product-stay"
    :title="p.sectionLabels.stay"
    lead="Where the place is, when guests arrive and leave, and how many it sleeps."
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <div v-if="p.isNew.value || (p.product.value && !p.loadError.value)" class="space-y-6">
      <!-- A place to stay is at one location for good: its address, time zone and team. -->
      <UFormField v-if="p.isNew.value" label="Location" required>
        <p v-if="p.organizationLocationsError.value" role="alert" class="text-error">{{ p.organizationLocationsError.value }}</p>
        <USelect v-else v-model="p.form.stay_location_id" :items="locationItems" placeholder="Choose a location" class="w-full" />
      </UFormField>
      <UFormField label="Check-in from" required>
        <UInput v-model="p.form.check_in_time" type="time" class="w-full" />
      </UFormField>
      <UFormField label="Checkout by" required>
        <UInput v-model="p.form.check_out_time" type="time" class="w-full" />
      </UFormField>
      <UFormField label="Sleeps" required>
        <UInput v-model="p.form.max_guests" inputmode="numeric" pattern="[0-9]*" class="w-full" />
      </UFormField>
      <UFormField label="Minimum nights" required>
        <UInput v-model="p.form.min_nights" inputmode="numeric" pattern="[0-9]*" class="w-full" />
      </UFormField>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const locationItems = computed(() => p.organizationLocations.value.map(location => ({ label: location.title, value: location.id })))
</script>
