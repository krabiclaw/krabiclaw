<template>
  <div class="relative z-20 grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
    <component
      :is="item.url ? NuxtLink : 'article'"
      v-for="item in items"
      :key="item.id"
      :to="item.url || undefined"
      class="relative h-full rounded-2xl bg-muted p-6 no-underline shadow-xl shadow-slate-900/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blawby-primary,var(--ui-primary))] focus-visible:ring-offset-4"
    >
      <div :data-page-id="item.id" class="aspect-[704/478] w-full overflow-hidden rounded-lg bg-muted">
        <img
          v-if="imageUrl(item)"
          :src="imageUrl(item) || undefined"
          :alt="item.title"
          width="704"
          height="478"
          loading="lazy"
          class="size-full object-cover"
        >
      </div>
      <span class="mt-6 inline-block rounded bg-[var(--tenant-primary-dark,var(--blawby-primary-dark,#1e293b))] px-2 text-sm font-semibold uppercase text-white">
        {{ item.title }}
      </span>
      <h3 v-if="item.description" class="mt-2 tenant-display text-xl font-bold text-highlighted">
        {{ item.description }}
      </h3>
      <p v-if="item.city" class="mt-4 text-sm text-highlighted">{{ item.city }}</p>
      <p v-if="item.address" class="mt-4 text-sm text-highlighted">{{ item.address }}</p>
      <p v-if="item.value" class="mt-4 text-sm text-highlighted"><span v-if="item.compareAt" class="mr-2 line-through">{{ item.compareAt }}</span>{{ item.value }}</p>
      <p v-if="item.featured" class="mt-4 text-sm text-highlighted">{{ t('saya.posts.featured') }}</p>
      <p v-if="item.unavailable" class="mt-4 text-sm text-highlighted">{{ t('saya.menu_page.unavailable') }}</p>
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
