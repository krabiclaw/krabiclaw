<template>
  <DashboardIndexPanel id="menu-section" :title="collection?.name ?? 'Collection'">
    <EditorNavigationList class="mb-10" :groups="rows" :active-item="level.child.value" variant="cards" />
    <h2 class="mb-4 text-xl font-semibold text-highlighted">Items</h2>
    <DashboardListEditor
      v-model:editing="editing"
      v-model:selected="selected"
      :title="collection?.name ?? 'Collection'"
      :items="listItems"
      :error="loadError"
      :disabled="busy || Boolean(loadError)"
      :addable="!editing"
      :empty-title="`No items in this ${noun} yet`"
      :empty-icon="menuSection ? 'i-lucide-utensils' : 'i-lucide-folder'"
      :add-label="menuSection ? 'Add dish' : 'Add item'"
      reorderable
      selectable
      @add="openAdd"
      @move="moveProduct"
    >
      <template #selection-actions>
        <UButton label="Move" color="neutral" variant="soft" data-testid="product-move-open" :disabled="busy || Boolean(loadError)" @click="moveDialogOpen = true" />
        <UButton :label="`Remove from ${noun}`" color="neutral" variant="soft" :loading="removing" :disabled="busy || Boolean(loadError)" data-testid="product-remove-from-section" @click="removeSelected" />
      </template>
      <template #item="{ item }">
        <span class="flex w-full items-center gap-4 text-left" :data-testid="'product-' + item.id">
          <DashboardMediaThumb :asset="item.row.image" :label="item.row.name" fallback-icon="i-lucide-image" size="lg" />
          <span class="min-w-0 flex-1">
            <span class="block text-base font-semibold text-highlighted">{{ item.row.name }}</span>
            <span class="mt-1 block text-sm tabular-nums text-muted">{{ priceLabel(item.row) || 'No price set' }}</span>
            <span class="mt-2 block text-sm text-muted">{{ item.status }}<span v-if="!item.row.image"> · No photo</span></span>
          </span>
        </span>
      </template>
    </DashboardListEditor>
    <div v-if="orderError" class="mt-4 space-y-3">
      <UAlert color="error" variant="soft" :description="orderError" />
      <UButton label="Use current items" color="neutral" variant="soft" :disabled="busy || Boolean(loadError)" @click="resetEditing" />
    </div>

    <DashboardListItemDialog
      v-model:open="addDialogOpen"
      :title="menuSection ? 'Add dishes' : 'Add items'"
      :removable="false"
      :saving="adding"
      :save-disabled="!addSelected.length || busy"
      save-label="Add"
      :error="addError"
      @save="addExisting"
    >
      <UButton :to="newProductTo" :label="menuSection ? 'Create new dish' : 'Create new item'" color="neutral" variant="soft" block :disabled="busy || Boolean(loadError)" @click="addDialogOpen = false" />
      <UInput v-model="addSearch" :aria-label="menuSection ? 'Search dishes' : 'Search items'" :placeholder="menuSection ? 'Search dishes' : 'Search items'" class="w-full" :disabled="busy || Boolean(loadError)" />
      <ul v-if="addCandidates.length" class="divide-y divide-default">
        <li v-for="dish in addCandidates" :key="dish.id" class="flex items-center gap-3 py-3">
          <DashboardMediaThumb :asset="dish.image" :label="dish.name" fallback-icon="i-lucide-image" />
          <UCheckbox
            :model-value="addSelected.includes(dish.id)"
            :label="dish.name"
            :description="[priceLabel(dish) || 'No price set', itemStatus(dish)].join(' · ')"
            :disabled="busy || Boolean(loadError)"
            class="min-w-0 flex-1"
            @update:model-value="toggleAdd(dish.id)"
          />
        </li>
      </ul>
      <p v-else class="text-sm text-muted">{{ addSearch.trim() ? `No ${menuSection ? 'dishes' : 'items'} match your search.` : `Every existing ${menuSection ? 'dish' : 'item'} is already in this ${noun}.` }}</p>
    </DashboardListItemDialog>

    <CollectionMoveDialog
      v-model:open="moveDialogOpen"
      v-model:saving="moving"
      :organization-id="organizationId"
      :source-collection-id="collectionId"
      :product-ids="products.map(product => product.id)"
      :selected-product-ids="selected"
      :expected-product-ids="expectedOrder()"
      :menu="menuSection"
      @saved="resetEditing"
      @reset="resetEditing"
    />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import DashboardListEditor from '~/components/dashboard/DashboardListEditor.vue'
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import DashboardMediaThumb from '~/components/dashboard/DashboardMediaThumb.vue'
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import { catalogProductItem } from '~/components/dashboard/CatalogProductList.vue'
import CollectionMoveDialog from '~/components/dashboard/CollectionMoveDialog.vue'
import type { Product } from '~/server/types/products'
import { getErrorMessage } from '~/utils/errors'
import { groupProductsByCollection } from '~/utils/product-presentation'

