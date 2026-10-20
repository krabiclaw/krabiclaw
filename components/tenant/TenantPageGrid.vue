<template>
  <div class="relative z-20 grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
    <component
      :is="item.url ? NuxtLink : 'article'"
      v-for="item in items"
      :key="item.id"
      :to="item.url || undefined"
      class="group relative flex h-full flex-col rounded-2xl bg-elevated p-4 text-default no-underline ring-1 ring-default transition hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tenant-primary)] focus-visible:ring-offset-4"
    >
      <div :data-page-id="item.id" class="aspect-[4/3] w-full overflow-hidden rounded-xl bg-muted">
        <img
          v-if="imageUrl(item)"
          :src="imageUrl(item) || undefined"
          :alt="item.title"
          width="704"
          height="478"
          loading="lazy"
          class="size-full object-cover transition-transform duration-500 group-hover:scale-105"
        >
      </div>
      <h3 class="tenant-display mt-5 text-xl font-bold text-highlighted">
        {{ item.title }}
      </h3>
      <p v-if="item.description" class="mt-2 line-clamp-3 text-sm leading-6 text-muted">
        {{ item.description }}
      </p>
      <p v-if="item.city" class="mt-4 text-sm text-highlighted">{{ item.city }}</p>
      <p v-if="item.address" class="mt-4 text-sm text-highlighted">{{ item.address }}</p>
      <p v-if="item.value" class="mt-4 text-sm text-highlighted"><span v-if="item.compareAt" class="mr-2 line-through">{{ item.compareAt }}</span>{{ item.value }}</p>
      <p v-if="item.featured" class="mt-4 text-sm text-highlighted">{{ t('site.posts.featured') }}</p>
      <p v-if="item.unavailable" class="mt-4 text-sm text-highlighted">{{ t('site.menu_page.unavailable') }}</p>
      <p v-if="item.schedulingSummary" class="mt-4 text-sm text-highlighted">{{ item.schedulingSummary }}</p>
    </component>
  </div>
</template>

<script setup lang="ts">
import { NuxtLink } from '#components'
import { mediaStillUrl } from '~/shared/media-placement-contract'

interface PageGridMedia { slot: string; public_url: string; thumbnail_url?: string; kind: string }
export interface PageGridItem {
  id: string
  title: string
  description?: string
  schedulingSummary?: string
  url?: string
  city?: string
  address?: string
  value?: string
  compareAt?: string
  featured?: boolean
  unavailable?: boolean
  media?: PageGridMedia[]
}

const props = defineProps<{ items: PageGridItem[]; imageSlot: 'cover' | 'image' | 'hero' }>()
const { t } = useI18n()

function imageUrl(item: PageGridItem): string | null {
  return mediaStillUrl(item.media?.find(media => media.slot === props.imageSlot))
}
</script>
