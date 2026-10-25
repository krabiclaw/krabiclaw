<template>
  <AppSection v-if="items.length" padding="xl">
    <div class="mb-16 max-w-2xl">
      <p class="tenant-kicker mb-6">{{ kicker }}</p>
      <h2 class="tenant-display-md text-highlighted">{{ heading }}</h2>
    </div>
    <div :class="['grid gap-8', items.length > 1 ? 'md:grid-cols-2' : '']">
      <component
        :is="item.url ? NuxtLink : 'div'"
        v-for="item in items"
        :key="item.id"
        :to="item.url ? localePath(item.url) : undefined"
        class="group block overflow-hidden rounded-2xl border border-default bg-elevated text-default no-underline transition hover:border-muted shadow-sm"
      >
        <div class="aspect-video overflow-hidden bg-muted">
          <MediaPreview
            v-if="item.media?.kind === 'video' && item.media.public_url"
            :item="{ url: item.media.public_url, kind: 'video', poster: item.media.thumbnail_url || undefined, alt: item.media.alt_text || item.title }"
            fit="contain"
          />
          <img
            v-else-if="mediaStillUrl(item.media)"
            :src="mediaStillUrl(item.media) || undefined"
            :alt="item.media?.alt_text || item.title"
            loading="lazy"
            class="aspect-video w-full object-contain transition-transform duration-500 group-hover:scale-105"
          />
          <div v-else class="flex h-full w-full items-center justify-center" aria-hidden="true">
            <svg viewBox="0 0 24 24" class="size-10 text-muted" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><g><path d="M15 10.5a3 3 0 1 1-6 0a3 3 0 0 1 6 0"/><path d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0"/></g></svg>
          </div>
        </div>
        <div class="p-8 pb-9">
          <div v-if="item.city" class="tenant-eyebrow mb-5 flex items-center gap-2 text-muted">
            <span class="size-1.5 rounded-full bg-primary" />
            {{ item.city }}
          </div>
          <div class="tenant-display tenant-italic text-3xl font-bold text-highlighted leading-none">{{ item.title }}</div>
          <div v-if="item.address" class="mt-3 text-sm leading-relaxed text-muted">{{ item.address }}</div>
          <div v-if="item.url" class="mt-6 border-t border-default pt-5">
            <span class="tenant-eyebrow text-primary">{{ visitLocationCta }}</span>
          </div>
        </div>
      </component>
    </div>
  </AppSection>
</template>

<script setup lang="ts">
import AppSection from '~/components/ui/AppSection.vue'
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockRecords } from '~/utils/tenant-page-block-data'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import { getVerticalCopy } from '~/utils/vertical-copy'
import MediaPreview, { provideMediaPreviews } from '~/components/MediaPreview.vue'

import { NuxtLink } from '#components'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
provideMediaPreviews(ref(false))
const { localePath, locale, t } = useI18n()
const { organization } = useTenantOrganization()

const homeCopy = computed(() => getVerticalCopy(organization.vertical, locale.value))
const items = computed(() => blockRecords(props.block.data.items).map((item) => {
  const media = blockRecords(item.media)[0] ?? null
  return {
    id: blockText(item.id),
    title: blockText(item.title),
    city: blockText(item.city),
    address: blockText(item.address),
    url: blockText(item.url),
    media: media
      ? {
          public_url: blockText(media.public_url) || null,
          thumbnail_url: blockText(media.thumbnail_url) || null,
          kind: blockText(media.kind) || null,
          alt_text: blockText(media.alt_text) || null,
        }
      : null,
  }
}).filter(item => item.id && item.title))

const heading = computed(() => blockText(props.block.data.title) || homeCopy.value.locationGroupLine(items.value.length) || t('site.home.locations_heading'))
const kicker = computed(() => blockText(props.block.data.description) || homeCopy.value.findUsKicker)
const visitLocationCta = computed(() => homeCopy.value.visitLocationCta)

</script>
