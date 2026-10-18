<template>
  <DashboardLeafPanel
    id="product-property-type"
    :title="p.sectionLabels['property-type']"
    lead="Choose the property type that best describes this place to stay."
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <div v-if="p.isNew.value || p.product.value" class="space-y-6">
      <UFormField label="Property group">
        <URadioGroup
          v-model="selectedGroup"
          :items="groupItems"
          variant="card"
          indicator="hidden"
          :ui="{ fieldset: 'grid grid-cols-2 gap-3' }"
          class="w-full"
        />
      </UFormField>

      <UFormField label="Property type">
        <URadioGroup
          v-if="typeItems.length"
          :model-value="selectedType"
          :items="typeItems"
          variant="card"
          indicator="hidden"
          class="w-full"
          @update:model-value="onSelectType"
        />
        <p v-else class="text-sm text-muted">Choose a property group to see matching property types.</p>
      </UFormField>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import {
  STAY_PROPERTY_TYPES,
  STAY_PROPERTY_TYPE_GROUPS,
  type StayPropertyType,
  type StayPropertyTypeGroup,
} from '~/shared/stay-listing'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!

const groupItems = Object.entries(STAY_PROPERTY_TYPE_GROUPS).map(([key, group]) => ({
  value: key,
  label: group.label,
  icon: group.icon,
}))

const selectedGroup = computed({
  get: () => p.form.stay_property_type_group ?? '',
  set: (val: string) => {
    const group = (val || null) as StayPropertyTypeGroup | null
    p.form.stay_property_type_group = group
    if (group && p.form.stay_property_type) {
      const allowed = STAY_PROPERTY_TYPE_GROUPS[group].types as readonly string[]
      if (!allowed.includes(p.form.stay_property_type)) {
        p.form.stay_property_type = null
      }
    }
  },
})

const typeItems = computed(() => {
  const group = p.form.stay_property_type_group
  if (!group) return []
  return STAY_PROPERTY_TYPE_GROUPS[group].types.map((typeKey) => {
    const info = STAY_PROPERTY_TYPES[typeKey]
    return {
      value: typeKey,
      label: info.label,
      description: info.description,
      icon: info.icon,
    }
  })
})

const selectedType = computed(() => p.form.stay_property_type ?? undefined)

function onSelectType(val: unknown) {
  p.form.stay_property_type = (val as StayPropertyType) || null
}
</script>
