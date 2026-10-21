<template>
  <DashboardListItemDialog
    v-model:open="openModel"
    :title="selectedProductIds.length === 1 ? 'Move item' : 'Move ' + selectedProductIds.length + ' items'"
    :removable="false"
    :saving="saving"
    :save-disabled="!targetId || !selectedProductIds.length || saving || Boolean(loadError)"
    save-label="Move"
    :error="loadError || error"
    @save="move"
  >
    <UButton v-if="error" label="Use current items" color="neutral" variant="soft" :disabled="saving || Boolean(loadError)" @click="useCurrent" />
    <UFormField label="Choose a section">
      <URadioGroup v-if="targets.length" v-model="targetId" :items="targets" variant="card" :disabled="saving || Boolean(loadError)" />
      <p v-else-if="!loadError" class="text-sm text-muted">Add another section before moving items.</p>
    </UFormField>
  </DashboardListItemDialog>
</template>

<script setup lang="ts">
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import { getErrorMessage } from '~/utils/errors'

const props = defineProps<{
  organizationId: string
  sourceCollectionId: string
  productIds: string[]
  selectedProductIds: string[]
  expectedProductIds: string[]
  afterSave?: () => Promise<void>
}>()
const emit = defineEmits<{ saved: []; reset: [] }>()
const open = defineModel<boolean>('open', { default: false })
const saving = defineModel<boolean>('saving', { default: false })
const openModel = computed({ get: () => open.value, set: value => { if (!saving.value) open.value = value } })
const catalog = useProductCatalog(props.organizationId, ref(null))
await catalog.load
const { locations, error: locationsError } = await useOrganizationLocations({ includeInactive: true })
const targetId = ref('')
const snapshots = ref<Record<string, string[]>>({})
const error = ref<string | null>(null)
const loadError = computed(() => {
  const cause = catalog.error.value ?? locationsError.value
  return cause ? getErrorMessage(cause, 'The sections could not be loaded') : null
})
const targets = computed(() => loadError.value ? [] : catalog.collections.value.filter(row => row.id !== props.sourceCollectionId).map(row => {
  const location = row.location_id === null ? null : locations.value.find(location => location.id === row.location_id)
  if (row.location_id && !location) throw createError({ statusCode: 500, statusMessage: 'The section location could not be loaded' })
  return { value: row.id, label: row.name, description: location ? location.title : 'Shared by every location' }
}))
watch(open, value => {
  if (!value) return
  targetId.value = ''
  error.value = null
  snapshots.value = loadError.value ? {} : Object.fromEntries(catalog.collections.value.filter(row => row.id !== props.sourceCollectionId).map(row => [row.id, catalog.collectionProductIds(row.id)]))
})
function useCurrent() {
  open.value = false
  emit('reset')
}
async function move() {
  if (saving.value || loadError.value || !targetId.value || !props.selectedProductIds.length) return
  const target = snapshots.value[targetId.value]
  if (!target) { error.value = 'Choose a section from the current list.'; return }
  const chosen = new Set(props.selectedProductIds)
  const remaining = props.productIds.filter(id => !chosen.has(id))
  saving.value = true
  error.value = null
  try {
    await catalog.setCollectionProducts(props.sourceCollectionId, remaining, props.expectedProductIds, { collection_id: targetId.value, expected_product_ids: target })
    await props.afterSave?.()
    open.value = false
    emit('saved')
  } catch (cause) { error.value = getErrorMessage(cause, 'The items could not be moved') }
  finally { saving.value = false }
}
</script>
