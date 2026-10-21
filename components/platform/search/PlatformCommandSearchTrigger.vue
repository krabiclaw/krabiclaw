<template>
  <button
    type="button"
    :class="[
      'group flex w-full items-center gap-3 rounded-xl border py-2.5 text-left transition',
      themeClass,
      compact ? 'justify-center px-2.5' : 'px-3',
    ]"
    :aria-label="ariaLabel"
    @click="open"
  >
    <PlatformSearchGlyph name="search" :class="`size-4 shrink-0 transition ${glyphClass}`" />
    <template v-if="!compact">
      <span class="min-w-0 flex-1 truncate text-sm" :class="labelClass">{{ label }}</span>
      <span class="hidden shrink-0 items-center gap-1 text-[11px] md:flex" :class="kbdWrapClass">
        <kbd class="rounded border px-1.5 py-0.5 font-medium" :class="kbdClass">⌘</kbd>
        <kbd class="rounded border px-1.5 py-0.5 font-medium" :class="kbdClass">K</kbd>
      </span>
    </template>
  </button>
</template>

<script setup lang="ts">
import PlatformSearchGlyph from '~/components/platform/search/PlatformSearchGlyph.vue'
import type { PlatformSearchPaletteSurface } from '~/composables/usePlatformSearchPalette'

const props = withDefaults(defineProps<{
  surface: PlatformSearchPaletteSurface
  compact?: boolean
  label?: string
  ariaLabel?: string
  variant?: 'platform' | 'tenant'
}>(), {
  compact: false,
  label: 'Search',
  ariaLabel: 'Open search',
  variant: 'platform',
})

const { open } = usePlatformSearchPalette(props.surface)
const themeClass = 'border-default bg-default/80 hover:border-muted hover:bg-elevated'
const glyphClass = 'text-muted group-hover:text-default'
const labelClass = 'text-muted'
const kbdWrapClass = 'text-dimmed'
const kbdClass = 'border-default bg-default'
</script>
