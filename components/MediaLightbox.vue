<template>
  <UModal v-model:open="openModel" fullscreen :title="overviewModel ? t('stay.photo_tour') : title || t('saya.photos.gallery_title')" :ui="{ content: overviewModel ? 'bg-white text-gray-950 divide-y-0' : 'bg-black text-white divide-y-0' }">
    <template #content>
      <div class="relative h-dvh w-full overflow-hidden" @keydown="onKeydown">
        <header class="absolute inset-x-0 top-0 z-30 flex h-20 items-center gap-3 px-4 sm:px-8" :class="overviewModel ? 'border-b border-gray-200 bg-white' : 'bg-linear-to-b from-black/70 to-transparent'">
          <button v-if="groups.length && !overviewModel" type="button" class="grid size-10 shrink-0 place-items-center rounded-full hover:bg-white/15" :aria-label="t('stay.back_to_photo_tour')" @click="overviewModel = true"><UIcon name="i-lucide-chevron-left" class="size-5" /></button>
          <div class="min-w-0 flex-1">
            <h2 class="truncate text-base font-semibold">{{ overviewModel ? t('stay.photo_tour') : title }}</h2>
            <p v-if="!overviewModel && items.length > 1" class="text-xs text-white/70">{{ currentIndex + 1 }} / {{ items.length }}</p>
          </div>
          <template v-if="!overviewModel && items.length > 1">
            <button type="button" class="grid size-10 place-items-center rounded-full bg-black/40 disabled:opacity-30" :aria-label="t('social_posts.previous_media')" :disabled="currentIndex === 0" @click="navigate(currentIndex - 1)"><UIcon name="i-lucide-chevron-up" class="size-5" /></button>
            <button type="button" class="grid size-10 place-items-center rounded-full bg-black/40 disabled:opacity-30" :aria-label="t('social_posts.next_media')" :disabled="currentIndex === items.length - 1" @click="navigate(currentIndex + 1)"><UIcon name="i-lucide-chevron-down" class="size-5" /></button>
          </template>
          <button type="button" class="grid size-10 shrink-0 place-items-center rounded-full" :class="overviewModel ? 'hover:bg-gray-100' : 'bg-black/30 backdrop-blur-md'" :aria-label="t('saya.photos.close_gallery')" @click="openModel = false"><UIcon name="i-lucide-x" class="size-5" /></button>
        </header>

        <div v-if="overviewModel" class="h-full overflow-y-auto overscroll-contain pt-20" data-photo-tour>
          <div class="mx-auto max-w-6xl px-6 py-8 sm:px-10 sm:py-10">
            <nav :aria-label="t('stay.photo_tour')" class="mb-10 flex gap-4 overflow-x-auto pb-3 sm:gap-6">
              <a v-for="group in groups" :key="group.id" :href="`#photo-room-${group.id}`" class="w-28 shrink-0 rounded-xl text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-4 sm:w-32">
                <img :src="backgroundUrl(group.entries[0]!.item)!" alt="" class="mb-2 aspect-square w-full rounded-xl object-cover">
                {{ group.title }}
              </a>
            </nav>
            <section v-for="group in groups" :id="`photo-room-${group.id}`" :key="group.id" class="scroll-mt-24 border-t border-gray-200 py-8 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-10 sm:py-10">
              <div class="mb-5">
                <h3 class="text-2xl font-semibold tracking-tight">{{ group.title }}</h3>
                <ul v-if="group.details?.length" class="mt-3 space-y-2 text-sm leading-relaxed text-gray-600">
                  <li v-for="detail in group.details" :key="detail">{{ detail }}</li>
                </ul>
              </div>
              <div class="grid grid-cols-2 gap-2 sm:gap-3">
                <button v-for="(entry, position) in group.entries" :key="entry.index" type="button" class="relative overflow-hidden rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4" :class="position === 0 && group.entries.length % 2 === 1 ? 'col-span-2' : ''" :aria-label="t('stay.open_room_photo', { room: group.title, number: position + 1 })" @click="openPhoto(entry.index)">
                  <img :src="backgroundUrl(entry.item)!" :alt="entry.item.alt || ''" class="aspect-4/3 w-full object-cover transition hover:brightness-95">
                  <span v-if="entry.item.kind === 'video'" class="absolute inset-0 grid place-items-center text-white"><UIcon name="i-lucide-circle-play" class="size-10 drop-shadow" /></span>
                </button>
              </div>
            </section>
          </div>
        </div>

        <div v-else ref="scroller" class="h-full w-full snap-y snap-mandatory overflow-y-auto overscroll-contain touch-pan-y scrollbar-hide" @scroll.passive="onScroll">
          <section v-for="(item, i) in items" :key="`${item.url}-${i}`" class="relative h-dvh w-full snap-start snap-always overflow-hidden bg-black">
            <img v-if="backgroundUrl(item)" :src="backgroundUrl(item)!" alt="" aria-hidden="true" class="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-50 blur-2xl select-none">
            <div :class="item.description || $slots.caption ? 'lg:grid-cols-[minmax(0,1fr)_20rem]' : ''" class="relative z-10 grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-4 px-4 pb-5 pt-20 lg:grid-rows-1 lg:gap-8 lg:px-16">
              <div class="min-h-0 min-w-0">
                <video v-if="item.kind === 'video'" :ref="el => setVideoRef(el, i)" :src="item.url" playsinline controls tabindex="0" :poster="typeof item.poster === 'string' ? item.poster : undefined" preload="metadata" class="h-full w-full object-contain" />
                <img v-else :src="item.url" :alt="item.alt || ''" class="h-full w-full object-contain">
              </div>
              <div v-if="item.description || $slots.caption" class="max-h-[25dvh] min-h-0 overflow-y-auto overscroll-contain rounded-xl bg-black/70 p-5 lg:self-center lg:max-h-[80dvh]">
                <slot name="caption" :item="item" :index="i"><p v-if="item.description" class="whitespace-pre-line break-words text-base leading-relaxed [overflow-wrap:anywhere]">{{ item.description }}</p></slot>
              </div>
            </div>
          </section>
        </div>
      </div>
    </template>
  </UModal>
