<template>
  <!--
    The Links leaf: the page's list of buttons, edited as a draft and written by
    the page's own Save. A link opened from it is a record of its own below
    here, and owns both columns while it is open.
  -->
  <DashboardIndexPanel id="organization-links-items" title="Links">
    <UAlert v-if="editor.loadError.value || editor.errorMessage.value" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="editor.loadError.value ?? editor.errorMessage.value" />
    <DashboardListEditor
      v-if="!editor.loadError.value"
      v-model:editing="editing"
      title="Links"
      :items="listItems"
      empty-title="No links yet"
      empty-icon="i-lucide-link"
      add-label="Add a link"
      reorderable
      @add="navigateTo(`${level.path.value}/new`)"
      @remove="removeItem"
      @move="move"
    >
      <template #item="{ item }">
        <div class="flex items-center gap-2">
          <p class="truncate text-sm font-medium text-highlighted">{{ item.title }}</p>
          <UBadge v-if="item.row.status === 'hidden'" color="neutral" variant="soft" size="sm">hidden</UBadge>
        </div>
        <p class="mt-1 truncate text-sm text-muted">{{ item.row.destination || 'No destination yet' }}</p>
      </template>
    </DashboardListEditor>

    <!-- Reordering and removing are draft edits, committed here. -->
    <template #footer>
      <DashboardPanelFooter :loading="editor.saving.value" :disabled="Boolean(editor.loadError.value)" @cancel="revert" @save="editor.save" />
    </template>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import DashboardListEditor from '~/components/dashboard/DashboardListEditor.vue'
import { linksEditorKey } from '~/components/dashboard/LinksPageEditor.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(linksEditorKey)!
const level = useRouteLevel()
const editing = ref(false)

/** Cancel puts the loaded list back and goes up to the page. */
function revert() {
  editor.revert()
  return navigateTo(level.to.value ?? '/dashboard')
}

const listItems = computed(() => editor.items.value.map(row => ({
  id: row.id,
  title: row.label || 'Untitled link',
  to: `${level.path.value}/${row.id}`,
  row,
})))

/**
 * Removing and reordering stay draft edits applied by this leaf's own Save,
 * which is what this list has always meant by an edit.
 */
function removeItem(item: { id: string }) {
  editor.items.value = editor.items.value
    .filter(entry => entry.id !== item.id)
    .map((entry, sortOrder) => ({ ...entry, sort_order: sortOrder }))
}

function move(item: { id: string }, direction: -1 | 1) {
  const index = editor.items.value.findIndex(entry => entry.id === item.id)
  const nextIndex = index + direction
  if (index < 0 || nextIndex < 0 || nextIndex >= editor.items.value.length) return
  const next = [...editor.items.value]
  const [moved] = next.splice(index, 1)
  if (!moved) return
  next.splice(nextIndex, 0, moved)
  editor.items.value = next.map((entry, sortOrder) => ({ ...entry, sort_order: sortOrder }))
}
</script>
