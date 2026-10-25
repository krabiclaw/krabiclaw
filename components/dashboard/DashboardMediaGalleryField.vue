<template>
  <div class="space-y-3">
    <div
      v-for="(item, index) in items"
      :key="item._key"
      class="flex items-center gap-3 rounded-lg border border-default p-2"
      draggable="true"
      @dragstart="draggingIndex = index"
      @dragover.prevent
      @drop.prevent="onDrop(index)"
      @dragend="draggingIndex = null"
    >
      <UIcon name="i-lucide-grip-vertical" class="size-4 shrink-0 text-muted" />
      <UBadge v-if="index === 0 && coverFirst" color="primary" variant="soft" size="xs" class="shrink-0">Cover</UBadge>
      <span v-else class="w-11 shrink-0 text-center text-xs text-muted">{{ index + 1 }}</span>
      <div class="flex-1">
        <!-- The row's asset is owned by the parent (some pass a derived list),
             so selection is reported up rather than written in place here. -->
        <MediaPicker
          :model-value="item.asset_id"
          :selected-summary="summaryFor(item)"
          :organization-id="organizationId"
          accept="any"
          title="Select media"
          @change="emit('assetChange', index, $event)"
        />
      </div>
      <UButton
        size="sm"
        color="neutral"
        variant="ghost"
        icon="i-lucide-chevron-up"
        aria-label="Move media up"
        :disabled="index === 0"
        @click="emit('move', index, -1)"
      />
      <UButton
        size="sm"
        color="neutral"
        variant="ghost"
        icon="i-lucide-chevron-down"
        aria-label="Move media down"
        :disabled="index === items.length - 1"
        @click="emit('move', index, 1)"
      />
      <UButton
        size="sm"
        color="error"
        variant="ghost"
        icon="i-lucide-x"
        aria-label="Remove media"
        @click="emit('remove', index)"
      />
    </div>
    <slot name="add">
      <UButton size="sm" color="neutral" variant="soft" icon="i-lucide-plus" @click="emit('add')">
        Add media
      </UButton>
    </slot>
  </div>
</template>

<script setup lang="ts">
import MediaPicker from '~/lib/components/workspace/media/MediaPicker.vue'

import type { MediaSummary } from '~/lib/components/workspace/media/MediaPicker.vue'

export interface GalleryMediaItem {
  _key: string
  asset_id: string | null
  url?: string | null
  thumbnail_url?: string | null
  kind?: 'image' | 'video' | string | null
}

withDefaults(defineProps<{
  items: GalleryMediaItem[]
  organizationId: string
  /** Marks the first row as the cover, for galleries whose order sets it. */
  coverFirst?: boolean
}>(), { coverFirst: true })

/**
 * What this row already knows about its asset. The gallery is handed its rows
 * with their URLs, so a populated picker has no reason to ask the server for
 * metadata the parent is already holding — an N-image gallery used to open N
 * requests on mount. `url` is this list's name for the asset's public URL.
 */
function summaryFor(item: GalleryMediaItem): MediaSummary | null {
  if (!item.asset_id) return null
  return {
    asset_id: item.asset_id,
    public_url: item.url ?? null,
    thumbnail_url: item.thumbnail_url ?? null,
    kind: item.kind ?? null,
  }
}

const emit = defineEmits<{
  add: []
  remove: [index: number]
  move: [index: number, direction: -1 | 1]
  reorder: [sourceIndex: number, targetIndex: number]
  assetChange: [index: number, asset: { asset_id: string; public_url: string | null; thumbnail_url: string | null; kind?: string | null } | null]
}>()

const draggingIndex = ref<number | null>(null)

function onDrop(targetIndex: number) {
  const sourceIndex = draggingIndex.value
  draggingIndex.value = null
  if (sourceIndex === null || sourceIndex === targetIndex) return
  emit('reorder', sourceIndex, targetIndex)
}
</script>
