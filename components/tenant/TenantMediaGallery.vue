<template>
  <div class="mx-auto block w-[95%] md:hidden">
    <div class="mb-6 max-h-80 overflow-hidden rounded-md bg-[var(--tenant-primary-dark,var(--tenant-primary-dark,#1e293b))]">
      <img
        v-if="active"
        :src="active.public_url"
        :alt="active.alt_text || fallbackAlt"
        :width="active.width || 960"
        :height="active.height || 720"
        fetchpriority="high"
        class="aspect-video max-h-80 w-full rounded-md object-contain"
      >
    </div>
    <div v-if="media.length > 1" class="flex items-center justify-between border-t border-default px-4 sm:px-0">
      <button type="button" class="inline-flex items-center border-t-2 border-transparent pl-1 pt-4 text-sm font-medium text-muted hover:border-accented hover:text-toned cursor-pointer" @click="previous">
        <svg class="mr-3 size-5 text-dimmed" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M17 10a.75.75 0 0 1-.75.75H5.56l3.22 3.22a.75.75 0 1 1-1.06 1.06l-4.5-4.5a.75.75 0 0 1 0-1.06l4.5-4.5a.75.75 0 0 1 1.06 1.06L5.56 9.25h10.69A.75.75 0 0 1 17 10Z" clip-rule="evenodd" /></svg>
        Prev
      </button>
      <button type="button" class="inline-flex items-center border-t-2 border-transparent pl-1 pt-4 text-sm font-medium text-muted hover:border-accented hover:text-toned cursor-pointer" @click="next">
        Next
        <svg class="ml-3 size-5 text-dimmed" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M3 10a.75.75 0 0 1 .75-.75h10.69l-3.22-3.22a.75.75 0 0 1 1.06-1.06l4.5 4.5a.75.75 0 0 1 0 1.06l-4.5 4.5a.75.75 0 0 1 1.06-1.06l3.22-3.22H3.75A.75.75 0 0 1 3 10Z" clip-rule="evenodd" /></svg>
      </button>
    </div>
  </div>

  <div class="top-2 hidden h-min w-full flex-1 flex-col-reverse flex-wrap pt-8 md:sticky md:flex">
    <div v-if="media.length > 1" class="mx-auto mt-3 w-full px-4 sm:p-0">
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-4 md:grid-cols-3 lg:grid-cols-6" role="tablist" aria-label="Service media">
        <button
          v-for="(item, index) in media"
          :key="item.asset_id"
          type="button"
          role="tab"
          class="relative flex aspect-square cursor-pointer rounded bg-elevated text-sm font-medium uppercase text-highlighted hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          :aria-selected="index === modelValue"
          :tabindex="index === modelValue ? 0 : -1"
          @click="select(index)"
          @keydown="onKeydown($event, index)"
        >
          <span class="absolute inset-0 overflow-hidden rounded-md"><img :src="item.public_url" :alt="item.alt_text || fallbackAlt" loading="lazy" class="size-full object-cover object-center"></span>
          <span class="pointer-events-none absolute inset-0 rounded ring-2 ring-offset-2" :class="index === modelValue ? 'ring-primary' : 'ring-transparent'" aria-hidden="true" />
        </button>
      </div>
    </div>
    <div v-if="active" class="mt-3 w-full px-4 sm:p-0" role="tabpanel">
      <img :src="active.public_url" :alt="active.alt_text || fallbackAlt" :width="active.width || 960" :height="active.height || 720" fetchpriority="high" class="max-w-full rounded-md border-none align-middle shadow">
    </div>
  </div>
</template>

<script setup lang="ts">
type GalleryItem = { asset_id: string; public_url: string; alt_text: string | null; width: number | null; height: number | null }
const props = defineProps<{ modelValue: number, media: GalleryItem[], fallbackAlt: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: number] }>()
const active = computed(() => props.media[props.modelValue] || props.media[0] || null)
function select(index: number) { emit('update:modelValue', index) }
function previous() { select((props.modelValue - 1 + props.media.length) % props.media.length) }
function next() { select((props.modelValue + 1) % props.media.length) }
function onKeydown(event: KeyboardEvent, index: number) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  if (event.key === 'Home') select(0)
  else if (event.key === 'End') select(props.media.length - 1)
  else if (event.key === 'ArrowRight') select((index + 1) % props.media.length)
  else select((index - 1 + props.media.length) % props.media.length)
}
</script>
