<template>
  <div class="space-y-6">
  <DashboardListEditor
    v-model:editing="editing"
    title="Sections"
    :items="listItems"
    :error="loadError"
    :read-only="readOnly"
    :disabled="Boolean(removingId) || savingOrder || Boolean(loadError) || Boolean(orderError)"
    empty-title="No sections yet"
    empty-icon="i-lucide-layout-list"
    add-label="Add section"
    reorderable
    :removing-id="removingId"
    @add="openNew"
    @remove="removeCollection"
    @move="moveCollection"
  >
    <template #item="{ item }">
      <!--
        Reordering and renaming live in the edit state beside the row, so
        browsing never has to step around edit controls.
      -->
      <span class="flex items-center gap-4" :data-testid="`collection-${item.id}`">
        <DashboardMediaThumb :asset="item.row.image" :label="item.row.name" fallback-icon="i-lucide-image" size="lg" />
        <span class="min-w-0 flex-1">
        <p class="truncate text-sm font-semibold text-highlighted">{{ item.row.name }}</p>
        <p class="mt-1 text-sm text-muted">{{ item.row.product_count === 1 ? '1 item' : `${item.row.product_count} items` }}<span v-if="!item.row.image"> · No section photo</span></p>
        <p v-if="item.row.description" class="mt-2 line-clamp-2 text-sm text-muted">{{ item.row.description }}</p>
        </span>
      </span>
    </template>
  </DashboardListEditor>
  <UAlert v-if="deleteError" color="error" variant="soft" icon="i-lucide-circle-alert" :description="deleteError" />
  <UAlert v-if="orderError" color="error" variant="soft" icon="i-lucide-circle-alert" :description="orderError" />
  <UButton v-if="orderError" label="Use current order" color="neutral" variant="soft" :disabled="savingOrder || Boolean(removingId)" @click="resetOrder" />

  </div>
</template>

<script setup lang="ts">
// One scope's menu sections — the shared ones, or one location's own — in the
// order guests see them. The Menu renders one of these per scope it shows,
// because order, Add and reorder each belong to exactly one scope. A section is
// the menu's word for a collection; this list never calls it anything else.
import DashboardListEditor from '~/components/dashboard/DashboardListEditor.vue'
import DashboardConfirmDialog from '~/components/dashboard/DashboardConfirmDialog.vue'
import DashboardMediaThumb from '~/components/dashboard/DashboardMediaThumb.vue'
import type { Collection, Product } from '~/server/types/products'
import { getErrorMessage } from '~/utils/errors'

const dashboardApi = useDashboardApi()
const route = useRoute()
const router = useRouter()
const organizationId = await useDashboardOrganizationId()

const props = defineProps<{
  /** The location these sections belong to, or null for the ones every location shares. */
  scope: string | null
  /** Read beside an editable scope; reordered and added to only where it is that scope. */
  readOnly?: boolean
}>()

const locationId = useLocationScope()
const menuPath = computed(() => `/dashboard/${String(route.params.orgSlug)}/products/menu`)

interface CollectionRow extends Collection {
  product_count: number
  /** The products that belong to it. */
  products: Product[]
}

// Section membership and classification are independent of a location filter.
const catalog = useProductCatalog(organizationId, ref(null))
await catalog.load

// The count and cover are what make a collection legible at a glance, and they
// are the only reason this level reads Items at all.
const catalogRows = computed<CollectionRow[]>(() => {
  // Membership is a relationship, so a product counts once in every collection
  // it belongs to — which is the point: it is one product in several places,
  // not several products.
  const members = new Map<string, Product[]>()
  for (const product of catalog.products.value) {
    for (const membership of product.collections) {
      members.set(membership.collection_id, [...(members.get(membership.collection_id) ?? []), product])
    }
  }
  return catalog.collections.value.filter(row => row.location_id === props.scope).map((row) => {
    const products = members.get(row.id) ?? []
    return { ...row, product_count: products.length, products }
  })
})

// Reorder is a mode: the local order stands while the edit state is open and
// commits once when it closes, so it is held apart from the shared catalog.
const localOrder = ref<CollectionRow[] | null>(null)
/** Every collection in this scope, in the one order it stores. */
const collections = computed<CollectionRow[]>(() => localOrder.value ?? catalogRows.value)
const editing = ref(false)
const removingId = ref<string | null>(null)
const confirmDialog = useOverlay().create(DashboardConfirmDialog)
const deleteError = ref<string | null>(null)
const orderError = ref<string | null>(null)

/**
 * The menu's sections: those holding dishes, and empty ones still being filled
 * — what the public menu shows, since it lists dishes and drops a section with
 * none. A grouping of only experiences or services is theirs, not the menu's.
 * It is not shown here, but keeps its place in the scope's stored order.
 */
const isMenuSection = (row: CollectionRow) => !row.products.length || row.products.some(product => product.kind === 'dish')
const sections = computed(() => collections.value.filter(isMenuSection))

// A section opens in its own scope. Shared membership has no location filter.
const listItems = computed(() => sections.value.map(row => ({ id: row.id, title: row.name, to: router.resolve({ path: `${menuPath.value}/${row.id}`, query: { location_id: row.location_id ?? undefined } }).fullPath, row })))
const loadError = computed(() => (catalog.error.value ? getErrorMessage(catalog.error.value, 'Failed to load sections') : null))