defineProps<{ rows: EditorNavigationGroup[] }>()

const route = useRoute()
const level = useRouteLevel()
const router = useRouter()
const organizationId = await useDashboardOrganizationId()
const collectionId = computed(() => String(route.params.collectionId ?? ''))
const locationId = useLocationScope()
// A section's full membership is independent of the location used for prices.
const catalog = useProductCatalog(organizationId, ref(null))
await catalog.load
const collections = catalog.collections
const collection = computed(() => collections.value.find(row => row.id === collectionId.value) ?? null)
const { locations, error: locationsError } = await useOrganizationLocations({ includeInactive: true })
const { priceLabel } = useCatalogPrice(locationId, locations)
const loadError = computed(() => {
  const cause = catalog.error.value ?? locationsError.value
  return cause ? getErrorMessage(cause, 'The section could not be loaded') : null
})
const catalogPath = computed(() => '/dashboard/' + String(route.params.orgSlug) + '/products')
const scoped = (path: string, query: Record<string, string | undefined> = {}) => router.resolve({ path, query: { location_id: locationId.value ?? undefined, kind: route.query.kind === 'dish' ? 'dish' : undefined, ...query } }).fullPath

function membersFor(id: string): Product[] {
  return groupProductsByCollection(catalog.products.value, collections.value).find(group => group.id === id)?.products ?? []
}
const localOrder = ref<Product[] | null>(null)
const products = computed(() => localOrder.value ?? membersFor(collectionId.value))
// Menu names its own dish scope. Empty or mixed membership never changes it.
const menuSection = computed(() => route.query.kind === 'dish')
const noun = computed(() => menuSection.value ? 'section' : 'collection')
const editing = ref(false)
const selected = ref<string[]>([])
const orderSnapshot = ref<string[] | null>(null)
const orderDirty = ref(false)
const orderError = ref<string | null>(null)
const committing = ref(false)
const moving = ref(false)
const removing = ref(false)
const adding = ref(false)
const busy = computed(() => committing.value || moving.value || removing.value || adding.value)

function itemStatus(product: Product): string {
  const listed = product.publications.some(publication => publication.organization_id === organizationId && publication.published)
  const context = catalogProductItem(product, { collections: collections.value, locations: locations.value, priceLabel, to: '' }).summary
  return [!product.active && (product.kind !== 'service' || product.booking) ? 'Unavailable' : null, listed ? 'Listed' : 'Not listed', context].filter(Boolean).join(' · ')
}
const listItems = computed(() => loadError.value ? [] : products.value.map(row => ({ id: row.id, title: row.name, to: scoped(catalogPath.value + '/' + row.id), row, status: itemStatus(row) })))


