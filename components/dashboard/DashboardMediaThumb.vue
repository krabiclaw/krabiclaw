<template>
  <!--
    A row's picture is the fastest thing to scan, so it leads the row. When there
    is no image the tile keeps its exact footprint and shows a muted icon: an
    empty square in the same place reads as "no photo yet" without the list
    reflowing between rows that have one and rows that do not.
  -->
  <div
    class="grid shrink-0 place-items-center overflow-hidden rounded-lg bg-elevated"
    :class="size === 'lg' ? 'size-20' : 'size-14'"
  >
    <img
      v-if="src"
      :src="src"
      :alt="alt"
      class="size-full object-cover"
      loading="lazy"
      decoding="async"
    >
    <UIcon v-else :name="fallbackIcon" class="size-5 text-muted" />
  </div>
</template>

<script setup lang="ts">
import type { ResolvedMediaAsset } from '~/server/utils/media-asset-manager'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import { cfImageVariant } from '~/utils/cf-image'

const props = defineProps<{
  asset?: ResolvedMediaAsset | null
  /** Names the row when the image itself carries no alt text. */
  label: string
  fallbackIcon: string
  size?: 'md' | 'lg'
}>()

// The thumbnail is a scaled-down duplicate of the full asset, so it is the right
// source for a list and the full image is only fetched where it is displayed big.
const src = computed(() => {
  const url = mediaStillUrl(props.asset)
  return cfImageVariant(url, { width: 160, height: 160, fit: 'cover', format: 'auto' }) || url
})
const alt = computed(() => props.asset?.alt_text || props.label)
</script>
