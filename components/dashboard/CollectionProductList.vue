<template>
  <!-- One collection: its products, in the order customers see them. Each opens its one editor in Catalog. -->
  <DashboardIndexPanel id="menu-section" :title="collection?.name ?? 'Section'">
    <DashboardListEditor
      v-model:editing="editing"
      v-model:selected="selected"
      :title="collection?.name ?? 'Section'"
      description="Guests see items in this order."
      :items="listItems"
      :error="loadError"
      empty-title="No items in this section yet"
      empty-icon="i-lucide-utensils"
      add-label="Add item"
      reorderable
      selectable
      @add="openNew"
      @move="moveProduct"
    >
      <template #selection-actions>
        <UButton label="Move" color="neutral" variant="soft" data-testid="product-move-open" @click="moveDialogOpen = true" />
        <!-- Removing from this section changes this section only: the item stays in the catalog, at its locations and in every other section. -->
        <UButton label="Remove from section" color="neutral" variant="soft" :loading="removing" data-testid="product-remove-from-section" @click="removeSelected" />
      </template>

      <template #item="{ item }">
        <span class="flex w-full items-center gap-4 text-left" :data-testid="`product-${item.id}`">
          <DashboardMediaThumb :asset="item.row.image" :label="item.row.name" fallback-icon="i-lucide-image" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-semibold text-highlighted">{{ item.row.name }}</span>
            <span class="mt-1 block text-sm tabular-nums" :class="priceLabel(item.row) ? 'text-muted' : 'italic text-muted'">
              {{ priceLabel(item.row) || 'No price set' }}
            </span>
          </span>
        </span>
      </template>
    </DashboardListEditor>

    <!-- Move is its own action, exactly as it is on Airbnb: it changes which
         category items belong to, never their order inside one. -->
    <DashboardListItemDialog
      v-model:open="moveDialogOpen"
      :title="selected.length === 1 ? 'Move item' : `Move ${selected.length} items`"
      :removable="false"
      :saving="moving"
      :save-disabled="!moveTargetId"
      save-label="Move"
      :error="moveError"
      @save="moveSelected"
    >
      <UFormField label="Choose a section">
        <URadioGroup v-if="moveTargets.length" v-model="moveTargetId" :items="moveTargets.map(option => ({ value: option.id, label: option.name }))" variant="card" />
        <p v-else class="text-sm text-muted">
          There is nowhere else to move these yet. Add another section first.
        </p>
      </UFormField>
    </DashboardListItemDialog>
    <UAlert v-if="orderError" color="error" variant="soft" icon="i-lucide-circle-alert" :description="orderError" class="mt-4" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
// One menu section's items. Rendered by `products/menu/[collectionId].vue`, which owns the frame.
import DashboardListEditor from '~/components/dashboard/DashboardListEditor.vue'
import DashboardMediaThumb from '~/components/dashboard/DashboardMediaThumb.vue'
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import type { Product } from '~/server/types/products'
import { getErrorMessage } from '~/utils/errors'


const route = useRoute()
const router = useRouter()
const dashboardApi = useDashboardApi()
const organizationId = await useDashboardOrganizationId()
const collectionId = computed(() => String(route.params.collectionId ?? route.params.categoryId ?? ''))
const locationId = useLocationScope()

const catalog = useProductCatalog(organizationId, locationId)
const collections = catalog.collections

// Reorder is a mode: the local order stands while the edit state is open and
// commits once when it closes, so it is held apart from the shared catalog.
const localOrder = ref<Product[] | null>(null)
/**
 * This collection's products, in the order the merchant set.
 *
 * Position is on the membership row, so the same product can sit third here
 * and first in another collection without being copied.
 */
const products = computed(() => {
  if (localOrder.value) return localOrder.value
  const positions = new Map<string, number>()
  for (const product of catalog.products.value) {
    const membership = product.collections.find(entry => entry.collection_id === collectionId.value)
    if (membership) positions.set(product.id, membership.sort_order)
  }
  return catalog.products.value
    .filter(product => positions.has(product.id))
    .sort((left, right) => (positions.get(left.id)! - positions.get(right.id)!) || left.name.localeCompare(right.name))
})

const editing = ref(false)
const selected = ref<string[]>([])
const orderDirty = ref(false)
const orderError = ref<string | null>(null)
const moveError = ref<string | null>(null)

const collection = computed(() => collections.value.find(row => row.id === collectionId.value) ?? null)
const loadError = computed(() => (catalog.error.value ? getErrorMessage(catalog.error.value, 'Failed to load items') : null))
// A product's one editor is in Catalog: a collection is a way into it, never
// its parent, so the row opens the same record Catalog does, in this scope.
const catalogPath = computed(() => `/dashboard/${String(route.params.orgSlug)}/products`)
const scoped = (path: string, query: Record<string, string | undefined> = {}) => router.resolve({ path, query: { location_id: locationId.value ?? undefined, ...query } }).fullPath
const listItems = computed(() => products.value.map(row => ({ id: row.id, title: row.name, to: scoped(`${catalogPath.value}/${row.id}`), row })))
// Another collection in the same scope: the site-wide ones, or this one's location's.
const moveTargets = computed(() => collections.value.filter(row => row.id !== collectionId.value && row.location_id === collection.value?.location_id))

