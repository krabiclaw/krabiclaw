<template>
  <!--
    The page's sections, in the order the page shows them. Reordering and
    removing are edits to the page draft, committed once from this level's own
    footer — never a write per press. A section is a level below this one.
  -->
  <DashboardIndexPanel id="organization-page-sections" title="Sections">
    <UAlert v-if="errorMessage" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="errorMessage" />
    <DashboardListEditor
      v-model:editing="editing"
      title="Sections"
      :items="listItems"
      empty-title="No sections yet"
      empty-icon="i-lucide-layout-list"
      add-label="Add a section"
      reorderable
      @add="navigateTo(`${level.path.value}/new`)"
      @remove="remove"
      @move="move"
    >
    </DashboardListEditor>

    <template v-if="dirty" #footer>
      <DashboardPanelFooter :loading="saving" :disabled="!dirty" @cancel="cancel" @save="save" />
    </template>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import DashboardListEditor from '~/components/dashboard/DashboardListEditor.vue'
import { getErrorMessage } from '~/utils/errors'
import { tenantPageBlockSummary } from '~/utils/tenant-page-editor'
import { tenantPageBlockLabel } from '~/utils/tenant-page-block-sections'

const props = defineProps<{ organizationId: string; pageId: string }>()

const level = useRouteLevel()
const { draft, dirty, revert, commit } = useTenantPageDraft(props.organizationId, props.pageId)

const editing = ref(false)
const saving = ref(false)
const errorMessage = ref('')

const listItems = computed(() => draft.value.blocks.map(block => ({
  id: block.id,
  title: tenantPageBlockLabel(block.type),
  summary: tenantPageBlockSummary(block),
  to: `${level.path.value}/${block.id}`,
})))

function reindex() {
  draft.value.blocks = draft.value.blocks.map((block, position) => ({ ...block, position }))
}

function remove(item: { id: string }) {
  draft.value.blocks = draft.value.blocks.filter(block => block.id !== item.id)
  reindex()
}

function move(item: { id: string }, direction: -1 | 1) {
  const index = draft.value.blocks.findIndex(block => block.id === item.id)
  const nextIndex = index + direction
  if (index < 0 || nextIndex < 0 || nextIndex >= draft.value.blocks.length) return
  const next = [...draft.value.blocks]
  const [moved] = next.splice(index, 1)
  if (!moved) return
  next.splice(nextIndex, 0, moved)
  draft.value.blocks = next
  reindex()
}

async function save() {
  saving.value = true
  errorMessage.value = ''
  try {
    await commit()
  } catch (cause) {
    errorMessage.value = getErrorMessage(cause, 'Failed to save this page')
  } finally {
    saving.value = false
  }
}

function cancel() {
  errorMessage.value = ''
  revert()
}
</script>