const load = catalog.refresh


// A collection is a record with its own level: adding opens `new` in this
// list's scope, and the row opens the record, whose Name leaf is one of its rows.
function openNew() {
  void navigateTo(router.resolve({ path: `${menuPath.value}/new`, query: { location_id: props.scope ?? undefined } }).fullPath)
}



async function removeCollection(item: { row: CollectionRow }) {
  const count = item.row.product_count
  // Deleting a section never deletes what was in it; the items stay in the catalog.
  if (!await confirmDialog.open({
    title: `Delete ${item.row.name}`,
    description: count ? `Its ${count === 1 ? 'item stays' : `${count} items stay`} in your catalog.` : 'The section is empty.',
    confirmLabel: 'Delete section', cancelLabel: 'Keep section',
  })) return
  removingId.value = item.row.id
  deleteError.value = null
  try {
    await dashboardApi(`/api/editor/organizations/${organizationId}/collections/${item.row.id}`, { method: 'DELETE', validate: isRecord })
    await load()
    if (localOrder.value) localOrder.value = localOrder.value.filter(collection => collection.id !== item.row.id)
    if (orderSnapshot.value) orderSnapshot.value = orderSnapshot.value.filter(id => id !== item.row.id)
  } catch (error) {
    deleteError.value = getErrorMessage(error, 'Failed to delete section')
  } finally {
    removingId.value = null
  }
}

/**
 * Reordering stays local while the edit state is open and commits once when it
 * closes. Every press used to be a request plus a full reload, which is what
 * made a six-place move feel broken.
 *
 * The row swaps places with its neighbour in the one order this scope stores.
 */
function moveCollection(item: { row: CollectionRow }, direction: -1 | 1) {
  // Swaps with the neighbouring section on screen; a grouping the menu does
  // not show stays where it is in the complete order the endpoint takes.
  const visible = sections.value
  const neighbour = visible[visible.findIndex(row => row.id === item.row.id) + direction]
  if (!neighbour) return
  const from = collections.value.findIndex(row => row.id === item.row.id)
  const to = collections.value.findIndex(row => row.id === neighbour.id)
  const order = [...collections.value]
  order[from] = collections.value[to]!
  order[to] = collections.value[from]!
  localOrder.value = order
  orderDirty.value = true
}

const orderDirty = ref(false)
const savingOrder = ref(false)
const orderSnapshot = ref<string[] | null>(null)

async function commitOrder(): Promise<boolean> {
  if (savingOrder.value || orderError.value) return false
  if (!orderDirty.value) return true
  orderDirty.value = false
  // The whole intended order for this scope — the site's own collections, or
  // one location's — which is the only order there is: the endpoint takes it
  // complete and rejects a partial one.
  const scope = props.scope
  const order = collections.value.map(row => row.id)
  orderError.value = null
  savingOrder.value = true
  const expected = orderSnapshot.value ?? catalogRows.value.map(row => row.id)
  try {
    await load()
    if (catalog.error.value) throw catalog.error.value
    const current = catalog.collections.value.filter(collection => collection.location_id === scope).map(collection => collection.id)
    if (JSON.stringify([...current].sort()) !== JSON.stringify([...order].sort())) throw new Error('The sections changed. Review the current list before reordering it.')
    await dashboardApi(`/api/editor/organizations/${organizationId}/collections/order`, {
      method: 'PUT',
      body: { collection_ids: order, expected_collection_ids: expected, location_id: scope },
      validate: isRecord,
    })
    await load()
    if (catalog.error.value) throw catalog.error.value
    if (props.scope === scope) localOrder.value = null
    const persisted = catalog.collections.value.filter(collection => collection.location_id === scope).map(collection => collection.id)
    if (JSON.stringify(persisted) !== JSON.stringify(order)) throw new Error('Section order changed. Review the current order before editing again.')
    return true
  } catch (error) {
    orderDirty.value = true
    orderError.value = getErrorMessage(error, 'Failed to save the new order')
    try { await load() } catch (readError) { orderError.value += ` The sections could not be read again: ${getErrorMessage(readError, 'Read failed')}` }
    return false
  } finally {
    savingOrder.value = false
  }
}

watch(editing, (value, previous) => {
  if (value && !previous && !orderError.value) orderSnapshot.value = catalogRows.value.map(row => row.id)
  if (previous && !value) void commitOrder()
})

async function resetOrder() {
  if (savingOrder.value || removingId.value) return
  savingOrder.value = true
  try {
    await load()
    localOrder.value = null
    orderDirty.value = false
    orderSnapshot.value = null
    orderError.value = null
    editing.value = false
  } catch (error) { orderError.value = getErrorMessage(error, 'The current section order could not be read') }
  finally { savingOrder.value = false }
}

// Resets this list's own edit state when the catalog underneath it changes.
// The full catalog stays shared; changing the displayed scope resets its draft.
onBeforeRouteLeave(async () => !savingOrder.value && !removingId.value && await commitOrder())
onBeforeRouteUpdate(async () => !savingOrder.value && !removingId.value && await commitOrder())

watch(locationId, () => {
  orderDirty.value = false
  localOrder.value = null
  editing.value = false
}, { immediate: true })
</script>
