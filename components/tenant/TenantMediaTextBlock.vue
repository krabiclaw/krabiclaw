<template>
  <!-- Video feature layout with video/gallery and bullet points -->
  <section v-if="block.data.video_url || features.length" class="relative isolate overflow-hidden bg-elevated py-20" data-parity-section="approach">
    <div class="tenant-container">
      <div class="grid grid-cols-1 items-center gap-x-12 gap-y-12 lg:grid-cols-2">
        <div>
          <div class="border-b border-default pb-8">
            <h2 class="tenant-display text-3xl font-bold text-highlighted sm:text-4xl">{{ title }}</h2>
            <p v-if="accent" class="mt-2"><strong class="relative whitespace-nowrap tenant-display text-3xl font-bold text-primary sm:text-4xl">{{ accent }}</strong></p>
          </div>
          <dl v-if="features.length" class="mt-8 space-y-6">
            <div v-for="feature in features" :key="feature.name">
              <dt class="tenant-display text-xl font-bold text-highlighted">{{ feature.name }}</dt>
              <dd class="mt-2 text-sm leading-6 text-muted">{{ feature.desc }}</dd>
            </div>
          </dl>
          <div v-else-if="body" class="mt-6 text-base leading-relaxed text-muted">
            <p>{{ body }}</p>
          </div>
          <div v-if="linkUrl && linkLabel" class="mt-8">
            <TenantButton :to="linkUrl">{{ linkLabel }}</TenantButton>
          </div>
        </div>
        <div>
          <div v-if="block.data.video_url" class="overflow-hidden rounded-xl bg-muted shadow-lg">
            <ContentVideoEmbed :url="block.data.video_url" :title="videoTitle || title" />
          </div>
          <div v-else-if="image" class="overflow-hidden rounded-xl bg-muted shadow-lg">
            <img :src="image" :alt="imageAlt" loading="lazy" class="aspect-4/3 w-full object-cover">
          </div>
          <div v-if="images.length" class="mt-4 grid grid-cols-2 gap-4">
            <div v-for="img in images" :key="img.url" class="aspect-square overflow-hidden rounded-lg bg-muted">
              <img :src="img.url" :alt="img.alt || 'Feature image'" width="600" height="400" loading="lazy" class="size-full object-cover">
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Image alongside story text -->
  <section v-else-if="title || body" class="py-20" data-parity-section="brand-story">
    <div class="tenant-container">
      <div :class="image ? 'grid gap-16 lg:grid-cols-2 lg:items-center' : ''">
        <div v-if="image" class="overflow-hidden rounded-2xl bg-muted shadow-md">
          <img :src="image" :alt="imageAlt" loading="lazy" class="aspect-4/3 w-full object-cover">
        </div>
        <div>
          <p v-if="kicker" class="tenant-kicker mb-4">{{ kicker }}</p>
          <h2 v-if="title" class="tenant-display-md text-highlighted" :class="image ? '' : 'max-w-3xl'">
            {{ title }}
          </h2>
          <p v-if="body" class="mt-6 text-base leading-relaxed text-muted" :class="image ? '' : 'max-w-2xl'">
            {{ body }}
          </p>
          <div v-if="linkUrl && linkLabel" class="mt-8">
            <TenantButton :to="linkUrl">{{ linkLabel }}</TenantButton>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockTextOrNull, blockRecords, blockMedia, isInternalRoute } from '~/utils/tenant-page-block-data'
import ContentVideoEmbed from '~/components/content/ContentVideoEmbed.vue'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const { localePath } = useI18n()

const title = computed(() => blockText(props.block.data.title))
const accent = computed(() => blockTextOrNull(props.block.data.accent))
const kicker = computed(() => blockText(props.block.data.eyebrow) || blockText(props.block.data.kicker) || '')
const body = computed(() => blockText(props.block.data.body) || blockText(props.block.data.description))
const videoTitle = computed(() => blockTextOrNull(props.block.data.video_title))
const linkLabel = computed(() => blockText(props.block.data.label))
const linkUrl = computed(() => {
  const url = blockText(props.block.data.url)
  return url && isInternalRoute(url) ? localePath(url) : url
})

const asset = computed(() => blockMedia(props.block, 'media')[0] ?? null)
const image = computed(() => asset.value?.public_url ?? '')
const imageAlt = computed(() => asset.value?.alt_text ?? title.value)

const features = computed(() => blockRecords(props.block.data.items)
  .map(item => ({ name: blockText(item.title), desc: blockText(item.description) }))
  .filter(feature => feature.name))

const images = computed(() => blockMedia(props.block, 'gallery')
  .map(item => ({ url: item.public_url ?? '', alt: item.alt_text ?? null }))
  .filter(img => img.url))
</script>
