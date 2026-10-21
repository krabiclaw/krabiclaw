<template>
  <UModal
    v-model:open="open"
    :title="title"
    :dismissible="false"
    :ui="{
      // Centred dialog at `sm` and up; a bottom sheet below it. One element, one
      // set of fields — the narrow and wide renderings cannot disagree about what
      // the form contains.
      //
      // Both axes of the default centring have to be undone, not just the
      // vertical one: Tailwind v4 composes these through the `translate`
      // property, so `-translate-x-1/2` survives an override that only touches
      // `transform`. The explicit width is needed too, because the default
      // `w-[calc(100vw-2rem)]` outranks `inset-x-0`.
      content: 'max-sm:inset-x-0 max-sm:bottom-0 max-sm:top-auto max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none',
      wrapper: 'w-full min-w-0 px-10',
      title: 'truncate text-center text-base',
      footer: 'justify-between',
    }"
  >
    <template #close="{ ui }">
      <UButton
        icon="i-lucide-x" :aria-label="`Close ${title}`"
        color="neutral" variant="ghost" size="sm" square
        :disabled="saving || removing"
        data-testid="list-item-dismiss" :class="ui.close({ class: 'start-4 end-auto sm:start-6' })"
      />
    </template>

    <template #body>
      <div class="space-y-5">
        <UAlert
          v-if="error"
          color="error"
          variant="soft"
          icon="i-lucide-circle-alert"
          :description="error"
        />
        <slot />
      </div>
    </template>

    <template v-if="showActions" #footer>
      <!--
        Remove sits opposite Save rather than among the row controls: deleting is
        a decision you make while looking at the item, not while scanning the list.
      -->
      <UButton
        v-if="removable"
        color="error"
        variant="ghost"
        label="Remove"
        :loading="removing"
        data-testid="list-item-remove"
        @click="$emit('remove')"
      />
      <span v-else />
      <div class="flex items-center gap-2">
        <slot name="actions" />
        <UButton
          :label="saveLabel ?? 'Save'"
          :loading="saving"
          :disabled="saveDisabled"
          data-testid="list-item-save"
          @click="$emit('save')"
        />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  /** Centred in the bar. Names the row being edited, or the thing being added. */
  title: string
  /** Adding has nothing to remove yet, so the control is absent rather than inert. */
  removable?: boolean
  saving?: boolean
  removing?: boolean
  saveDisabled?: boolean
  /** Error message to display inline within the dialog body. */
  error?: string | null
  /** Read-only details and action menus use the same chrome without a commit bar. */
  showActions?: boolean
  /** Names the commit for a sheet that does something other than save an edit. */
  saveLabel?: string
}>(), { showActions: true })

defineEmits<{
  save: []
  remove: []
}>()

const open = defineModel<boolean>('open', { default: false })
</script>
