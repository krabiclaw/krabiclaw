<template>
  <DashboardLeafPanel
    id="product-property-type"
    :title="p.sectionLabels['property-type']"
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <div v-if="(p.isNew.value || p.product.value) && !p.loadError.value" class="space-y-8">
      <UFormField label="Which is most like your place?">
        <USelect
          v-model="selectedGroup"
          :items="groupItems"
          :disabled="p.saving.value"
          placeholder="Choose a property group"
          aria-label="Which is most like your place?"
          size="xl"
          class="w-full"
        />
      </UFormField>

      <UFormField label="Property type" :description="typeDescription" :error="p.propertyTypeErrors.value.property_type">
        <USelect
          v-model="selectedType"
          :items="typeItems"
          :disabled="p.saving.value || !p.form.stay_property_type_group"
          placeholder="Choose a property type"
          aria-label="Property type"
          size="xl"
          class="w-full"
        />
        <UButton
          v-if="p.form.stay_property_type_group || p.form.stay_property_type"
          label="Clear property type"
          color="neutral"
          variant="link"
          :disabled="p.saving.value"
          class="mt-2 px-0"
          @click="clearPropertyType"
        />
      </UFormField>

      <UFormField label="Listing type" :description="listingDescription">
        <USelect
          v-model="selectedListingType"
          :items="listingItems"
          :disabled="p.saving.value"
          placeholder="Choose a listing type"
          aria-label="Listing type"
          size="xl"
          class="w-full"
        />
        <UButton
          v-if="p.form.stay_listing_type"
          label="Clear listing type"
          color="neutral"
          variant="link"
          :disabled="p.saving.value"
          class="mt-2 px-0"
          @click="p.form.stay_listing_type = null"
        />
      </UFormField>

      <UFormField :error="p.propertyTypeErrors.value.total_floors">
        <div class="flex items-center justify-between gap-4">
          <label for="stay-total-floors" class="text-base text-highlighted">How many floors in the building?</label>
          <UInputNumber
            id="stay-total-floors"
            :model-value="p.form.stay_total_floors.trim() ? Number(p.form.stay_total_floors) : null"
            :min="1"
            :step="1"
            :disabled="p.saving.value"
            :increment="{ color: 'neutral', variant: 'outline', class: 'rounded-full' }"
            :decrement="{ color: 'neutral', variant: 'outline', class: 'rounded-full' }"
            variant="none"
            class="w-36 shrink-0"
            aria-label="How many floors in the building?"
            @update:model-value="p.form.stay_total_floors = $event == null ? '' : String($event)"
          />
        </div>
      </UFormField>

      <UFormField :error="p.propertyTypeErrors.value.listing_floor">
        <div class="flex items-center justify-between gap-4">
          <label for="stay-listing-floor" class="text-base text-highlighted">Which floor is the listing on?</label>
          <UInputNumber
            id="stay-listing-floor"
            :model-value="p.form.stay_listing_floor.trim() ? Number(p.form.stay_listing_floor) : null"
            :min="1"
            :max="listingFloorMax"
            :step="1"
            :disabled="p.saving.value"
            :increment="{ color: 'neutral', variant: 'outline', class: 'rounded-full' }"
            :decrement="{ color: 'neutral', variant: 'outline', class: 'rounded-full' }"
            variant="none"
            class="w-36 shrink-0"
            aria-label="Which floor is the listing on?"
            @update:model-value="p.form.stay_listing_floor = $event == null ? '' : String($event)"
          />
        </div>
      </UFormField>

      <UFormField label="Year built" :error="p.propertyTypeErrors.value.year_built">
        <UInput
          :model-value="p.form.stay_year_built"
          type="number"
          min="1"
          step="1"
          :disabled="p.saving.value"
          aria-label="Year built"
          size="xl"
          class="w-full"
          @update:model-value="p.form.stay_year_built = $event == null ? '' : String($event)"
        />
      </UFormField>

      <UFormField
        help="The amount of indoor space that's available to guests."
        :error="p.propertyTypeErrors.value.property_size || p.propertyTypeErrors.value.property_size_unit"
      >
        <label for="stay-property-size" class="mb-2 block text-sm font-medium text-highlighted">Property size</label>
        <UFieldGroup class="w-full">
          <UInput
            id="stay-property-size"
            :model-value="p.form.stay_property_size"
            type="number"
            step="any"
            :disabled="p.saving.value"
            aria-label="Property size"
            size="xl"
            class="min-w-0 flex-1"
            @update:model-value="p.form.stay_property_size = $event == null ? '' : String($event)"
          />
          <USelect
            id="stay-property-size-unit"
            v-model="selectedSizeUnit"
            :items="sizeUnitItems"
            :disabled="p.saving.value"
            placeholder="Unit"
            aria-label="Size unit"
            size="xl"
            class="w-48 shrink-0"
          />
        </UFieldGroup>
        <UButton
          v-if="p.form.stay_property_size || p.form.stay_property_size_unit"
          label="Clear property size"
          color="neutral"
          variant="link"
          :disabled="p.saving.value"
          class="mt-2 px-0"
          @click="clearSize"
        />
      </UFormField>

      <UButton
        v-if="optionalDetailsSet"
        label="Clear optional details"
        color="neutral"
        variant="link"
        :disabled="p.saving.value"
        class="px-0"
        @click="clearOptionalDetails"
      />
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import {
  STAY_LISTING_TYPES,
  STAY_PROPERTY_SIZE_UNITS,
  STAY_PROPERTY_TYPES,
  STAY_PROPERTY_TYPE_GROUPS,
  type StayListingType,
  type StayPropertySizeUnit,
  type StayPropertyType,
  type StayPropertyTypeGroup,
} from '~/shared/stay-listing'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
onBeforeRouteLeave(() => p.revert())