useSeoMeta({ title: () => (collection.value?.name ?? 'Section') + ' | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
watchEffect(() => {
  if (!catalog.pending.value && !catalog.error.value && !collection.value) showError(createError({ statusCode: 404, statusMessage: 'Section not found' }))
})

function resetEditing() {
  orderDirty.value = false
  localOrder.value = null
  orderSnapshot.value = null
  selected.value = []
  editing.value = false
  moveDialogOpen.value = false
  orderError.value = null
}
function moveProduct(item: { row: Product }, direction: -1 | 1) {
  const index = products.value.findIndex(row => row.id === item.row.id)
  const target = index + direction
  if (busy.value || index < 0 || target < 0 || target >= products.value.length) return
  const next = [...products.value]
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved!)
  localOrder.value = next
  orderDirty.value = true
}
function expectedOrder(): string[] {
  return orderSnapshot.value ?? membersFor(collectionId.value).map(product => product.id)
}

async function commitOrder(): Promise<boolean> {
  if (committing.value) return false
  if (!orderDirty.value) return true
  const sourceId = collectionId.value
  const order = products.value.map(product => product.id)
  const expected = expectedOrder()
  committing.value = true
  orderError.value = null
  try {
    await catalog.setCollectionProducts(sourceId, order, expected)
    resetEditing()
    return true
  } catch (error) {
    orderError.value = getErrorMessage(error, 'The new order could not be saved')
    return false
  } finally { committing.value = false }
}
watch(editing, (value, previous) => {
  if (value && !previous && !orderDirty.value) orderSnapshot.value = membersFor(collectionId.value).map(product => product.id)
  if (previous && !value && orderDirty.value) void commitOrder()
})

const moveDialogOpen = ref(false)
async function removeSelected() {
  if (busy.value || !selected.value.length) return
  const sourceId = collectionId.value
  const chosen = new Set(selected.value)
  const remaining = products.value.filter(product => !chosen.has(product.id)).map(product => product.id)
  const expected = expectedOrder()
  removing.value = true
  orderError.value = null
  try {
    await catalog.setCollectionProducts(sourceId, remaining, expected)
    resetEditing()
  } catch (error) { orderError.value = getErrorMessage(error, 'The items could not be removed from this section') }
  finally { removing.value = false }
}

const addDialogOpen = ref(false)
const addSearch = ref('')
const addSelected = ref<string[]>([])
const addSnapshot = ref<string[]>([])
const addError = ref<string | null>(null)
const addCandidates = computed(() => catalog.products.value.filter(product => (!menuSection.value || product.kind === 'dish') && !addSnapshot.value.includes(product.id)
  && product.name.toLocaleLowerCase().includes(addSearch.value.trim().toLocaleLowerCase())))
const newProductTo = computed(() => scoped(`${catalogPath.value}/new`, { kind: menuSection.value ? 'dish' : undefined, collection_id: collectionId.value }))
function openAdd() {
  if (busy.value || editing.value || loadError.value) return
  addSnapshot.value = membersFor(collectionId.value).map(product => product.id)
  addSelected.value = []
  addSearch.value = ''
  addError.value = null
  addDialogOpen.value = true
}
function toggleAdd(id: string) {
  addSelected.value = addSelected.value.includes(id) ? addSelected.value.filter(value => value !== id) : [...addSelected.value, id]
}
async function addExisting() {
  if (busy.value || !addSelected.value.length) return
  const sourceId = collectionId.value
  const expected = [...addSnapshot.value]
  const additions = catalog.products.value.filter(product => addSelected.value.includes(product.id)).map(product => product.id)
  adding.value = true
  addError.value = null
  try {
    await catalog.setCollectionProducts(sourceId, [...expected, ...additions], expected)
    addDialogOpen.value = false
    resetEditing()
  } catch (error) { addError.value = getErrorMessage(error, 'The items could not be added') }
  finally { adding.value = false }
}

watch([locationId, collectionId], () => {
  resetEditing()
  addDialogOpen.value = false
}, { immediate: true })
onBeforeRouteLeave(async () => !busy.value && await commitOrder())
onBeforeRouteUpdate(async () => !busy.value && await commitOrder())
</script>
