<template>
  <!--
    An existing collection is its list of products; one being created has only
    its name to give. Either way the level below is a leaf or a product.
  -->
  <CollectionProductList v-if="!isNew" :rows="collectionNavigation" />
  <DashboardIndexPanel v-else id="menu-section-new" :title="newTitle" :create="firstStep">
    <UAlert v-if="errorMessage" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="errorMessage" />
    <EditorNavigationList :groups="collectionNavigation" :active-item="level.child.value" />
  </DashboardIndexPanel>
</template>

<script lang="ts">
import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { Collection } from '~/server/types/products'

/** The section's fields — its name, the description that introduces it, its picture — and the walk that creates it. */
export interface CollectionEditor {
  form: { name: string; description: string }
  /** The section's own picture as stored; a photo saves the moment it is chosen. */
  image: ComputedRef<Collection['image']>
  imageError: Ref<string>
  setImage: (assetId: string | null) => Promise<void>
  isNew: ComputedRef<boolean>
  collectionId: ComputedRef<string>
  organizationId: string
  hasRecord: ComputedRef<boolean>
  saving: Ref<boolean>
  errorMessage: Ref<string>
  saveLabel: Ref<string | undefined>
  saveDisabled: Ref<boolean>
  localizationFields: ComputedRef<Array<{ key: string; label: string; source: string | null | undefined }>>
  organizationLocalizationSettingsPath: ComputedRef<string>
  revert: () => void
  save: () => Promise<void>
}

export const collectionEditorKey = Symbol('collection-editor') as InjectionKey<CollectionEditor>
</script>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import CollectionProductList from '~/components/dashboard/CollectionProductList.vue'
import { getErrorMessage } from '~/utils/errors'
import { mediaStillUrl } from '~/shared/media-placement-contract'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const router = useRouter()
const dashboardApi = useDashboardApi()
const collectionId = computed(() => String(route.params.collectionId ?? ''))


const level = useRouteLevel()
const collectionPath = level.path

const organizationId = await useDashboardOrganizationId()

// Catalog's scope: a collection created here belongs to the location the URL
// names, or to the whole site when it names none.
const locationId = useLocationScope()

// The same catalog the list reads, so the Name leaf's draft costs no request.
const catalog = useProductCatalog(organizationId, locationId)
const collection = computed(() => catalog.collections.value.find(row => row.id === collectionId.value) ?? null)

// ── The collection record ───────────────────────────────
const isNew = computed(() => collectionId.value === 'new')
const COLLECTION_LABELS = { name: 'Name', description: 'Description', photo: 'Photo' } as const
type CollectionLeaf = keyof typeof COLLECTION_LABELS
const openKey = computed<CollectionLeaf>(() => 'name')

// A collection being created has one leaf; anything else below it is not a page.
watchEffect(() => {
  if (isNew.value && level.child.value && level.child.value !== 'name') {
    showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
  }
})

// One draft, so it survives the remount between this collection's sections. The
// key cannot carry the collection id — it is read once at setup while Nuxt
// reuses this page across collections — so the watch below re-seeds it instead.
const form = useState(`collection-draft-${organizationId}`, () => ({ name: '', description: '' })).value
function seed(row: Collection | null) {
  form.name = row?.name ?? ''
  form.description = row?.description ?? ''
}
// Seeded when the page moves to another collection or its record first arrives;
// a refreshed row never overwrites what is being typed. Nuxt reuses this page
// across collections, and a record that has not arrived leaves nothing behind.
watch([collectionId, () => collection.value !== null], () => seed(collection.value), { immediate: true })

const saving = ref(false)
const errorMessage = ref('')

function fieldPath(field: CollectionLeaf) {
  return router.resolve({ path: `${collectionPath.value}/${field}`, query: { location_id: (isNew.value ? locationId.value : collection.value?.location_id) ?? undefined } }).fullPath
}

