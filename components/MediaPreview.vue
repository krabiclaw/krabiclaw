<template>
  <span class="relative block size-full overflow-hidden">
    <video
      v-if="item.kind === 'video'"
      :key="item.url"
      ref="video"
      :src="item.url"
      :poster="item.poster || undefined"
      preload="metadata"
      muted
      loop
      playsinline
      :class="['size-full', fit === 'contain' ? 'object-contain' : 'object-cover']"
      @loadeddata="ready = true"
      @playing="ready = true; playing = true"
      @pause="playing = false"
      @waiting="playing = false"
      @error="playing = false; failure = video?.error?.message || t('site.photos.video_failed')"
    />
    <img v-else :src="item.url" :alt="item.alt ?? ''" :loading="loading" decoding="async" :class="['size-full', fit === 'contain' ? 'object-contain' : 'object-cover']">
    <span v-if="item.kind === 'video' && !ready && !failure" class="pointer-events-none absolute inset-0 animate-pulse bg-muted" aria-hidden="true" />
    <span v-if="item.kind === 'video' && !playing" class="pointer-events-none absolute inset-0 grid place-items-center bg-black/10 text-white" aria-hidden="true">
      <span class="grid size-12 place-items-center rounded-full bg-black/45 backdrop-blur-sm"><TenantIcon name="play" class="size-5" /></span>
    </span>
    <span v-if="failure" role="status" class="absolute inset-x-2 bottom-2 rounded bg-black/80 p-2 text-xs text-white">{{ failure }}</span>
  </span>
</template>

<script lang="ts">
import { computed, provide, reactive, type ComputedRef, type InjectionKey, type Ref } from 'vue'

export interface MediaPreviewItem {
  url: string
  kind?: 'image' | 'video' | 'file'
  poster?: string
  alt?: string
}

const mediaPreviewsKey: InjectionKey<{
  visibility: Map<symbol, number>
  selected: ComputedRef<symbol | null>
  paused: Ref<boolean>
}> = Symbol('media-previews')

/** A gallery or feed plays only its most visible inline preview. */
export function provideMediaPreviews(paused: Ref<boolean>) {
  const visibility = reactive(new Map<symbol, number>())
  const selected = computed(() => {
    let id: symbol | null = null
    let ratio = 0
    for (const [candidate, visible] of visibility) {
      if (visible > ratio) { id = candidate; ratio = visible }
    }
    return id
  })
  provide(mediaPreviewsKey, { visibility, selected, paused })
}
</script>

<script setup lang="ts">
import { useDocumentVisibility, useIntersectionObserver } from '@vueuse/core'

withDefaults(defineProps<{ item: MediaPreviewItem; fit?: 'cover' | 'contain'; loading?: 'lazy' | 'eager' }>(), { fit: 'cover', loading: 'eager' })
const { t } = useI18n()
const group = inject(mediaPreviewsKey)
if (!group) throw new Error('Media previews require a gallery or feed playback scope')
const id = Symbol('preview')
const video = ref<HTMLVideoElement | null>(null)
const ready = ref(false)
const playing = ref(false)
const failure = ref<string | null>(null)
const documentVisibility = useDocumentVisibility()
const shouldPlay = computed(() => group.selected.value === id && !group.paused.value && documentVisibility.value === 'visible')

useIntersectionObserver(video, (entries) => {
  for (const entry of entries) group.visibility.set(id, entry.isIntersecting ? entry.intersectionRatio : 0)
}, { threshold: [0, 0.25, 0.5, 0.75, 1] })

watch(video, () => {
  group.visibility.delete(id)
  ready.value = false
  playing.value = false
  failure.value = null
}, { flush: 'sync' })
watch([video, shouldPlay], async ([element, play], _previous, onCleanup) => {
  if (!element) return
  let cancelled = false
  onCleanup(() => { cancelled = true; element.pause() })
  if (!play) { element.pause(); return }
  failure.value = null
  try {
    await element.play()
  } catch (error) {
    if (cancelled && error instanceof DOMException && error.name === 'AbortError') return
    failure.value = error instanceof Error ? error.message : String(error)
  }
}, { flush: 'post' })

onBeforeUnmount(() => { video.value?.pause(); group.visibility.delete(id) })
</script>
