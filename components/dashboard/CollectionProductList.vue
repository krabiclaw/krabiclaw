<template>
  <!--
    One section: the rows that describe it — name, description, photo — then
    its items in the order guests see them, each opening its one editor in Catalog.
  -->
  <DashboardIndexPanel id="menu-section" :title="collection?.name ?? 'Section'">
    <EditorNavigationList class="mb-8" :groups="rows" :active-item="level.child.value" />
    <DashboardListEditor
      v-model:editing="editing"
      v-model:selected="selected"
      :title="collection?.name ?? 'Section'"
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
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import DashboardMediaThumb from '~/components/dashboard/DashboardMediaThumb.vue'
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import type { Product } from '~/server/types/products'
import { getErrorMessage } from '~/utils/errors'
import { groupProductsByCollection } from '~/utils/product-presentation'

defineProps<{ /** The rows that describe the section, from its editor. */ rows: EditorNavigationGroup[] }>()


const route = useRoute()
const level = useRouteLevel()
const router = useRouter()
const dashboardApi = useDashboardApi()
const organizationId = await useDashboardOrganizationId()
const collectionId = computed(() => String(route.params.collectionId ?? route.params.categoryId ?? ''))
const locationId = useLocationScope()

// A section's membership is edited whole. Location is only the price/editor
// scope; filtering the membership source here would remove its other members.
const catalog = useProductCatalog(organizationId, ref(null))
await catalog.load
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
const products = computed(() => localOrder.value
  ?? groupProductsByCollection(catalog.products.value, collections.value).find(group => group.id === collectionId.value)?.products
  ?? [])

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

useSeoMeta({ title: () => `${collection.value?.name ?? 'Section'} | KrabiClaw Dashboard`, robots: 'noindex, nofollow' })

const { locations } = await useOrganizationLocations()
const { priceLabel } = useCatalogPrice(locationId, locations)

const load = catalog.refresh

// A category that is not in the catalog is not a page. Thrown from an effect it
// would be an unhandled rejection rather than the 404 screen, so it is shown.
watchEffect(() => {
  if (!catalog.pending.value && !catalog.error.value && !collection.value) {
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
 * The caller needs that complete list for a subsequent move or removal.
 * Refresh the canonical catalog before discarding the displayed draft.
 * Null means the save failed and its error is shown.
 */
async function commitOrder(): Promise<string[] | null> {
  const sourceId = collectionId.value
  const order = products.value.map(row => row.id)
  const hadDraft = orderDirty.value
  orderDirty.value = false
  orderError.value = null
  try {
    // A create walk or another section can have changed the shared cache since
    // this list opened. Every replacement starts from the current full set.
    await load()
    if (catalog.error.value) throw catalog.error.value
    if (!collections.value.some(collection => collection.id === sourceId)) throw new Error('This section no longer exists.')
    const current = groupProductsByCollection(catalog.products.value, collections.value).find(group => group.id === sourceId)?.products.map(product => product.id) ?? []
    if (!hadDraft) return current
    if (JSON.stringify([...current].sort()) !== JSON.stringify([...order].sort())) throw new Error('Section membership changed. Review its current items before reordering them.')
    // The complete intended membership and order for this collection.
    await dashboardApi(`/api/editor/organizations/${organizationId}/collections/${sourceId}/products`, {
      method: 'PUT',
      body: { product_ids: order },
      validate: isRecord,
    })
    await load()
    if (catalog.error.value) throw catalog.error.value
    if (collectionId.value === sourceId) localOrder.value = null
    const persisted = groupProductsByCollection(catalog.products.value, collections.value).find(group => group.id === sourceId)?.products.map(product => product.id) ?? []
    if (JSON.stringify(persisted) !== JSON.stringify(order)) throw new Error('Section membership changed. Review its current order before editing again.')
  } catch (error) {
    if (collectionId.value === sourceId) localOrder.value = null
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
  const sourceId = collectionId.value, targetId = moveTargetId.value
  const selectedIds = [...selected.value]
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
    const remaining = committed.filter(productId => !selectedIds.includes(productId))
    const targetMembers = groupProductsByCollection(catalog.products.value, collections.value)
      .find(group => group.id === targetId)?.products.map(product => product.id) ?? []
    const targetOrder = targetMembers.concat(selectedIds.filter(id => !targetMembers.includes(id)))
    // Add to the destination before leaving the source. A failed destination
    // write must never leave the selected products in neither section.
    await dashboardApi(`/api/editor/organizations/${organizationId}/collections/${targetId}/products`, {
      method: 'PUT', body: { product_ids: targetOrder }, validate: isRecord,
    })
    await dashboardApi(`/api/editor/organizations/${organizationId}/collections/${sourceId}/products`, {
      method: 'PUT', body: { product_ids: remaining }, validate: isRecord,
    })
    await load()
    if (catalog.error.value) throw catalog.error.value
    const persistedGroups = groupProductsByCollection(catalog.products.value, collections.value)
    const persistedSource = persistedGroups.find(group => group.id === sourceId)?.products.map(product => product.id) ?? []
    const persistedTarget = persistedGroups.find(group => group.id === targetId)?.products.map(product => product.id) ?? []
    if (JSON.stringify(persistedSource) !== JSON.stringify(remaining)
      || JSON.stringify(persistedTarget) !== JSON.stringify(targetOrder)) throw new Error('Section membership changed. Review the current sections before moving items again.')
    if (collectionId.value === sourceId) {
      moveDialogOpen.value = false
      selected.value = []
      editing.value = false
    }
  } catch (error) {
    moveError.value = getErrorMessage(error, 'Failed to move items')
    await load()
  } finally {
    moving.value = false
  }
}

const removing = ref(false)

/** Takes the selected items out of this section; the section's remaining order is sent whole. */
async function removeSelected() {
  if (!selected.value.length) return
  const sourceId = collectionId.value
  const selectedIds = [...selected.value]
  removing.value = true
  orderError.value = null
  try {
    const committed = await commitOrder()
    if (!committed) return
    const remaining = committed.filter(productId => !selectedIds.includes(productId))
    await dashboardApi(`/api/editor/organizations/${organizationId}/collections/${sourceId}/products`, {
      method: 'PUT', body: { product_ids: remaining }, validate: isRecord,
    })
    await load()
    if (catalog.error.value) throw catalog.error.value
    const persisted = groupProductsByCollection(catalog.products.value, collections.value).find(group => group.id === sourceId)?.products.map(product => product.id) ?? []
    if (JSON.stringify(persisted) !== JSON.stringify(remaining)) throw new Error('Section membership changed. Review its current items before removing any more.')
    if (collectionId.value === sourceId) {
      selected.value = []
      editing.value = false
    }
  } catch (error) {
    orderError.value = getErrorMessage(error, 'Failed to remove items from this section')
    await load()
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
// The full catalog is one keyed read. Changing the price scope never narrows
// the membership that a subsequent edit writes.
watch([locationId, collectionId], () => {
  orderDirty.value = false
  localOrder.value = null
  editing.value = false
  moveDialogOpen.value = false
  selected.value = []
}, { immediate: true })

</script>
