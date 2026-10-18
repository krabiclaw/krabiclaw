<template>
  <DashboardLeafPanel
    id="product-cancellation"
    :title="p.sectionLabels['cancellation']"
    lead="Set standard and long-term cancellation policies for guest bookings."
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <div v-if="p.isNew.value || p.product.value" class="space-y-6">
      <UFormField label="Standard cancellation policy" description="Applies to stays shorter than 28 nights.">
        <URadioGroup
          :model-value="policy"
          :items="standardItems"
          variant="card"
          class="w-full"
          @update:model-value="onSelectPolicy"
        >
          <template #description="{ item }">
            <div class="mt-1 space-y-1 text-xs text-muted">
              <p>{{ (item as any).summary }}</p>
              <ul v-if="(item as any).terms?.length" class="list-disc pl-4 space-y-0.5">
                <li v-for="term in (item as any).terms" :key="term">{{ term }}</li>
              </ul>
            </div>
          </template>
        </URadioGroup>
      </UFormField>

      <UFormField label="Long-term cancellation policy" description="Applies to stays of 28 nights or longer.">
        <URadioGroup
          :model-value="longTermPolicy"
          :items="longTermItems"
          variant="card"
          class="w-full"
          @update:model-value="onSelectLongTermPolicy"
        >
          <template #description="{ item }">
            <div class="mt-1 space-y-1 text-xs text-muted">
              <p>{{ (item as any).summary }}</p>
              <ul v-if="(item as any).terms?.length" class="list-disc pl-4 space-y-0.5">
                <li v-for="term in (item as any).terms" :key="term">{{ term }}</li>
              </ul>
            </div>
          </template>
        </URadioGroup>
      </UFormField>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import {
  STAY_CANCELLATION_POLICIES,
  STAY_LONG_TERM_CANCELLATION_POLICIES,
  type StayCancellationPolicy,
  type StayLongTermCancellationPolicy,
} from '~/shared/stay-listing'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!

const standardItems = Object.entries(STAY_CANCELLATION_POLICIES).map(([key, info]) => ({
  value: key,
  label: info.label,
  summary: info.summary,
  terms: info.terms,
}))

const longTermItems = Object.entries(STAY_LONG_TERM_CANCELLATION_POLICIES).map(([key, info]) => ({
  value: key,
  label: info.label,
  summary: info.summary,
  terms: info.terms,
}))

const policy = computed(() => p.form.stay_cancellation_policy ?? undefined)
const longTermPolicy = computed(() => p.form.stay_long_term_cancellation_policy ?? undefined)

function onSelectPolicy(val: unknown) {
  p.form.stay_cancellation_policy = (val as StayCancellationPolicy) || null
}

function onSelectLongTermPolicy(val: unknown) {
  p.form.stay_long_term_cancellation_policy = (val as StayLongTermCancellationPolicy) || null
}
</script>
