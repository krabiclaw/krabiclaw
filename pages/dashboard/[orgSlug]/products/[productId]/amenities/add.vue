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
      <StayAmenityPicker
        id="amenity-categories"
        v-model="p.form.stay_amenities"
        v-model:searching="searching"
        v-model:filter="activeGroup"
        :disabled="p.saving.value"
      />
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import StayAmenityPicker from '~/components/dashboard/StayAmenityPicker.vue'
import { STAY_AMENITY_GROUPS } from '~/shared/stay-listing'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const level = useRouteLevel()
const route = useRoute()
const router = useRouter()
const initialGroup = route.query.amenity_group
if (initialGroup !== undefined && (typeof initialGroup !== 'string' || !Object.hasOwn(STAY_AMENITY_GROUPS, initialGroup))) throw createError({ statusCode: 400, statusMessage: 'Unknown amenity category' })
const activeGroup = ref(initialGroup ?? 'all')
const searching = ref(false)
watch(searching, (value) => { if (!value) activeGroup.value = 'all' })
function cancelSearch() { searching.value = false }

async function save() {
  const query = { ...route.query }
  delete query.amenity_group
  await p.save(level.to.value ? router.resolve({ path: router.resolve(level.to.value).path, query }).fullPath : undefined)
}

onBeforeRouteLeave(() => { p.revert() })
</script>
