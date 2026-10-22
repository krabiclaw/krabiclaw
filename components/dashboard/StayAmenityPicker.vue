<template>
  <div>
    <UInput
      v-if="searching"
      v-model="query"
      type="search"
      aria-label="Search amenities"
      placeholder="Search amenities"
      icon="i-lucide-search"
      autofocus
      class="mb-8 w-full"
      @keydown.esc.stop.prevent="searching = false"
    />
    <DashboardFilterPills
      v-else
      :id="id"
      v-model="filter"
      label="Amenity filters"
      :items="filters"
      selected-variant="outline"
      class="mb-8"
    />
    <ul v-if="visibleAmenities.length" :class="checkboxes ? 'border-t border-default pt-3' : undefined">
      <li v-for="item in visibleAmenities" :key="item.code">
        <UCheckbox
          v-if="checkboxes"
          :model-value="selected.includes(item.code)"
          :disabled="disabled"
          :label="item.label"
          color="neutral"
          indicator="end"
          size="xl"
          :ui="{ root: 'items-center gap-5 py-5', wrapper: 'me-0', label: 'flex cursor-pointer items-center gap-5 font-normal text-highlighted', container: 'shrink-0', base: 'rounded-md' }"
          @update:model-value="toggle(item.code)"
        >
          <template #label>
            <UIcon :name="item.icon" class="size-7 shrink-0" aria-hidden="true" />
            <span>{{ item.label }}</span>
          </template>
        </UCheckbox>
        <button
          v-else
          type="button"
          :aria-pressed="selected.includes(item.code)"
          :disabled="disabled"
          class="flex w-full items-center gap-5 rounded-lg py-5 text-left text-highlighted hover:bg-elevated/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlighted disabled:opacity-50"
          @click="toggle(item.code)"
        >
          <UIcon :name="item.icon" class="size-7 shrink-0" aria-hidden="true" />
          <span class="grow text-base">{{ item.label }}</span>
          <span class="flex size-8 shrink-0 items-center justify-center rounded-full ring ring-inset" :class="selected.includes(item.code) ? 'bg-inverted text-inverted ring-inverted' : 'text-highlighted ring-default'" aria-hidden="true">
            <UIcon :name="selected.includes(item.code) ? 'i-lucide-check' : 'i-lucide-plus'" class="size-4" />
          </span>
        </button>
      </li>
    </ul>
    <UEmpty v-else title="No amenities found" icon="i-lucide-search" />
  </div>
</template>

<script setup lang="ts">
import { STAY_AMENITIES, STAY_AMENITY_GROUPS, type StayAmenity } from '~/shared/stay-listing'

const props = withDefaults(defineProps<{
  id: string
  disabled?: boolean
  checkboxes?: boolean
  filters?: Array<{ value: string; label: string; amenities?: readonly StayAmenity[] }>
}>(), {
  filters: () => [
    { value: 'all', label: 'All' },
    ...Object.entries(STAY_AMENITY_GROUPS).map(([value, group]) => ({ value, label: group.label, amenities: group.amenities })),
  ],
})
const selected = defineModel<StayAmenity[]>({ required: true })
const searching = defineModel<boolean>('searching', { default: false })
const filter = defineModel<string>('filter', { default: 'all' })
const query = ref('')
const visibleAmenities = computed(() => {
  const codes = !searching.value && props.filters.find(item => item.value === filter.value)?.amenities
    || Object.keys(STAY_AMENITIES) as StayAmenity[]
  const search = query.value.trim().toLocaleLowerCase()
  return codes.map(code => ({ code, ...STAY_AMENITIES[code] }))
    .filter(item => !searching.value || item.label.toLocaleLowerCase().includes(search))
    .sort((left, right) => left.label.localeCompare(right.label))
})
watch(searching, (value) => { if (!value) query.value = '' })
function toggle(code: StayAmenity) {
  if (props.disabled) return
  selected.value = selected.value.includes(code) ? selected.value.filter(value => value !== code) : [...selected.value, code]
}
</script>
