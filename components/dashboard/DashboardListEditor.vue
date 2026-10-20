<template>
  <section>
    <!--
      One rule for every list: the panel's navbar carries Back, the title and
      the list's controls — Edit, Add — and the body carries the list. Inside
      an index panel the controls teleport into its navbar; a list mounted
      anywhere else keeps them at the top of the list.
    -->
    <header>
      <Teleport :to="actionsTarget ? `#${actionsTarget}` : undefined" :disabled="!actionsTarget" defer>
        <div class="flex shrink-0 items-center gap-2" :class="actionsTarget ? undefined : 'justify-end'">
          <slot name="actions" />
          <slot v-if="!readOnly && editing && selected.length" name="selection-actions" :selected="selected" />
          <UButton
            v-if="!readOnly && (items.length || editing)"
            :label="editing ? 'Done' : 'Edit'"
            color="neutral"
            :variant="editing ? 'solid' : 'soft'"
            :disabled="disabled"
            data-testid="list-editor-toggle"
            @click="editing = !editing"
          />
          <UButton
            v-if="!readOnly && addable"
            icon="i-lucide-plus"
            :aria-label="addLabel"
            :to="addTo"
            color="neutral"
            variant="soft"
            square
            :disabled="disabled"
            data-testid="list-editor-add"
            @click="!addTo && $emit('add')"
          />
        </div>
      </Teleport>

      <!-- A list explains nothing about itself; in the edit state it says what you are acting on. -->
      <p v-if="!readOnly && editing && selectable" class="mb-6 text-sm text-muted" data-testid="list-editor-selection-count">
        {{ selected.length ? `${selected.length} selected` : 'Select items to move them' }}
      </p>
    </header>

    <!--
      Narrowing which rows are shown, for a list that has more than one state
      worth separating. It sits under the heading and above the rows because it
      describes the rows, not the list's own controls.
    -->
    <div v-if="$slots.filters" class="mb-8">
      <slot name="filters" />
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      :title="`${title} could not be loaded`"
      :description="error"
    />

    <UEmpty v-else-if="!items.length" :icon="emptyIcon" :title="emptyTitle" data-testid="list-editor-empty" />

    <ul v-else class="divide-y divide-default border-y border-default">
      <li v-for="(item, index) in items" :key="item.id" class="flex items-center gap-3 py-4">
        <!--
          Edit is a state of this list, not a place you go: the row keeps its
          position and grows controls. Nothing navigates, so there is no way to
          strand a half-edited list behind a back button.
        -->
        <UCheckbox
          v-if="!readOnly && editing && selectable"
          :model-value="selected.includes(item.id)"
          :disabled="disabled"
          :aria-label="`Select ${item.title}`"
          :data-testid="`list-editor-select-${item.id}`"
          @update:model-value="toggleSelected(item.id)"
        />

        <!--
          A row the caller marks `removable: false` shows no remove control:
          offering one the server refuses puts an error toast behind a click the
          reader had no way to know would fail.
        -->
        <UButton
          v-if="!readOnly && editing && !selectable && item.removable !== false"
          icon="i-lucide-circle-minus"
          :aria-label="`Remove ${item.title}`"
          color="neutral"
          variant="ghost"
          size="sm"
          square
          :loading="removingId === item.id"
          :disabled="disabled"
          @click="$emit('remove', item)"
        />

        <!--
          The row body is the way in, and it is a link: a row that navigated
          from a click handler could not be opened in a new tab, showed the
          reader no destination before they pressed it, and put a second copy
          of the record's path in every list (DESIGN.md).

          In the edit state it stops being one. Editing keeps the rows in place
          and grows controls around them, so nothing navigates — a row that
          still led somewhere would strand a half-finished reorder behind a tap
          on the record's own name (DESIGN.md, "Reorder is a mode").
        -->
        <component
          :is="rowLink(item) ? NuxtLink : 'div'"
          :to="rowLink(item) ? item.to : undefined"
          class="min-w-0 flex-1"
          :class="rowLink(item) ? 'no-underline' : undefined"
        >
          <slot name="item" :item="item">
            <p class="truncate text-sm font-medium text-highlighted">{{ item.title }}</p>
            <p v-if="item.summary" class="mt-1 line-clamp-2 text-sm text-muted">{{ item.summary }}</p>
          </slot>
        </component>

        <div v-if="!readOnly && editing" class="flex shrink-0 items-center gap-1">
          <template v-if="reorderable">
            <UButton
              icon="i-lucide-arrow-up"
              :aria-label="`Move ${item.title} up`"
              color="neutral"
              variant="ghost"
              size="sm"
              square
              :disabled="disabled || index === 0"
              @click="$emit('move', item, -1)"
            />
            <UButton
              icon="i-lucide-arrow-down"
              :aria-label="`Move ${item.title} down`"
              color="neutral"
              variant="ghost"
              size="sm"
              square
              :disabled="disabled || index === items.length - 1"
              @click="$emit('move', item, 1)"
            />
          </template>
          <UButton
            v-if="item.to"
            icon="i-lucide-pencil"
            :aria-label="`Edit ${item.title}`"
            color="neutral"
            variant="ghost"
            size="sm"
            square
            :disabled="disabled"
            :to="item.to"
          />
        </div>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts" generic="T extends ListEditorItem">
