<template>
  <!-- Home Full-bleed Hero -->
  <section
    v-if="isHome"
    data-tenant-critical-hero
    data-saya-critical-hero
    data-blawby-critical-hero
    :data-has-background="backgroundSrc ? 'true' : undefined"
    class="relative isolate min-h-160 overflow-hidden flex items-center bg-zinc-900"
    data-parity-section="hero"
  >
    <!-- Background media layer -->
    <div data-tenant-critical-hero-media data-saya-critical-hero-media class="absolute inset-0 opacity-50">
      <video
        v-if="background?.kind === 'video'"
        :src="background.public_url!"
        :poster="background.thumbnail_url ?? undefined"
        autoplay muted loop playsinline
        aria-hidden="true"
        class="absolute inset-0 size-full object-cover object-center"
      />
      <img
        v-else-if="backgroundSrc"
        :src="backgroundSrc"
        :srcset="backgroundSrcset ?? undefined"
        sizes="100vw"
        alt=""
        aria-hidden="true"
        width="1920"
        height="1080"
        fetchpriority="high"
        loading="eager"
        decoding="async"
        class="absolute inset-0 size-full object-cover object-center"
      >
      <div
        v-else
        aria-hidden="true"
        class="absolute inset-0 flex items-center justify-center bg-[linear-gradient(135deg,var(--ui-primary)_0%,color-mix(in_srgb,var(--ui-primary)_60%,black)_100%)]"
      >
        <TenantIcon name="sparkles" class="size-24 text-white/25" />
      </div>
    </div>
    <div data-saya-critical-hero-overlay class="absolute inset-0" style="background: linear-gradient(to top, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.2) 50%, rgba(0,0,0,0.3) 100%)" />

    <div data-tenant-critical-hero-content data-saya-critical-hero-content data-blawby-critical-hero-content class="tenant-container relative z-10 w-full py-36 text-left">
      <p v-if="eyebrow" data-field="hero.eyebrow" data-saya-critical-eyebrow class="tenant-eyebrow mb-6 text-white/70">
        {{ eyebrow }}
      </p>
      <h1 data-field="hero.title" data-saya-critical-title class="tenant-display-lg max-w-4xl text-white">
        {{ title || businessTitle }}<br v-if="subtitle">
        <em v-if="subtitle" data-field="hero.subtitle" class="tenant-italic">{{ subtitle }}</em>
      </h1>
      <p v-if="description" class="mt-6 max-w-2xl text-lg text-white">
        {{ description }}
      </p>
      <div class="mt-10 flex flex-wrap gap-4">
        <TenantButton v-if="ctaUrl && ctaLabel" :to="ctaUrl" size="lg">
          {{ ctaLabel }}
        </TenantButton>
        <TenantButton v-if="secondaryUrl && secondaryLabel" :to="secondaryUrl" variant="outline" size="lg" class="text-white border-white/50 hover:bg-white/10">
          {{ secondaryLabel }}
        </TenantButton>
      </div>
    </div>
  </section>

  <!-- Schedule Hero -->
  <template v-else-if="isSchedule">
    <section class="relative isolate overflow-hidden bg-[var(--tenant-primary-dark,var(--blawby-primary-dark,#1e293b))]" data-parity-section="schedule-hero">
      <div class="tenant-container relative z-20 text-center" :class="nativeSchedule ? 'py-12 sm:py-16' : 'py-24 sm:py-32 lg:py-40'">
        <div class="mx-auto max-w-4xl">
          <p class="font-bold uppercase text-primary">{{ organizationName }}</p>
          <h1 class="tenant-display mt-3 text-4xl font-medium text-white sm:text-5xl">
            {{ title }}
          </h1>
          <p v-if="description" class="mt-6 text-lg leading-8 text-gray-300 sm:text-xl">{{ description }}</p>
          <TenantButton v-if="!nativeSchedule && scheduleDestination" :to="scheduleDestination" size="lg" class="mt-10">
            {{ scheduleLabel }}
          </TenantButton>
        </div>
      </div>
    </section>
    <OnlineConsultationBooking v-if="nativeSchedule" />
  </template>

  <!-- Gallery Overview Hero (e.g. service / practice area with media) -->
  <section
    v-else-if="gallery.length"
    class="mx-auto mb-8 max-w-7xl border-b border-default pt-8 sm:px-6 md:flex lg:px-8"
    data-parity-section="service-overview"
  >
    <TenantMediaGallery v-model="activeMedia" :media="gallery" :fallback-alt="page.title" />
    <div class="flex-1">
      <div class="tenant-container pb-8 pt-8">
        <h1 v-if="title" class="mx-auto max-w-4xl tenant-display text-3xl font-bold text-highlighted sm:text-4xl md:mt-2">
          {{ title }}
        </h1>
        <div v-if="overviewProse" class="mt-6">
          <TenantRichText :content="overviewProse" unstyled class="prose mx-auto mt-6 max-w-2xl text-left text-lg text-default" />
        </div>
        <div v-if="overviewActions.length" class="mt-10 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <TenantButton v-for="action in overviewActions" :key="action.url" :to="action.url">
            {{ action.label }}
          </TenantButton>
        </div>
      </div>
    </div>
  </section>

  <!-- Default Page Hero -->
  <section v-else class="relative overflow-hidden py-16" data-parity-section="page-hero">
    <div class="tenant-container relative">
      <div class="mx-auto max-w-4xl text-center">
        <p v-if="eyebrow" class="mb-4 text-sm font-semibold uppercase text-primary">
          {{ eyebrow }}
        </p>
        <h1 v-if="title" class="tenant-display text-3xl font-bold sm:text-4xl text-highlighted">
          {{ title }}
        </h1>
        <p v-if="description" class="mt-6 text-lg leading-8 text-muted">
          {{ description }}
        </p>
        <div v-if="ctaUrl && ctaLabel" class="mt-10">
          <TenantButton :to="ctaUrl">
            {{ ctaLabel }}
          </TenantButton>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockMedia, blockRecords } from '~/utils/tenant-page-block-data'