// A section being created gives only its name; once it exists it also has the
// description and picture that introduce it on the site.
const collectionNavigation = computed<EditorNavigationGroup[]>(() => [{
  id: 'collection',
  items: [
    { id: 'name', label: 'Name', summary: (isNew.value ? form.name : collection.value?.name)?.trim() || 'Not named yet', placeholder: !(isNew.value ? form.name : collection.value?.name)?.trim(), to: fieldPath('name') },
    ...(isNew.value ? [] : [
      { id: 'description', label: 'Description', summary: collection.value?.description?.trim() || 'Not added', placeholder: !collection.value?.description?.trim(), to: fieldPath('description') },
      { id: 'photo', label: 'Photo', summary: collection.value?.image ? 'Section photo' : 'No photo', placeholder: !collection.value?.image, to: fieldPath('photo'), image: mediaStillUrl(collection.value?.image) },
    ]),
  ],
}])
const collectionLocalizationFields = computed(() => [{ key: 'name', label: 'Name', source: collection.value?.name }])
const organizationLocalizationSettingsPath = computed(() => `/dashboard/${route.params.orgSlug}/website/localization`)

const { title: newTitle, firstStep, saveLabel, saveDisabled, save: saveLeaf } = useCreateWalk({
  recordPath: collectionPath,
  isNew,
  openKey,
  labels: COLLECTION_LABELS,
  order: ['name'],
  missing: () => !form.name.trim(),
  noun: 'section',
  saving,
  commit,
})

const isCollectionCreated = (value: unknown): value is { collection: { id: string } } =>
  isRecord(value) && isRecord(value.collection) && typeof value.collection.id === 'string'

async function commit() {
  if (saving.value) return
  saving.value = true
  errorMessage.value = ''
  let createdId: string | null = null
  let committed = false
  try {
    const endpoint = `/api/editor/organizations/${organizationId}/collections`
    if (isNew.value) {
      const created = await dashboardApi(endpoint, { method: 'POST', body: { name: form.name.trim(), location_id: locationId.value }, validate: isCollectionCreated })
      createdId = created.collection.id
    } else {
      await dashboardApi(`${endpoint}/${collectionId.value}`, { method: 'PATCH', body: level.child.value === 'description' ? { description: form.description.trim() || null } : { name: form.name.trim() }, validate: isRecord })
    }
    committed = true
    if (createdId) form.name = ''
    await catalog.refresh()
    if (createdId) await navigateTo(router.resolve({ path: collectionPath.value.replace(/\/new$/, `/${createdId}`), query: route.query }).fullPath, { replace: true })
    else await level.close()
  } catch (error) {
    errorMessage.value = `${committed ? 'The section was saved, but its editor could not be updated. ' : ''}${getErrorMessage(error, 'The section could not be saved')}`
  } finally {
    saving.value = false
  }
}

/** A cancelled leaf puts the stored fields back before it closes. */
function revert() {
  errorMessage.value = ''
  if (collection.value) seed(collection.value)
}

const imageError = ref('')
async function setImage(assetId: string | null) {
  imageError.value = ''
  try {
    await dashboardApi(`/api/editor/organizations/${organizationId}/media/placements`, {
      method: 'PUT',
      body: { placement: { owner_type: 'collection', owner_id: collectionId.value, slot: 'image' }, asset_id: assetId },
      validate: isRecord,
    })
    await catalog.refresh()
  } catch (error) {
    imageError.value = getErrorMessage(error, 'Failed to update the photo')
  }
}

provide(collectionEditorKey, {
  form,
  image: computed(() => collection.value?.image ?? null),
  imageError,
  setImage,
  isNew,
  collectionId,
  organizationId,
  hasRecord: computed(() => Boolean(collection.value)),
  saving,
  errorMessage,
  saveLabel,
  saveDisabled,
  localizationFields: collectionLocalizationFields,
  organizationLocalizationSettingsPath,
  revert,
  save: saveLeaf,
})
</script>
