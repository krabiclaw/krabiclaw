<template>
  <!-- The panel's footer frame holds the gutter; this is the row inside it. -->
  <div class="flex w-full items-center justify-between gap-4">
    <!-- Cancel reads as text; Save is the only filled control on screen. -->
    <UButton color="neutral" variant="link" :label="cancelLabel" :disabled="loading" class="px-0 font-semibold text-highlighted underline-offset-4 hover:underline" :class="leaf ? 'lg:invisible' : undefined" @click="$emit('cancel')" />
    <UButton :label="saveLabel || 'Save'" size="xl" :loading="loading" :disabled="disabled" @click="$emit('save')" />
  </div>
</template>

<script setup lang="ts">
/*
  The one Cancel/Save footer. Inline footers replace the phone's tab bar;
  drawer footers sit above it without changing the underlying parent's size.
*/
const props = withDefaults(defineProps<{
  saveLabel?: string | null
  cancelLabel?: string
  loading?: boolean
  disabled?: boolean
  /** A leaf's footer: its Cancel exists only where the leaf is a sheet, never beside its index. */
  leaf?: boolean
}>(), { saveLabel: 'Save', cancelLabel: 'Cancel', loading: false, disabled: false, leaf: false })

defineEmits<{ cancel: []; save: [] }>()

// Counted on the client only: an increment in setup also ran on the server,
// was serialized into the payload, and then ran again on hydration, so the
// count never came back to zero and the tab bar never came back.
const open = useDashboardInlineFooters()
onMounted(() => { if (!props.leaf) open.value += 1 })
onUnmounted(() => { if (!props.leaf) open.value -= 1 })
</script>