useSeoMeta({ title: () => `${collection.value?.name ?? 'Section'} | Krabiclaw Dashboard`, robots: 'noindex, nofollow' })

const { locations } = await useOrganizationLocations()
const { priceLabel } = useCatalogPrice(locationId, locations)

const load = catalog.refresh

// A category that is not in the catalog is not a page. Thrown from an effect it
// would be an unhandled rejection rather than the 404 screen, so it is shown.
watchEffect(() => {
  if (!catalog.pending.value && catalog.collections.value.length && !collection.value) {
    showError(createError({ statusCode: 404, statusMessage: 'Section not found' }))
  }
})

/** Local while the edit state is open; committed once when it closes. */
function moveProduct(item: { row: Product }, direction: -1 | 1) {
  const index = products.value.findIndex(row => row.id === item.row.id)
  const target = index + direction
  if (index < 0 || target < 0 || target >= products.value.length) return
  const next = [...products.value]
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved!)
  localOrder.value = next
  orderDirty.value = true
}

/**
 * Save the pending order and return the order this collection now has.
 *
 * The caller needs that list: once the local order is cleared, `products`
 * recomputes from a catalog that has not been refetched, so it reads back the
 * order from before the reorder. A caller that then sent it as definitive
 * silently undid what the merchant had just arranged. Null means the save
 * failed and the list was reloaded.
 */
async function commitOrder(): Promise<string[] | null> {
  const order = products.value.map(row => row.id)
  if (!orderDirty.value) return order
  orderDirty.value = false
  localOrder.value = null
  orderError.value = null
  try {
    // The complete intended membership and order for this collection.
    await dashboardApi(`/api/editor/organizations/${organizationId}/collections/${collectionId.value}/products`, {
      method: 'PUT',
      body: { product_ids: order },
      validate: isRecord,
    })
  } catch (error) {
    orderError.value = getErrorMessage(error, 'Failed to save the new order')
    await load()
    return null
  }
  return order
}

watch(editing, (value, previous) => {
  if (previous && !value) void commitOrder()
})

const moveDialogOpen = ref(false)
const moveTargetId = ref('')
const moving = ref(false)

watch(moveDialogOpen, (open) => {
  if (open) {
    moveTargetId.value = ''
    moveError.value = null
  }
})

async function moveSelected() {
  if (!moveTargetId.value || !selected.value.length) return
  moving.value = true
  moveError.value = null
  try {
    // Commit any pending reorder first. Closing the edit state below would
    // otherwise fire commitOrder with the pre-move list, sending IDs that no
    // longer belong to this category.
    const committed = await commitOrder()
    if (!committed) return
    // Moving is a membership change: the products leave this collection and
    // join the target, and each collection's order is sent whole.
    const remaining = committed.filter(productId => !selected.value.includes(productId))
    const targetPositions = new Map<string, number>()
    for (const product of catalog.products.value) {
      const membership = product.collections.find(entry => entry.collection_id === moveTargetId.value)
      if (membership) targetPositions.set(product.id, membership.sort_order)
    }
    const targetOrder = [...targetPositions.keys()]
      .sort((left, right) => targetPositions.get(left)! - targetPositions.get(right)!)
      .concat(selected.value.filter(id => !targetPositions.has(id)))
    await dashboardApi(`/api/editor/organizations/${organizationId}/collections/${collectionId.value}/products`, {
      method: 'PUT', body: { product_ids: remaining }, validate: isRecord,
    })
    await dashboardApi(`/api/editor/organizations/${organizationId}/collections/${moveTargetId.value}/products`, {
      method: 'PUT', body: { product_ids: targetOrder }, validate: isRecord,
    })
    moveDialogOpen.value = false
    selected.value = []
    editing.value = false
    await load()
  } catch (error) {
    moveError.value = getErrorMessage(error, 'Failed to move items')
  } finally {
    moving.value = false
  }
}

const removing = ref(false)

/** Takes the selected items out of this section; the section's remaining order is sent whole. */
async function removeSelected() {
  if (!selected.value.length) return
  removing.value = true
  orderError.value = null
  try {
    const committed = await commitOrder()
    if (!committed) return
    await dashboardApi(`/api/editor/organizations/${organizationId}/collections/${collectionId.value}/products`, {
      method: 'PUT', body: { product_ids: committed.filter(productId => !selected.value.includes(productId)) }, validate: isRecord,
    })
    selected.value = []
    editing.value = false
    await load()
  } catch (error) {
    orderError.value = getErrorMessage(error, 'Failed to remove items from this section')
  } finally {
    removing.value = false
  }
}


/**
 * Adding opens Catalog's own create walk, the same screen every offering is
 * created on, naming this section so the new item joins it.
 */
function openNew() {
  void navigateTo(scoped(`${catalogPath.value}/new/kind`, { collection_id: collectionId.value }))
}



// Resets this list's own edit state when the catalog underneath it changes.
// It does not refetch: the catalog is one keyed `useAsyncData` whose key holds
// the location, so it reloads itself. Calling `refresh` here as well turned
// `pending` true for every level sharing that key, and the server rendered the
// catalog column as skeletons while the payload beside it already held the rows.
watch([locationId, collectionId], () => {
  orderDirty.value = false
  localOrder.value = null
  editing.value = false
  moveDialogOpen.value = false
  selected.value = []
}, { immediate: true })

</script>
