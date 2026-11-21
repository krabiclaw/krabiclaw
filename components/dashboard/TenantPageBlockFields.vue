<template>
  <div class="space-y-6">
    <TenantPageFieldControl
      v-for="(entry, index) in fields"
      :key="entry.key"
      :organization-id="organizationId"
      :page-id="pageId"
      :block-id="blockId"
      :field-key="entry.key"
      :field="entry.field"
      :autofocus="index === 0"
      :reference-options="referenceOptions(entry.field, entry.key)"
      @split-insert="$emit('splitInsert', $event)"
    />

    <UAlert
      v-if="validationErrors.length"
      color="warning"
      variant="soft"
      icon="i-lucide-triangle-alert"
      title="Needs attention"
      :description="validationErrors.join(' ')"
    />
  </div>
</template>

<script setup lang="ts">
import TenantPageFieldControl from '~/components/dashboard/TenantPageFieldControl.vue'
import { validateTenantPageBlock } from '~/utils/tenant-page-editor'
import { tenantPageBlockFieldsForSection } from '~/utils/tenant-page-block-sections'
import { websiteSettingsKey, type TenantPageListRow } from '~/composables/useTenantPageDraft'
import { isRecord } from '~/utils/api-clients'
import type { TenantPageField } from '~/utils/tenant-page-blocks'

/**
 * The controls of one leaf of one block.
 *
 * The block it is handed is the page draft's own object, so writing a field
 * here is writing the page, and the level that owns the commit bar saves it.
 * That is why this component has no Save of its own and no copy of the block.
 *
 * Which controls those are is the registry's answer, not this file's. It used
 * to be a 200-line `v-if` chain keyed by block type and then by section — a
 * second description of every field, which is how the heading level control
 * came to write a key the writer deletes, and how a testimonial grid offered a
 * source the writer refuses.
 */
const props = defineProps<{
  organizationId: string
  pageId: string
  blockId: string
  sectionKey: string
}>()

defineEmits<{ splitInsert: [{ after: string; blockType: 'image' | 'faq' | 'how_to'; editorMode: 'rich' | 'source' }] }>()

const block = useTenantPageBlock(props.organizationId, props.pageId, () => props.blockId)

const fields = computed(() => tenantPageBlockFieldsForSection(block.value, props.sectionKey))
const validationErrors = computed(() => validateTenantPageBlock(block.value))

// ── Records a reference field may point at ──────────────
const dashboard = useDashboardOrganization()

const needsProducts = computed(() => fields.value.some(entry => entry.field.reference === 'product' || entry.field.reference === 'collection'))

interface NamedRow { id: string; name: string }
const isCollectionsResponse = (value: unknown): value is { collections: NamedRow[] } =>
  isRecord(value) && Array.isArray(value.collections)
    && value.collections.every(row => isRecord(row) && typeof row.id === 'string' && typeof row.name === 'string')
const isProductsResponse = (value: unknown): value is { products: NamedRow[] } =>
  isRecord(value) && Array.isArray(value.products)
    && value.products.every(row => isRecord(row) && typeof row.id === 'string' && typeof row.name === 'string')

const { data: pagesData } = useNuxtData<{ pages: TenantPageListRow[] }>(websiteSettingsKey(String(useRoute().params.org_slug)))

const { data: collectionsData } = await useAsyncData(
  () => `tenant-page-collections-${props.organizationId}`,
  () => useDashboardApi()(`/api/editor/organizations/${props.organizationId}/collections`, { validate: isCollectionsResponse }),
  { immediate: needsProducts.value, watch: [needsProducts], default: () => null },
)

const { data: productsData } = await useAsyncData(
  () => `tenant-page-products-${props.organizationId}`,
  () => useDashboardApi()(`/api/editor/organizations/${props.organizationId}/products`, { validate: isProductsResponse }),
  { immediate: needsProducts.value, watch: [needsProducts], default: () => null },
)

const options = {
  page: computed(() => (pagesData.value?.pages ?? [])
    .filter((row: TenantPageListRow) => row.id !== props.pageId)
    .map((row: TenantPageListRow) => ({ label: row.title, value: row.id }))),
  collection: computed(() => (collectionsData.value?.collections ?? []).map(row => ({ label: row.name, value: row.id }))),
  product: computed(() => (productsData.value?.products ?? []).map(row => ({ label: row.name, value: row.id }))),
  location: computed(() => dashboard.locations.value.map(location => ({ label: location.title, value: location.id }))),
}

function referenceOptions(field: TenantPageField, key: string) {
  if (!field.reference) return undefined
  // One location, or none: the organization-wide choice is a choice too.
  const unscoped = field.reference === 'location' && !key.endsWith('_ids') ? [{ label: 'All locations', value: '' }] : []
  return [...unscoped, ...options[field.reference].value]
}
</script>
