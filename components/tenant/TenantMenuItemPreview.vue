<template>
  <div
    v-if="previewUrl"
    class="relative shrink-0 overflow-hidden rounded-xl bg-muted"
    :class="disabled ? 'opacity-50 grayscale' : ''"
  >
    <img
      :src="previewUrl"
      :alt="item.name"
      class="size-24 object-cover"
      loading="lazy"
    />
    <span
      v-if="isVideo && media?.public_url"
      class="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/10 text-white"
      aria-hidden="true"
    >
      <span class="flex size-8 items-center justify-center rounded-full bg-black/50">
        <TenantIcon name="play" class="ml-0.5 size-3.5" />
      </span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { mediaStillUrl } from '~/shared/media-placement-contract'
type PreviewItem = {
  name: string
  media?: Array<{ public_url?: string | null; thumbnail_url?: string | null; kind?: string | null }>
}

const props = withDefaults(defineProps<{
  item: PreviewItem
  disabled?: boolean
}>(), {
  disabled: false,
})

const media = computed(() => props.item.media?.[0] ?? null)
const isVideo = computed(() => media.value?.kind === 'video')
const previewUrl = computed(() => {
  if (isVideo.value) return mediaStillUrl(media.value)
  return media.value?.public_url || null
})
</script>
