<template>
  <DashboardIndexPanel id="product-collections" :title="p.sectionLabels.collections" column="leaf">
    <template #right>
      <UButton :label="'Add to ' + noun" color="neutral" variant="soft" :disabled="blocked" @click="openAdd" />
    </template>
    <UAlert v-if="loadError || error" class="mb-6" color="error" variant="soft" :description="loadError || error || ''" />
    <template v-if="p.product.value && !loadError">
      <ul v-if="memberships.length" class="divide-y divide-default border-y border-default">
        <li v-for="collection in memberships" :key="collection.id" class="py-5">
          <NuxtLink :to="sectionPath(collection)" class="flex items-center gap-4 no-underline">
            <DashboardMediaThumb :asset="collection.image" :label="collection.name" fallback-icon="i-lucide-image" />
            <span class="min-w-0 flex-1">
              <span class="block font-semibold text-highlighted">{{ collection.name }}</span>
              <span class="mt-1 block text-sm text-muted">{{ scopeLabel(collection) }}</span>
            </span>
          </NuxtLink>
          <div class="mt-4 flex gap-2">
            <UButton label="Move" :aria-label="'Move from ' + collection.name" color="neutral" variant="soft" :disabled="blocked" @click="openMove(collection.id)" />
            <UButton :label="'Remove from ' + noun" :aria-label="'Remove from ' + collection.name" color="neutral" variant="ghost" :disabled="blocked" @click="removeFrom(collection.id)" />
          </div>
        </li>
      </ul>
      <p v-else class="text-sm text-muted">{{ noun === 'section' ? 'Not in a menu section.' : 'Not in a collection.' }}</p>
    </template>

    <DashboardListItemDialog
      v-model:open="addOpen"
      :title="'Add to ' + noun"
      :removable="false"
      :saving="p.saving.value"
      :save-disabled="!addTarget || blocked"
      save-label="Add"
      :error="addError"
      @save="addTo"
    >
      <URadioGroup v-if="addTargets.length" v-model="addTarget" :items="addTargets" variant="card" :disabled="blocked" />
      <p v-else class="text-sm text-muted">{{ noun === 'section' ? 'This dish is already in every section.' : 'This item is already in every collection.' }}</p>
    </DashboardListItemDialog>
    <CollectionMoveDialog
      v-model:open="moveOpen"
      v-model:saving="p.saving.value"
      :organization-id="p.organizationId"
      :source-collection-id="moveSource"
      :product-ids="moveSnapshot"
      :selected-product-ids="p.product.value ? [p.product.value.id] : []"
      :expected-product-ids="moveSnapshot"
      :after-save="p.reload"
      :menu="p.product.value?.kind === 'dish'"
      @reset="refreshCurrent"
    />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import DashboardMediaThumb from '~/components/dashboard/DashboardMediaThumb.vue'
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import CollectionMoveDialog from '~/components/dashboard/CollectionMoveDialog.vue'
import type { Collection } from '~/server/types/products'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const route = useRoute()
const router = useRouter()
const catalog = useProductCatalog(p.organizationId, ref(null))
await catalog.load
const { locations, error: locationsError } = await useOrganizationLocations({ includeInactive: true })
const noun = computed(() => p.product.value?.kind === 'dish' ? 'section' : 'collection')
const error = ref<string | null>(null)
const loadError = computed(() => p.loadError.value || (locationsError.value ? getErrorMessage(locationsError.value, 'The section locations could not be loaded') : null) || (catalog.error.value ? getErrorMessage(catalog.error.value, 'The sections could not be loaded') : null))
const blocked = computed(() => p.saving.value || Boolean(loadError.value) || !p.product.value)
const memberships = computed(() => {
  if (!p.product.value || loadError.value) return []
  return p.product.value.collections.map(membership => {
    const collection = catalog.collections.value.find(collection => collection.id === membership.collection_id)
    if (!collection) throw createError({ statusCode: 500, statusMessage: 'The saved section could not be loaded' })
    return collection
  })
})
function scopeLabel(collection: Collection) {
  if (collection.location_id === null) return 'Shared by every location'
  const location = locations.value.find(location => location.id === collection.location_id)
  if (!location) throw createError({ statusCode: 500, statusMessage: 'The section location could not be loaded' })
  return location.status === 'active' ? location.title : `${location.title} · Location inactive`
}
function sectionPath(collection: Collection) {
  return router.resolve({ path: '/dashboard/' + String(route.params.orgSlug) + '/products/menu/' + collection.id, query: { location_id: collection.location_id ?? undefined, kind: p.product.value?.kind === 'dish' ? 'dish' : undefined } }).fullPath
}

const addOpen = ref(false)
const addTarget = ref('')
const addSnapshots = ref<Record<string, string[]>>({})
const addError = ref<string | null>(null)
const addTargets = computed(() => loadError.value ? [] : catalog.collections.value.filter(collection => !memberships.value.some(saved => saved.id === collection.id)).map(collection => ({
  value: collection.id, label: collection.name, description: scopeLabel(collection),
})))
function openAdd() {
  if (blocked.value) return
  addTarget.value = ''
  addError.value = null
  addSnapshots.value = Object.fromEntries(addTargets.value.map(target => [target.value, catalog.collectionProductIds(target.value)]))
  addOpen.value = true
}
async function addTo() {
  if (blocked.value || !addTarget.value || !p.product.value) return
  const expected = addSnapshots.value[addTarget.value]
  if (!expected) { addError.value = 'Choose a section from the current list.'; return }
  p.saving.value = true
  addError.value = null
  try {
    await catalog.setCollectionProducts(addTarget.value, expected.includes(p.product.value.id) ? expected : [...expected, p.product.value.id], expected)
    await p.reload()
    addOpen.value = false
  } catch (cause) { addError.value = getErrorMessage(cause, 'The membership could not be added') }
  finally { p.saving.value = false }
}
async function removeFrom(collectionId: string) {
  if (blocked.value || !p.product.value) return
  const productId = p.product.value.id
  const expected = catalog.collectionProductIds(collectionId)
  p.saving.value = true
  error.value = null
  try {
    await catalog.setCollectionProducts(collectionId, expected.filter(id => id !== productId), expected)
    await p.reload()
  } catch (cause) { error.value = getErrorMessage(cause, 'The membership could not be removed') }
  finally { p.saving.value = false }
}
const moveOpen = ref(false)
const moveSource = ref('')
const moveSnapshot = ref<string[]>([])
function openMove(collectionId: string) {
  if (blocked.value) return
  moveSource.value = collectionId
  moveSnapshot.value = catalog.collectionProductIds(collectionId)
  moveOpen.value = true
}
async function refreshCurrent() {
  p.saving.value = true
  error.value = null
  try { await p.reload() }
  catch (cause) { error.value = getErrorMessage(cause, 'The item could not be read again') }
  finally { p.saving.value = false }
}
watch(() => route.params.productId, () => {
  addOpen.value = false
  moveOpen.value = false
  addTarget.value = ''
  error.value = null
  addError.value = null
})
onBeforeRouteLeave(() => !p.saving.value)
onBeforeRouteUpdate(() => !p.saving.value)
</script>
