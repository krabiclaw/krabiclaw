<template>
  <section class="space-y-6">
    <!-- The same rule as DashboardListEditor: the panel's navbar carries the grid's controls. -->
    <header>
      <Teleport :to="actionsTarget ? `#${actionsTarget}` : undefined" :disabled="!actionsTarget" defer>
        <div class="flex shrink-0 items-center gap-2" :class="actionsTarget ? undefined : 'justify-end'">
          <slot name="actions" />
          <UButton
            v-if="items.length"
            label="Manage"
            color="neutral"
            variant="soft"
            data-testid="grid-editor-manage"
            @click="openSelection"
          />
          <UButton
            icon="i-lucide-plus"
            :aria-label="addLabel"
            color="neutral"
            variant="soft"
            square
            data-testid="grid-editor-add"
            @click="$emit('add')"
          />
        </div>
      </Teleport>

      <p v-if="description" class="text-sm text-muted">{{ description }}</p>
    </header>

    <slot name="filters" />

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      :title="`${title || 'This list'} could not be loaded`"
      :description="error"
    />

    <UEmpty v-else-if="!items.length" :icon="emptyIcon" :title="emptyTitle" data-testid="grid-editor-empty" />

    <div v-else :class="gridClass">
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        class="group relative aspect-square overflow-hidden rounded-lg border-2 border-transparent text-left"
        :aria-label="`Open ${item.title}`"
        @click="$emit('open', item)"
      >
        <slot name="tile" :item="item" />
      </button>
    </div>

    <!--
      Selecting takes over the viewport rather than living inside the pane. A grid
      being rearranged wants every pixel, and the controls that appear belong to
      the selection rather than to the page underneath — the same reason the
      screens this follows hide their tab bar for it.
    -->
    <div
      v-if="selecting"
      class="fixed inset-0 z-50 flex flex-col bg-default"
      data-testid="grid-editor-takeover"
    >
      <header class="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-default py-3" :class="dashboardGutterClass">
        <!--
          One bar, two sets of controls. With nothing picked it is a way out; with
          a selection it becomes what you can do to it. A second bar sliding in
          under the first would leave the count and the exit competing.
        -->
        <template v-if="selectedIds.length">
          <div class="justify-self-start">
            <UButton label="Deselect" color="neutral" variant="ghost" size="sm" @click="selectedIds = []" />
          </div>
          <h2 class="truncate text-center text-base font-semibold text-highlighted">{{ selectedIds.length }} selected</h2>
          <div class="flex items-center justify-end gap-1">
            <slot name="bulk-actions" :ids="selectedIds" />
            <UButton
              icon="i-lucide-trash-2"
              :aria-label="`Delete ${selectedIds.length} selected`"
              color="error"
              variant="ghost"
              size="sm"
              square
              :loading="removing"
              data-testid="grid-editor-bulk-delete"
              @click="$emit('removeMany', [...selectedIds])"
            />
          </div>
        </template>

        <template v-else>
          <div class="justify-self-start">
            <UButton
              icon="i-lucide-x"
              :aria-label="`Close ${selectionTitle}`"
              color="neutral"
              variant="ghost"
              size="sm"
              square
              data-testid="grid-editor-takeover-dismiss"
              @click="selecting = false"
            />
          </div>
          <h2 class="truncate text-center text-base font-semibold text-highlighted">{{ selectionTitle }}</h2>
          <span />
        </template>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto py-4" :class="dashboardGutterClass">
        <div :class="gridClass">
          <button
            v-for="item in items"
            :key="item.id"
            type="button"
            class="group relative aspect-square overflow-hidden rounded-lg border-2 text-left transition-colors"
            :class="selectedIds.includes(item.id) ? 'border-primary' : 'border-transparent'"
            :aria-pressed="selectedIds.includes(item.id)"
            :aria-label="`Select ${item.title}`"
            @click="toggle(item.id)"
          >
            <slot name="tile" :item="item" />

            <span
              class="absolute left-1.5 top-1.5 flex size-5 items-center justify-center rounded"
              :class="selectedIds.includes(item.id) ? 'bg-primary' : 'bg-black/40'"
            >
              <UIcon v-if="selectedIds.includes(item.id)" name="i-lucide-check" class="size-3 text-white" />
            </span>
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts" generic="T extends GridEditorItem">
// Generic for the same reason the list editor is: a page hangs its own record on
// the item and reads it off the `#tile` slot, instead of looking it back up by id
// for every field the tile renders.
import { dashboardGutterClass, dashboardPanelActionsKey } from '~/lib/components/workspace/dashboard/dashboardPanelContext'
// The navbar slot of the index panel this grid is mounted in, if any.
const actionsTarget = inject(dashboardPanelActionsKey, null)

const props = defineProps<{
  items: T[]
  title: string
  description?: string
  emptyTitle: string
  emptyIcon: string
  /** Names the add control for screen readers, e.g. "Add photos". */
  addLabel: string
  /** Bar title while selecting, e.g. "Select photos". */
  selectionTitle: string
  error?: string | null
  /** Tailwind grid classes, so a page can size its own tiles. */
  gridClass?: string
  /** A bulk removal is in flight. */
  removing?: boolean
}>()

defineEmits<{
  add: []
  open: [item: T]
  removeMany: [ids: string[]]
}>()

const selecting = defineModel<boolean>('selecting', { default: false })
const selectedIds = defineModel<string[]>('selected', { default: () => [] })

const gridClass = computed(() => props.gridClass ?? 'grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6')

function openSelection() {
  selectedIds.value = []
  selecting.value = true
}

function toggle(id: string) {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter(entry => entry !== id)
    : [...selectedIds.value, id]
}

// Leaving selection must not leave a selection behind: reopening it later would
// otherwise start with rows picked that the user chose in a different session of
// the same screen.
watch(selecting, (open) => {
  if (!open) selectedIds.value = []
})
</script>

<script lang="ts">
export interface GridEditorItem {
  id: string
  /** Names the tile in its open and select labels. */
  title: string
}
</script>
