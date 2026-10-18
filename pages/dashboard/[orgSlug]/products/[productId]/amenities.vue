<template>
  <DashboardLeafPanel
    id="product-amenities"
    :title="p.sectionLabels['amenities']"
    lead="Select the amenities available at this place to stay."
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <div v-if="p.isNew.value || p.product.value" class="space-y-6">
      <div class="flex items-center gap-4">
        <USelect
          v-model="activeGroup"
          :items="groupItems"
          placeholder="All categories"
          class="w-64"
        />
        <span class="text-xs text-muted">
          {{ p.form.stay_amenities.length }} selected
        </span>
      </div>

      <div class="space-y-3">
        <div
          v-for="item in visibleAmenities"
          :key="item.code"
          class="flex items-center justify-between rounded-lg border border-default p-3 hover:bg-muted/10 cursor-pointer"
          @click="toggleAmenity(item.code)"
        >
          <div class="flex items-center gap-3">
            <span class="text-sm font-medium">{{ item.label }}</span>
          </div>
          <UCheckbox
            :model-value="isSelected(item.code)"
            @update:model-value="toggleAmenity(item.code)"
            @click.stop
          />
        </div>
      </div>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import {
  STAY_AMENITIES,
  STAY_AMENITY_GROUPS,
  type StayAmenity,
  type StayAmenityGroup,
} from '~/shared/stay-listing'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!

const activeGroup = ref<string>('all')

const groupItems = computed(() => [
  { value: 'all', label: 'All categories' },
  ...Object.entries(STAY_AMENITY_GROUPS).map(([key, group]) => ({
    value: key,
    label: group.label,
  })),
])

const visibleAmenities = computed(() => {
  if (activeGroup.value === 'all' || !activeGroup.value) {
    return Object.entries(STAY_AMENITIES).map(([code, info]) => ({
      code: code as StayAmenity,
      label: info.label,
    }))
  }
  const group = STAY_AMENITY_GROUPS[activeGroup.value as StayAmenityGroup]
  if (!group) return []
  return group.amenities.map((code) => ({
    code,
    label: STAY_AMENITIES[code]?.label ?? code,
  }))
})

function isSelected(code: StayAmenity): boolean {
  return p.form.stay_amenities.includes(code)
}

function toggleAmenity(code: StayAmenity) {
  const index = p.form.stay_amenities.indexOf(code)
  if (index >= 0) {
    p.form.stay_amenities.splice(index, 1)
  } else {
    p.form.stay_amenities.push(code)
  }
}
</script>