</template>

<script lang="ts">
export interface MediaGalleryGroup {
  id: string
  title: string
  asset_ids: string[]
  details?: string[]
}
</script>

<script setup lang="ts">
interface LightboxItem {
  url: string
  kind?: 'image' | 'video' | 'file'
  alt?: string
  description?: string
  [key: string]: unknown
}

const props = withDefaults(defineProps<{
  open?: boolean
  items?: LightboxItem[]
  index?: number
  title?: string
  photoGroups?: MediaGalleryGroup[]
  overview?: boolean
}>(), { open: false, items: () => [], index: 0, title: undefined, photoGroups: () => [], overview: false })

defineSlots<{ caption(_slotProps: { item: LightboxItem; index: number }): unknown }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; 'update:index': [value: number]; 'update:overview': [value: boolean] }>()
const { t } = useI18n()
const openModel = computed({ get: () => props.open, set: (value: boolean) => emit('update:open', value) })
const indexModel = computed({ get: () => props.index, set: (value: number) => emit('update:index', value) })
const overviewModel = computed({ get: () => props.overview && groups.value.length > 0, set: (value: boolean) => emit('update:overview', value) })
const items = computed(() => props.items)
const groups = computed(() => props.photoGroups.map(group => ({
  ...group,
  entries: items.value.flatMap((item, index) => typeof item.asset_id === 'string' && group.asset_ids.includes(item.asset_id) ? [{ item, index }] : []),
})).filter(group => group.entries.length > 0))
const scroller = ref<HTMLElement | null>(null)
const videoRefs = ref<Record<number, HTMLVideoElement>>({})
const currentIndex = computed(() => Math.min(Math.max(indexModel.value, 0), Math.max(0, items.value.length - 1)))

function setVideoRef(el: Element | ComponentPublicInstance | null, index: number) {
  if (el instanceof HTMLVideoElement) videoRefs.value[index] = el
}
function pauseAllVideos() {
  Object.values(videoRefs.value).forEach(video => video.pause())
}
function backgroundUrl(item: LightboxItem): string | null {
  return item.kind === 'video' ? typeof item.poster === 'string' && item.poster ? item.poster : null : item.url
}
function getPageHeight() {
  return scroller.value?.clientHeight || window.innerHeight
}
async function positionViewer() {
  pauseAllVideos()
  await nextTick()
  if (openModel.value && !overviewModel.value) scroller.value?.scrollTo({ top: currentIndex.value * getPageHeight(), behavior: 'instant' })
}
watch([openModel, overviewModel], positionViewer)
watch(items, () => { pauseAllVideos(); videoRefs.value = {}; void positionViewer() })
watch(indexModel, pauseAllVideos)
onBeforeUnmount(pauseAllVideos)

function onScroll() {
  if (!scroller.value) return
  const nextIndex = Math.round(scroller.value.scrollTop / getPageHeight())
  if (nextIndex !== indexModel.value && nextIndex >= 0 && nextIndex < items.value.length) indexModel.value = nextIndex
}
function navigate(index: number) {
  if (index < 0 || index >= items.value.length) return
  indexModel.value = index
  scroller.value?.scrollTo({ top: index * getPageHeight(), behavior: 'instant' })
}
function openPhoto(index: number) {
  indexModel.value = index
  overviewModel.value = false
}
function onKeydown(event: KeyboardEvent) {
  if (overviewModel.value || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || event.target instanceof HTMLVideoElement) return
  event.preventDefault()
  navigate(currentIndex.value + (event.key === 'ArrowDown' ? 1 : -1))
}
</script>
