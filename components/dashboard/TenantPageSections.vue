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
      <template #item="{ item }">
        <div class="flex items-center gap-4">
          <span class="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-elevated">
            <img v-if="item.image" :src="item.image" alt="" class="size-full object-cover" loading="lazy" decoding="async">
            <UIcon v-else :name="item.icon" class="size-6 text-muted" aria-hidden="true" />
          </span>
          <div class="min-w-0">
            <p class="truncate text-sm font-medium text-highlighted">{{ item.title }}</p>
            <p v-if="item.summary" class="mt-1 line-clamp-2 text-sm text-muted">{{ item.summary }}</p>
          </div>
        </div>
      </template>
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
import { TENANT_PAGE_BLOCK_REGISTRY } from '~/utils/tenant-page-blocks'

const props = defineProps<{ organizationId: string; pageId: string }>()

const level = useRouteLevel()
const { draft, dirty, revert, commit } = useTenantPageDraft(props.organizationId, props.pageId)

const editing = ref(false)
const saving = ref(false)
const errorMessage = ref('')

const listItems = computed(() => draft.value.blocks.map(block => ({
  id: block.id,
  title: TENANT_PAGE_BLOCK_REGISTRY[block.type].label,
  icon: TENANT_PAGE_BLOCK_REGISTRY[block.type].icon,
  image: block.media.find(media => media.slot === 'media' || media.slot === 'gallery')?.thumbnail_url
    || block.media.find(media => media.kind === 'image' && (media.slot === 'media' || media.slot === 'gallery'))?.public_url,
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
