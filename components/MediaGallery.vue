<template>
  <div class="relative rounded-xl overflow-hidden" data-media-gallery>
    <div v-if="items.length === 0" class="flex aspect-4/3 items-center justify-center bg-muted">
      <TenantIcon :name="emptyIcon" class="size-16 text-dimmed" />
    </div>

    <button
      v-else-if="items.length === 1"
      type="button"
      class="relative block aspect-4/3 w-full overflow-hidden border-0 bg-transparent p-0 text-left lg:h-[520px]"
      :aria-label="items[0]?.kind === 'video' ? `Play video, ${title}` : `Open media, ${title}`"
      @click="openLightbox(0)"
    >
      <MediaPreview :item="items[0]!" />
    </button>

    <div v-else class="relative">
      <!-- 5+ items: Airbnb 5-photo mosaic on md+, hero image on mobile -->
      <div v-if="items.length >= 5" class="relative">
        <!-- Mobile view (< md): single hero photo -->
        <button
          type="button"
          class="relative block aspect-4/3 w-full overflow-hidden border-0 bg-transparent p-0 text-left md:hidden"
          :aria-label="items[0]?.kind === 'video' ? `Play video, ${title}` : `Open media, ${title}`"
          @click="openLightbox(0)"
        >
          <MediaPreview :item="items[0]!" />
        </button>

        <!-- Desktop view (md+): 5-photo mosaic -->
        <div class="hidden md:grid md:grid-cols-4 md:grid-rows-2 gap-2 h-[420px] lg:h-[480px]">
          <button
            v-for="(item, index) in visibleItems"
            :key="`${item.url}-${index}`"
            type="button"
            class="group relative h-full w-full overflow-hidden border-0 bg-transparent p-0 text-left focus:outline-none"
            :class="index === 0 ? 'col-span-2 row-span-2' : 'col-span-1 row-span-1'"
            :aria-label="item.kind === 'video' ? `Play video, ${title}` : `Open media, ${title}`"
            @click="openLightbox(index)"
          >
            <MediaPreview :item="item" class="transition duration-300 group-hover:brightness-95" />
          </button>
        </div>

        <!-- Floating Airbnb-style "Show all photos" button -->
        <button
          type="button"
          class="absolute bottom-4 right-4 z-10 inline-flex items-center gap-2 rounded-lg border border-black/80 bg-white/95 px-3.5 py-1.5 text-xs font-semibold text-gray-900 shadow-sm backdrop-blur-sm transition hover:bg-white hover:scale-[1.02] active:scale-[0.98]"
          @click="openAllPhotos"
        >
          <TenantIcon name="squares-2x2" class="size-3.5" />
          {{ t('site.photos.show_all', { count: items.length }) }}
        </button>
      </div>

      <!-- 2 to 4 items -->
      <div
        v-else
        class="relative grid gap-2 h-[360px] sm:h-[440px] lg:h-[480px]"
        :class="items.length === 2 ? 'grid-cols-2' : items.length === 3 ? 'grid-cols-2 grid-rows-2' : 'grid-cols-2 grid-rows-2'"
      >
        <button
          v-for="(item, index) in visibleItems"
          :key="`${item.url}-${index}`"
          type="button"
          class="group relative h-full w-full overflow-hidden border-0 bg-transparent p-0 text-left focus:outline-none"
          :class="items.length === 3 && index === 0 ? 'row-span-2' : ''"
          :aria-label="item.kind === 'video' ? `Play video, ${title}` : `Open media, ${title}`"
          @click="openLightbox(index)"
        >
          <MediaPreview :item="item" class="transition duration-300 group-hover:brightness-95" />
        </button>

        <button
          v-if="items.length > 1"
          type="button"
          class="absolute bottom-4 right-4 z-10 inline-flex items-center gap-2 rounded-lg border border-black/80 bg-white/95 px-3.5 py-1.5 text-xs font-semibold text-gray-900 shadow-sm backdrop-blur-sm transition hover:bg-white hover:scale-[1.02] active:scale-[0.98]"
          @click="openAllPhotos"
        >
          <TenantIcon name="squares-2x2" class="size-3.5" />
          {{ t('site.photos.show_all', { count: items.length }) }}
        </button>
      </div>
    </div>

    <button v-if="items.length === 1 && photoGroups.length" type="button" class="absolute bottom-4 right-4 z-10 inline-flex items-center gap-2 rounded-lg border border-black/80 bg-white/95 px-3.5 py-1.5 text-xs font-semibold text-gray-900 shadow-sm" @click="openAllPhotos">
      <TenantIcon name="squares-2x2" class="size-3.5" />{{ t('site.photos.show_all', { count: items.length }) }}
    </button>
    <MediaLightbox v-model:open="lightboxOpen" v-model:index="lightboxIndex" v-model:overview="lightboxOverview" :items="items" :title="title" :photo-groups="photoGroups">
      <template v-if="$slots.caption" #caption="slotProps">
        <slot name="caption" v-bind="slotProps" />
      </template>
    </MediaLightbox>
  </div>
</template>

<script setup lang="ts">
import MediaPreview, { provideMediaPreviews, type MediaPreviewItem } from '~/components/MediaPreview.vue'
import type { TenantIconName } from '~/components/tenant/TenantIcon.vue'
import type { MediaGalleryGroup } from '~/components/MediaLightbox.vue'
interface GalleryItem extends MediaPreviewItem {
  description?: string
  [key: string]: unknown
}

const props = withDefaults(defineProps<{
  items: GalleryItem[]
  title: string
  emptyIcon?: TenantIconName
  photoGroups?: MediaGalleryGroup[]
}>(), {
  emptyIcon: 'sparkles',
  photoGroups: () => [],
})

defineSlots<{
  caption(_slotProps: { item: GalleryItem; index: number }): unknown
}>()

const { t } = useI18n()
const items = computed(() => {
  const seen = new Set<string>()
  return props.items.filter(item => {
    const identity = typeof item.asset_id === 'string' ? item.asset_id : item.url
    if (!item.url || seen.has(identity)) return false
    seen.add(identity)
    return true
  })
})
const visibleItems = computed(() => items.value.slice(0, items.value.length >= 5 ? 5 : items.value.length))
const lightboxOpen = ref(false)
const lightboxIndex = ref(0)
const lightboxOverview = ref(false)
provideMediaPreviews(lightboxOpen)

function openLightbox(index: number) {
  if (!items.value[index]) return
  lightboxIndex.value = index
  lightboxOverview.value = false
  lightboxOpen.value = true
}

function openAllPhotos() {
  openLightbox(0)
  lightboxOverview.value = props.photoGroups.length > 0
}

defineExpose({ openLightbox })
</script>