import { dashboardPanelActionsKey } from '~/lib/components/workspace/dashboard/dashboardPanelContext'
// Generic so a caller can hang its own row on the item and read it straight off
// the `#item` slot. Without it every custom row had to look its record back up
// by id for each field it rendered, which is both noisy and quadratic.
const props = withDefaults(defineProps<{
  items: T[]
  title: string
  emptyTitle: string
  emptyIcon: string
  /** Names the add control for screen readers, e.g. "Add a question". */
  addLabel?: string
  /** A creation level is a link; inline list actions keep the add event. */
  addTo?: string
  /** A list can finish its current edit before offering another item. */
  addable?: boolean
  /** Keep list controls unavailable while its owner commits a draft. */
  disabled?: boolean
  readOnly?: boolean
  error?: string | null
  /** Lists with a persisted order gain move controls in the edit state. */
  reorderable?: boolean
  /** Marks the row whose removal is in flight. */
  removingId?: string | null
  /** Swaps the per-row remove control for a checkbox so several rows act at once. */
  selectable?: boolean
}>(), { addable: true, disabled: false })

defineEmits<{
  add: []
  remove: [item: T]
  move: [item: T, direction: -1 | 1]
}>()

// Resolved rather than written in the template so one expression can choose
// between a link and a plain row.
const NuxtLink = resolveComponent('NuxtLink')

/**
 * The row body links only while the list is being browsed. In the edit state
 * the row is the thing being acted on, and its pencil is the way in.
 */
const rowLink = (item: T) => Boolean(item.to) && !(editing.value && !props.readOnly)

// The navbar slot of the index panel this list is mounted in, if any.
const actionsTarget = inject(dashboardPanelActionsKey, null)

const editing = defineModel<boolean>('editing', { default: false })
const selected = defineModel<string[]>('selected', { default: () => [] })

function toggleSelected(id: string) {
  selected.value = selected.value.includes(id)
    ? selected.value.filter(candidate => candidate !== id)
    : [...selected.value, id]
}

// Leaving the edit state drops the selection: the controls that act on it are
// gone, so a selection surviving out of sight could be acted on by surprise.
watch(editing, (value) => {
  if (!value) selected.value = []
})
</script>

<script lang="ts">
// Declared in a plain block so the `generic` attribute above can constrain to it:
// a type used by `<script setup generic>` has to exist before that block is
// compiled.
export interface ListEditorItem {
  id: string
  /** Names the row in the remove, reorder and open controls' labels. */
  title: string
  /**
   * The record's own URL. Set it and the row is a link to it; leave it off and
   * the row is not a way in, which is what a list of media fields wants.
   */
  to?: string
  /** Set false for a row that may not be removed; its remove control is omitted. */
  removable?: boolean
  summary?: string | null
}
</script>
