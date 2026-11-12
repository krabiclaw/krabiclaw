<template>
  <!--
    One record. A record with several concerns is an index whose rows are those
    concerns; a record with one is the leaf itself.
  -->
  <DashboardIndexPanel v-if="records.recordSections.value.length" id="organization-page-block-record" :title="records.recordTitle.value" :auto-open="groups[0]?.items.find(item => item.to)?.to ?? null">
    <UAlert v-if="editor.errorMessage.value" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="editor.errorMessage.value" />
    <EditorNavigationList :groups="groups" :active-item="level.child.value" />
  </DashboardIndexPanel>

  <DashboardLeafPanel
    v-else
    id="organization-page-block-record"
    :title="records.recordTitle.value"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.loadError.value ?? editor.errorMessage.value"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <TenantPageBlockItemEditor
      :organization-id="organizationId"
      :page-id="pageId"
      :block-id="blockId"
      :collection="collection"
      :record-index="recordIndex"
      :field="null"
    />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { useTenantPageId } from '~/components/dashboard/TenantPageEditorPage.vue'
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import TenantPageBlockItemEditor, { useTenantPageBlockRecords } from '~/components/dashboard/TenantPageBlockItemEditor.vue'
import { tenantPageBlockEditorKey } from '~/components/dashboard/TenantPageBlockEditorPage.vue'
import { showNotFound } from '~/utils/errors'
import type { TenantPageBlockCollection } from '~/utils/tenant-page-block-sections'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const level = useRouteLevel()
const editor = inject(tenantPageBlockEditorKey)!
const pageId = useTenantPageId().value
const blockId = String(route.params.block_id ?? '')
const key = String(route.params.section ?? '')
const organizationId = useDashboardOrganizationId()

const collection = computed<TenantPageBlockCollection>(() => {
  const section = editor.sections.value.find(candidate => candidate.key === key)
  return (section?.kind === 'list' ? section.collection : key) as TenantPageBlockCollection
})
const recordIndex = computed(() => {
  const value = Number(route.params.record_index)
  return Number.isInteger(value) && value >= 0 ? value : -1
})
const records = useTenantPageBlockRecords(organizationId, pageId, blockId, collection, recordIndex)

// A record that is not there is not a page, and neither is a concern it does not have.
watchEffect(() => {
  // A page that was not read has no records to look in; the page level reports why.
  if (editor.loadError.value) return
  if (!records.record.value) return showNotFound()
  const open = level.child.value
  if (open && !records.recordSections.value.some(section => section.key === open)) showNotFound()
})

const groups = computed<EditorNavigationGroup[]>(() => [{
  id: 'record',
  items: records.recordSections.value.map(section => ({
    id: section.key,
    label: section.label,
    summary: records.leafSummary(section.key),
    placeholder: !records.leafSummary(section.key),
    to: `${level.path.value}/${section.key}`,
  })),
}])
</script>
