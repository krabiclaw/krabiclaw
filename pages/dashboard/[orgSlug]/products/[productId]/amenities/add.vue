<template>
  <DashboardLeafPanel
    id="product-amenities-add"
    :title="searching ? 'Search amenities' : 'Add amenities'"
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    save-label="Done"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="save"
  >
    <template #right>
      <UButton v-if="searching" label="Cancel" aria-label="Cancel search" color="neutral" variant="soft" :disabled="p.saving.value" @click="cancelSearch" />
      <UButton v-else icon="i-lucide-search" aria-label="Search amenities" color="neutral" variant="soft" square :disabled="p.saving.value" @click="searching = true" />
    </template>

    <template v-if="p.product.value && !p.loadError.value">
      <UInput
        v-if="searching"
        v-model="query"
        type="search"
        aria-label="Search amenities"
        placeholder="Search amenities"
        icon="i-lucide-search"
        autofocus
        class="mb-8 w-full"
        @keydown.esc.stop.prevent="cancelSearch"
      />
      <DashboardFilterPills
        v-else
        id="amenity-categories"
        v-model="activeGroup"
        label="Amenity categories"
        :items="groupItems"
        selected-variant="outline"
        class="mb-8"
      />

      <ul v-if="visibleAmenities.length">
        <li v-for="item in visibleAmenities" :key="item.code">
          <button
            type="button"
            :aria-pressed="isSelected(item.code)"
            :disabled="p.saving.value"
            class="flex w-full items-center gap-5 rounded-lg py-5 text-left text-highlighted hover:bg-elevated/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlighted disabled:opacity-50"
            @click="toggleAmenity(item.code)"
          >
            <UIcon :name="item.icon" class="size-7 shrink-0" aria-hidden="true" />
            <span class="grow text-base">{{ item.label }}</span>
            <span class="flex size-8 shrink-0 items-center justify-center rounded-full ring ring-inset" :class="isSelected(item.code) ? 'bg-inverted text-inverted ring-inverted' : 'text-highlighted ring-default'" aria-hidden="true">
              <UIcon :name="isSelected(item.code) ? 'i-lucide-check' : 'i-lucide-plus'" class="size-4" />
            </span>
          </button>
        </li>
      </ul>
      <UEmpty v-else title="No amenities found" icon="i-lucide-search" />
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { STAY_AMENITIES, STAY_AMENITY_GROUPS, type StayAmenity, type StayAmenityGroup } from '~/shared/stay-listing'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const level = useRouteLevel()
const route = useRoute()
const router = useRouter()
const initialGroup = route.query.amenity_group
if (initialGroup !== undefined && (typeof initialGroup !== 'string' || !Object.hasOwn(STAY_AMENITY_GROUPS, initialGroup))) throw createError({ statusCode: 400, statusMessage: 'Unknown amenity category' })
const activeGroup = ref(initialGroup ?? 'all')
const searching = ref(false)
const query = ref('')
const groupItems = [
  { value: 'all', label: 'All' },
  ...Object.entries(STAY_AMENITY_GROUPS).map(([value, group]) => ({ value, label: group.label })),
]
const visibleAmenities = computed(() => {
  const codes: readonly StayAmenity[] = searching.value || activeGroup.value === 'all'
    ? Object.keys(STAY_AMENITIES) as StayAmenity[]
    : STAY_AMENITY_GROUPS[activeGroup.value as StayAmenityGroup].amenities
  const search = query.value.trim().toLocaleLowerCase()
  return codes.map(code => ({ code, ...STAY_AMENITIES[code] }))
    .filter(item => !searching.value || item.label.toLocaleLowerCase().includes(search))
    .sort((left, right) => left.label.localeCompare(right.label))
})

function isSelected(code: StayAmenity): boolean {
  return p.form.stay_amenities.includes(code)
}

function toggleAmenity(code: StayAmenity) {
  if (p.saving.value) return
  p.form.stay_amenities = isSelected(code)
    ? p.form.stay_amenities.filter(value => value !== code)
    : [...p.form.stay_amenities, code]
}

function cancelSearch() {
  query.value = ''
  activeGroup.value = 'all'
  searching.value = false
}

async function save() {
  const query = { ...route.query }
  delete query.amenity_group
  await p.save(level.to.value ? router.resolve({ path: router.resolve(level.to.value).path, query }).fullPath : undefined)
}

onBeforeRouteLeave(() => { p.revert() })
</script>