const groupItems = Object.entries(STAY_PROPERTY_TYPE_GROUPS).map(([value, group]) => ({ value, label: group.label }))
const listingItems = Object.entries(STAY_LISTING_TYPES).map(([value, listing]) => ({ value, label: listing.label }))
const sizeUnitItems = Object.entries(STAY_PROPERTY_SIZE_UNITS).map(([value, unit]) => ({ value, label: unit.label }))
const selectedGroup = computed({
  get: () => p.form.stay_property_type_group ?? undefined,
  set: (value: string | undefined) => {
    const group = (value || null) as StayPropertyTypeGroup | null
    p.form.stay_property_type_group = group
    if (!group || p.form.stay_property_type && !(STAY_PROPERTY_TYPE_GROUPS[group].types as readonly string[]).includes(p.form.stay_property_type)) p.form.stay_property_type = null
  },
})
const typeItems = computed(() => p.form.stay_property_type_group
  ? STAY_PROPERTY_TYPE_GROUPS[p.form.stay_property_type_group].types.map(value => ({ value, label: STAY_PROPERTY_TYPES[value].label }))
  : [])
const selectedType = computed({
  get: () => p.form.stay_property_type ?? undefined,
  set: (value: string | undefined) => { p.form.stay_property_type = (value || null) as StayPropertyType | null },
})
const selectedListingType = computed({
  get: () => p.form.stay_listing_type ?? undefined,
  set: (value: string | undefined) => { p.form.stay_listing_type = (value || null) as StayListingType | null },
})
const selectedSizeUnit = computed({
  get: () => p.form.stay_property_size_unit ?? undefined,
  set: (value: string | undefined) => { p.form.stay_property_size_unit = (value || null) as StayPropertySizeUnit | null },
})
const typeDescription = computed(() => p.form.stay_property_type ? STAY_PROPERTY_TYPES[p.form.stay_property_type].description : undefined)
const listingDescription = computed(() => p.form.stay_listing_type ? STAY_LISTING_TYPES[p.form.stay_listing_type].description : undefined)
const listingFloorMax = computed(() => {
  const total = Number(p.form.stay_total_floors)
  return p.form.stay_total_floors.trim() && Number.isSafeInteger(total) && total > 0 ? total : undefined
})
const optionalDetailsSet = computed(() => Boolean(p.form.stay_listing_type || p.form.stay_total_floors || p.form.stay_listing_floor || p.form.stay_year_built || p.form.stay_property_size || p.form.stay_property_size_unit))

function clearPropertyType() {
  p.form.stay_property_type_group = null
  p.form.stay_property_type = null
}
function clearSize() {
  p.form.stay_property_size = ''
  p.form.stay_property_size_unit = null
}
function clearOptionalDetails() {
  p.form.stay_listing_type = null
  p.form.stay_total_floors = ''
  p.form.stay_listing_floor = ''
  p.form.stay_year_built = ''
  clearSize()
}
</script>
