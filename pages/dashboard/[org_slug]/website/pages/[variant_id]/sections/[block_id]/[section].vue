<template>
  <!--
    One concern of a section. A concern that is a list of records is an index
    of them; anything else is the leaf that edits it.
  -->
  <DashboardIndexPanel v-if="collection" id="organization-page-block-records" :title="records.noun.value.plural">
    <UAlert v-if="editor.errorMessage.value" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="editor.errorMessage.value" />
    <DashboardListEditor
      v-model:editing="editing"
      :title="records.noun.value.plural"
      :items="listItems"
      :empty-title="`No ${records.noun.value.plural.toLowerCase()} yet`"
      empty-icon="i-lucide-list"
      :add-label="records.noun.value.add"
      reorderable
      @add="navigateTo(`${level.path.value}/${records.addRecord()}`)"
      @remove="records.removeRecord"
      @move="records.move"
    >
    </DashboardListEditor>

    <template v-if="!editor.saveDisabled.value" #footer>
      <DashboardPanelFooter :loading="editor.saving.value" :disabled="editor.saveDisabled.value" @cancel="editor.revert" @save="editor.save" />
    </template>
  </DashboardIndexPanel>

  <DashboardLeafPanel
    v-else
    id="organization-page-block-section"
    :title="section?.label ?? 'Section'"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :save-label="editor.saveLabel.value"
    :error="editor.loadError.value ?? editor.errorMessage.value"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <TenantPageBlockFields
      v-if="section && editor.block.value"
      :organization-id="organizationId"
      :page-id="pageId"
      :block-id="blockId"
      :section-key="section.key"
      @split-insert="editor.splitMarkdown"
    />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { useTenantPageId } from '~/components/dashboard/TenantPageEditorPage.vue'
import DashboardListEditor from '~/components/dashboard/DashboardListEditor.vue'
import TenantPageBlockFields from '~/components/dashboard/TenantPageBlockFields.vue'
import { tenantPageBlockEditorKey } from '~/components/dashboard/TenantPageBlockEditorPage.vue'
import { useTenantPageBlockRecords } from '~/components/dashboard/TenantPageBlockItemEditor.vue'
import type { TenantPageBlockCollection } from '~/utils/tenant-page-block-sections'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const level = useRouteLevel()
const editor = inject(tenantPageBlockEditorKey)!
const pageId = useTenantPageId().value
const blockId = String(route.params.block_id ?? '')
const key = String(route.params.section ?? '')
const organizationId = useDashboardOrganizationId()

const section = computed(() => editor.sections.value.find(candidate => candidate.key === key) ?? null)
/** Set when this concern is a list of records: by its section, or because a one-section block hangs its records straight off itself. */
const collection = computed<TenantPageBlockCollection | null>(() => {
  if (section.value?.kind === 'list') return section.value.collection ?? null
  const only = editor.sections.value.length === 1 ? editor.sections.value[0] : null
  return only?.kind === 'list' && only.collection === key ? only.collection : null
})

const editing = ref(false)
const records = useTenantPageBlockRecords(organizationId, pageId, blockId, collection)
const listItems = computed(() => records.listItems.value.map(item => ({ ...item, to: `${level.path.value}/${item.id}` })))
</script>
