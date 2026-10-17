<template>
  <!-- Blawby Video feature layout with grid pattern and dark background -->
  <section v-if="isBlawby && (block.data.video_url || features.length)" class="relative isolate overflow-hidden bg-[var(--blawby-primary-dark)]" data-parity-section="approach">
    <svg class="absolute inset-0 -z-10 size-full stroke-white/10 [mask-image:radial-gradient(100%_100%_at_top_right,white,transparent)]" aria-hidden="true">
      <defs><pattern id="blawby-grid" width="200" height="200" x="50%" y="-1" patternUnits="userSpaceOnUse"><path d="M.5 200V.5H200" fill="none" /></pattern></defs>
      <svg x="50%" y="-1" class="overflow-visible fill-(--ui-text)/20">
        <path d="M-200 0h201v201h-201Z M600 0h201v201h-201Z M-400 600h201v201h-201Z M200 800h201v201h-201Z" stroke-width="0" />
      </svg>
      <rect width="100%" height="100%" fill="url(#blawby-grid)" stroke-width="0" />
    </svg>
    <div class="mx-auto max-w-2xl px-4 py-24 sm:px-6 sm:py-32 lg:max-w-7xl lg:px-8">
      <div class="grid grid-cols-1 items-center gap-x-8 gap-y-16 lg:grid-cols-2">
        <div>
          <div class="border-b border-white/15 pb-10">
            <h2 class="mt-2 blawby-display text-3xl font-bold text-white sm:text-4xl">{{ title }}</h2>
            <p v-if="accent"><strong class="relative whitespace-nowrap blawby-display text-3xl font-bold text-[var(--blawby-accent)] sm:text-4xl">{{ accent }}</strong></p>
          </div>
          <dl v-if="features.length" class="mt-10 space-y-10">
            <div v-for="feature in features" :key="feature.name">
              <dt class="blawby-display text-xl font-bold text-white">{{ feature.name }}</dt>
              <dd class="mt-3 text-sm leading-6 text-white">{{ feature.desc }}</dd>
            </div>
          </dl>
          <p v-else-if="body" class="mt-10 text-sm leading-6 text-white">{{ body }}</p>
          <div v-if="linkUrl && linkLabel" class="mt-10">
            <TenantButton :to="linkUrl">{{ linkLabel }}</TenantButton>
          </div>
        </div>
        <div>
          <div class="overflow-hidden rounded-lg bg-muted">
            <ContentVideoEmbed v-if="block.data.video_url" :url="block.data.video_url" :title="videoTitle || title" />
            <img v-else-if="image" :src="image" :alt="imageAlt" loading="lazy" class="aspect-4/3 w-full object-cover">
          </div>
          <div v-if="images.length" class="mt-4 grid grid-cols-2 gap-4 sm:mt-6 sm:gap-6 lg:mt-8 lg:gap-8">
            <div v-for="img in images" :key="img.url" class="aspect-square overflow-hidden rounded-lg bg-muted">
              <img :src="img.url" :alt="img.alt || 'Video feature image'" width="600" height="400" loading="lazy" class="size-full object-cover object-center">
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Video feature layout with video/gallery and bullet points for other themes -->
  <section v-else-if="block.data.video_url || features.length" class="relative isolate overflow-hidden bg-elevated py-20" data-parity-section="approach">
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
const { organization } = useTenantOrganization()
const isBlawby = computed(() => organization.template?.slug === 'blawby' || organization.vertical === 'service')

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
