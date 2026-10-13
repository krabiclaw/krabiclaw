<template>
  <div class="space-y-6">
  <DashboardListEditor
    v-model:editing="editing"
    title="Sections"
    :description="description"
    :items="listItems"
    :error="loadError"
    :read-only="readOnly"
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
        <DashboardMediaThumb :asset="item.row.cover" :label="item.row.name" fallback-icon="i-lucide-layout-list" />
        <span class="min-w-0 flex-1">
        <p class="truncate text-sm font-semibold text-highlighted">{{ item.row.name }}</p>
        <p class="mt-1 text-sm text-muted">{{ item.row.product_count === 1 ? '1 item' : `${item.row.product_count} items` }}</p>
        </span>
      </span>
    </template>
  </DashboardListEditor>
  <UAlert v-if="deleteError" color="error" variant="soft" icon="i-lucide-circle-alert" :description="deleteError" />
  <UAlert v-if="orderError" color="error" variant="soft" icon="i-lucide-circle-alert" :description="orderError" />

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
import type { ResolvedMediaAsset } from '~/server/utils/media-asset-manager'
import { getErrorMessage } from '~/utils/errors'

const dashboardApi = useDashboardApi()
const route = useRoute()
const router = useRouter()
const organizationId = await useDashboardOrganizationId()

const props = defineProps<{
  /** The location these sections belong to, or null for the ones every location shares. */
  scope: string | null
  description?: string
  /** Read beside an editable scope; reordered and added to only where it is that scope. */
  readOnly?: boolean
}>()

const locationId = useLocationScope()
const menuPath = computed(() => `/dashboard/${String(route.params.orgSlug)}/products/menu`)

// The cover is the first Product in the collection that has a photo, which is
// how the collection reads on the public site too.
interface CollectionRow extends Collection {
  product_count: number
  cover: ResolvedMediaAsset | null
  /** The products that belong to it. */
  products: Product[]
}

const catalog = useProductCatalog(organizationId, locationId)

// The count and cover are what make a collection legible at a glance, and they
// are the only reason this level reads Items at all.
const catalogRows = computed<CollectionRow[]>(() => {
  // Membership is a relationship, so a product counts once in every collection
  // it belongs to — which is the point: it is one product in several places,
  // not several products.
  const covers = new Map<string, ResolvedMediaAsset>()
  const members = new Map<string, Product[]>()
  for (const product of catalog.products.value) {
    for (const membership of product.collections) {
      members.set(membership.collection_id, [...(members.get(membership.collection_id) ?? []), product])
      if (product.image && !covers.has(membership.collection_id)) covers.set(membership.collection_id, product.image)
    }
  }
  return catalog.collections.value.filter(row => row.location_id === props.scope).map((row) => {
    const products = members.get(row.id) ?? []
    return { ...row, product_count: products.length, cover: covers.get(row.id) ?? null, products }
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

// A section opens in its own location's scope; a shared one in the menu's current one.
const listItems = computed(() => sections.value.map(row => ({ id: row.id, title: row.name, to: router.resolve({ path: `${menuPath.value}/${row.id}`, query: { location_id: props.scope ?? route.query.location_id } }).fullPath, row })))
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

async function commitOrder() {
  if (!orderDirty.value) return
  orderDirty.value = false
  // The whole intended order for this scope — the site's own collections, or
  // one location's — which is the only order there is: the endpoint takes it
  // complete and rejects a partial one.
  const order = collections.value.map(row => row.id)
  localOrder.value = null
  orderError.value = null
  try {
    await dashboardApi(`/api/editor/organizations/${organizationId}/collections/order`, {
      method: 'PUT',
      body: { collection_ids: order, location_id: props.scope },
      validate: isRecord,
    })
  } catch (error) {
    orderError.value = getErrorMessage(error, 'Failed to save the new order')
    await load()
  }
}

watch(editing, (value, previous) => {
  if (previous && !value) void commitOrder()
})

// Resets this list's own edit state when the catalog underneath it changes.
// It does not refetch: the catalog is one keyed `useAsyncData` whose key holds
// the location, so it reloads itself. Calling `refresh` here as well turned
// `pending` true for every level sharing that key, and the server rendered the
// catalog column as skeletons while the payload beside it already held the rows.
watch(locationId, () => {
  orderDirty.value = false
  localOrder.value = null
  editing.value = false
}, { immediate: true })
</script>
