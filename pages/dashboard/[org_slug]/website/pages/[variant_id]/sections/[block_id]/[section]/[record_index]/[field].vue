<template>
  <DashboardLeafPanel
    id="organization-page-block-record-field"
    :title="title"
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
      :field="field"
    />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { useTenantPageId } from '~/components/dashboard/TenantPageEditorPage.vue'
import TenantPageBlockItemEditor, { useTenantPageBlockRecords } from '~/components/dashboard/TenantPageBlockItemEditor.vue'
import { tenantPageBlockEditorKey } from '~/components/dashboard/TenantPageBlockEditorPage.vue'
import type { TenantPageBlockCollection } from '~/utils/tenant-page-block-sections'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const editor = inject(tenantPageBlockEditorKey)!
const pageId = useTenantPageId().value
const blockId = String(route.params.block_id ?? '')
const key = String(route.params.section ?? '')
const field = String(route.params.field ?? '')
const organizationId = useDashboardOrganizationId()

const collection = computed<TenantPageBlockCollection>(() => {
  const section = editor.sections.value.find(candidate => candidate.key === key)
  return (section?.kind === 'list' ? section.collection : key) as TenantPageBlockCollection
})
const recordIndex = computed(() => Number(route.params.record_index))
const records = useTenantPageBlockRecords(organizationId, pageId, blockId, collection, recordIndex)
const title = computed(() => records.recordSections.value.find(section => section.key === field)?.label ?? records.recordTitle.value)
</script>