import { cfImageSrcset } from '~/utils/cf-image'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const route = useRoute()
const { organization } = useTenantOrganization()
const organizationName = computed(() => organization.name || '')
const businessTitle = computed(() => organization.name || '')

const isHome = computed(() => props.page.path === '/' || route.path === '/')
const isSchedule = computed(() => props.page.recipe === 'schedule' || route.path === '/schedule')

const title = computed(() => blockText(props.block?.data?.title) || props.page.title || '')
const subtitle = computed(() => blockText(props.block?.data?.subtitle) || '')
const eyebrow = computed(() => blockText(props.block?.data?.eyebrow) || '')
const description = computed(() => blockText(props.block?.data?.description) || props.page.summary || '')
const ctaLabel = computed(() => blockText(props.block?.data?.cta_label) || '')
const ctaUrl = computed(() => blockText(props.block?.data?.cta_url) || '')
const secondaryLabel = computed(() => blockText(props.block?.data?.secondary_label) || '')
const secondaryUrl = computed(() => blockText(props.block?.data?.secondary_url) || '')

const mediaList = computed(() => props.block ? blockMedia(props.block, 'media') : (props.page.media || []))
const background = computed(() => mediaList.value[0] ?? null)
const backgroundSrc = computed(() => background.value?.public_url || null)
const backgroundSrcset = computed(() => backgroundSrc.value ? cfImageSrcset(backgroundSrc.value) : null)

// Service / gallery overview support
const gallery = computed(() => {
  const assets = props.page.media?.filter(m => m.slot === 'gallery' || m.slot === 'cover') || []
  return assets.map(a => ({
    asset_id: a.asset_id || a.public_url || '',
    public_url: a.public_url || '',
    alt_text: a.alt_text ?? null,
    width: a.width ?? null,
    height: a.height ?? null,
  }))
})
const activeMedia = ref(0)
const overviewProse = computed(() => blockText(props.block?.data?.body) || '')
const overviewActions = computed(() => {
  const items = blockRecords(props.block?.data?.actions)
  return items.map(item => ({
    label: blockText(item.label),
    url: blockText(item.url),
  })).filter(a => a.label && a.url)
})

// Schedule support
const nativeSchedule = computed(() => false)
const scheduleDestination = computed(() => ctaUrl.value || '/contact')
const scheduleLabel = computed(() => ctaLabel.value || 'Schedule Consultation')
</script>
