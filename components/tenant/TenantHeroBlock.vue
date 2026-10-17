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

    <div
      v-if="isBlawby || splitTitle.accent"
      data-tenant-critical-hero-content
      data-blawby-critical-hero-content
      class="tenant-container relative z-10 w-full pb-36 pt-16 text-left min-[1920px]:pb-48 min-[1920px]:pt-24 min-[2560px]:pb-64 min-[2560px]:pt-32"
    >
      <div data-blawby-critical-hero-columns class="flex flex-wrap gap-x-6 min-[1920px]:gap-x-12 min-[2560px]:gap-x-16">
        <div data-blawby-critical-hero-copy class="w-full lg:w-3/5">
          <h1 class="max-w-4xl whitespace-pre-line tenant-display text-5xl font-medium text-white sm:text-7xl min-[1920px]:max-w-6xl min-[1920px]:text-8xl min-[2560px]:max-w-7xl min-[2560px]:text-9xl">
            {{ splitTitle.before }}<span v-if="splitTitle.accent" class="relative whitespace-nowrap text-[var(--blawby-accent,var(--ui-primary))]">{{ splitTitle.accent }}</span>{{ splitTitle.after }}
          </h1>
          <p v-if="description" class="mt-6 max-w-2xl text-lg text-white min-[1920px]:max-w-3xl min-[1920px]:text-xl min-[2560px]:max-w-4xl min-[2560px]:text-2xl">
            {{ description }}
          </p>
        </div>
        <div data-blawby-critical-hero-actions class="w-full lg:w-2/5">
          <div class="mt-10 flex justify-start gap-x-6 min-[1920px]:mt-16 min-[2560px]:mt-20">
            <TenantButton v-if="ctaUrl && ctaLabel" :to="ctaUrl" size="lg" class="gap-2">
              <svg class="size-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7.5 4.5h9A4.5 4.5 0 0 1 21 9v3a4.5 4.5 0 0 1-4.5 4.5h-4.86L7.2 20.2a.75.75 0 0 1-1.2-.6v-3.35A4.5 4.5 0 0 1 3 12V9a4.5 4.5 0 0 1 4.5-4.5Z" /></svg>
              {{ ctaLabel }}
            </TenantButton>
          </div>
        </div>
      </div>
    </div>

    <!-- Narrative full-bleed hero for Saya -->
    <div
      v-else
      data-tenant-critical-hero-content
      data-saya-critical-hero-content
      class="tenant-container relative z-10 w-full py-36 text-left"
    >
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
      <div class="blawby-container relative z-20 text-center" :class="nativeSchedule ? 'py-12 sm:py-16' : 'py-24 sm:py-32 lg:py-40 min-[1920px]:py-48 min-[2560px]:py-64'">
        <div class="mx-auto max-w-4xl min-[1920px]:max-w-6xl min-[2560px]:max-w-7xl">
          <p class="font-bold uppercase text-[var(--blawby-accent,var(--ui-primary))]">{{ organizationName }}</p>
          <h1 v-if="splitTitle.before || splitTitle.accent || title" class="tenant-display font-medium text-white" :class="nativeSchedule ? 'mt-3 text-4xl sm:text-5xl' : 'text-5xl sm:text-7xl min-[1920px]:text-8xl min-[2560px]:text-9xl'">
            <template v-if="splitTitle.accent">
              {{ splitTitle.before }}<span class="text-[var(--blawby-accent,var(--ui-primary))]">{{ splitTitle.accent }}</span>{{ splitTitle.after }}
            </template>
            <template v-else>
              {{ title }}
            </template>
          </h1>
          <p v-for="(part, idx) in scheduleSubtitleParts" :key="idx" class="mt-6 text-lg leading-8 text-gray-300 sm:text-xl min-[1920px]:text-2xl">{{ part }}</p>
          <p v-if="schedulePriceLine && !nativeSchedule" class="mt-6 text-lg font-bold text-[var(--blawby-accent,var(--ui-primary))] sm:text-xl min-[1920px]:text-2xl">{{ schedulePriceLine }}</p>
          <TenantButton v-if="!nativeSchedule && scheduleDestination" :to="scheduleDestination" class="mt-10 w-full px-8 py-4 text-lg min-[1920px]:px-4 min-[1920px]:py-4 min-[1920px]:text-base min-[2560px]:px-5 min-[2560px]:py-5 min-[2560px]:text-lg">
            <svg class="-ml-0.5 mr-2 size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8 2v4m8-4v4M3 10h18" /><rect x="3" y="4" width="18" height="18" rx="2" /></svg>
            {{ scheduleLabel }}
          </TenantButton>
          <p v-if="scheduleNotice" class="mt-6 text-sm leading-6 text-gray-300">{{ scheduleNotice }}</p>
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
          <TenantRichText :content="overviewProse" unstyled class="prose mx-auto mt-6 max-w-2xl text-left text-lg text-default" :class="isBlawby ? 'blawby-page-hero-copy' : undefined" />
        </div>
        <div v-if="overviewActions.length" class="mt-10 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <TenantButton v-for="action in overviewActions" :key="action.url" :to="action.url" class="gap-2">
            <svg v-if="isBlawby" class="-ml-0.5 mr-2 size-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M7.5 4.5h9A4.5 4.5 0 0 1 21 9v3a4.5 4.5 0 0 1-4.5 4.5h-4.86L7.2 20.2a.75.75 0 0 1-1.2-.6v-3.35A4.5 4.5 0 0 1 3 12V9a4.5 4.5 0 0 1 4.5-4.5Z" />
            </svg>
            {{ action.label }}
          </TenantButton>
        </div>
      </div>
    </div>
  </section>

  <!-- Default Page Hero -->
  <section
    v-else
    :style="backgroundStyle"
    class="relative overflow-hidden"
    :class="isBlawby ? '' : 'py-16'"
    data-parity-section="page-hero"
  >
    <div :class="isBlawby ? 'blawby-container relative' : 'tenant-container relative'">
      <div :class="isBlawby ? 'px-6 pb-4 pt-16 lg:px-8' : ''">
        <div class="mx-auto max-w-4xl text-center">
          <p v-if="eyebrow" class="mb-4 text-sm font-semibold uppercase" :class="isBlawby ? 'text-[var(--blawby-accent-strong)]' : 'text-primary'">
            {{ eyebrow }}
          </p>
          <h1 v-if="titleWords.length" :aria-label="title" :class="isBlawby ? 'blawby-display text-3xl font-bold sm:text-4xl' : 'tenant-display text-3xl font-bold sm:text-4xl text-highlighted'">
            <template v-if="isBlawby">
              <template v-for="(word, index) in titleWords" :key="`${word}-${index}`">
                <span :class="index === 1 || index === 2 ? 'text-[var(--blawby-accent-strong)]' : 'text-[var(--blawby-primary)]'">{{ word + (index < titleWords.length - 1 ? ' ' : '') }}</span>
              </template>
            </template>
            <template v-else>
              {{ title }}
            </template>
          </h1>
          <div v-if="isBlawby && descriptionParts.length" class="mt-6 text-left text-lg leading-8 text-[var(--blawby-primary)]">
            <div v-for="(part, index) in descriptionParts" :key="index" class="flex items-start gap-3">
              <TenantRichText :content="part" unstyled class="blawby-page-hero-copy contents prose prose-lg max-w-none" />
            </div>
          </div>
          <p v-else-if="description" class="mt-6 text-lg leading-8 text-muted">
            {{ description }}
          </p>
        <div v-if="ctaUrl && ctaLabel" class="mt-10">
          <TenantButton :to="ctaUrl" class="gap-2">
            <svg v-if="isBlawby" class="-ml-0.5 mr-2 size-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7.5 4.5h9A4.5 4.5 0 0 1 21 9v3a4.5 4.5 0 0 1-4.5 4.5h-4.86L7.2 20.2a.75.75 0 0 1-1.2-.6v-3.35A4.5 4.5 0 0 1 3 12V9a4.5 4.5 0 0 1 4.5-4.5Z" /></svg>
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
import { blockText, blockMedia, blockRecords, isInternalRoute } from '~/utils/tenant-page-block-data'
import { cfImageSrcset } from '~/utils/cf-image'
import { blawbySplitAccent, blawbyShieldVariant, blawbySurface } from '~/types/blawby'
import OnlineConsultationBooking from '~/components/booking/OnlineConsultationBooking.vue'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const route = useRoute()
const { localePath, t } = useI18n()
const { organization } = useTenantOrganization()
const { consultation, canSchedule } = useOrganizationShellState()
const organizationName = computed(() => organization.name || '')
const businessTitle = computed(() => organization.name || '')
const isBlawby = computed(() => organization.template?.slug === 'blawby' || organization.vertical === 'service')

const isHome = computed(() => props.page.path === '/' || route.path === '/')
const isSchedule = computed(() => props.page.recipe === 'schedule' || route.path === '/schedule')

const title = computed(() => blockText(props.block?.data?.title) || props.page.title || '')
const subtitle = computed(() => blockText(props.block?.data?.subtitle) || '')
const eyebrow = computed(() => blockText(props.block?.data?.eyebrow) || '')
const description = computed(() => blockText(props.block?.data?.description) || props.page.summary || '')
const ctaLabel = computed(() => blockText(props.block?.data?.cta_label) || '')
const ctaUrl = computed(() => {
  const url = blockText(props.block?.data?.cta_url)
  return url && isInternalRoute(url) ? localePath(url) : (url || '')
})
const secondaryLabel = computed(() => blockText(props.block?.data?.secondary_label) || '')
const secondaryUrl = computed(() => {
  const url = blockText(props.block?.data?.secondary_url)
  return url && isInternalRoute(url) ? localePath(url) : (url || '')
})

const splitTitle = computed(() => blawbySplitAccent(title.value, blockText(props.block?.data?.accent)))
const titleWords = computed(() => title.value.trim().split(/\s+/).filter(Boolean))
const descriptionParts = computed(() => (description.value ?? '')
  .split(/\n\s*\n/)
  .map(part => part.trim())
  .filter(Boolean))
const variant = computed(() => blawbyShieldVariant(props.page.path))
const backgroundStyle = computed(() => isBlawby.value ? { backgroundColor: blawbySurface(variant.value) } : undefined)

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
const overviewProse = computed(() => {
  const absorbedId = blawbyHeroProseBlockId(props.page)
  const absorbed = absorbedId ? props.page.blocks.find(item => item.id === absorbedId) : null
  const heroProse = blockText(props.block?.data?.markdown) || blockText(props.block?.data?.body)
  return (absorbed ? (blockText(absorbed.data.markdown) || blockText(absorbed.data.body)) : null) || heroProse || description.value
})
const overviewActions = computed(() => {
  const direct = [
    { label: ctaLabel.value, url: ctaUrl.value },
    { label: secondaryLabel.value, url: secondaryUrl.value },
  ].filter((action): action is { label: string; url: string } => Boolean(action.label && action.url))
  if (direct.length) return direct

  const items = blockRecords(props.block?.data?.actions)
  return items.map(item => ({
    label: blockText(item.label),
    url: blockText(item.url),
  })).filter(a => a.label && a.url)
})

// Schedule support
const nativeSchedule = computed(() => Boolean(canSchedule.value && consultation.value?.mode === 'native'))
const scheduleBookingPrompt = computed(() => props.page.blocks?.find(item => item.type === 'booking_cta')?.data)
const schedulePriceLine = computed(() => blockText(scheduleBookingPrompt.value?.price_line))
const scheduleNotice = computed(() => blockText(scheduleBookingPrompt.value?.notice))
const scheduleSubtitle = computed(() => subtitle.value || description.value)
const scheduleSubtitleParts = computed(() => (scheduleSubtitle.value ?? '')
  .split(/\n\s*\n/)
  .map(part => part.trim())
  .filter(Boolean))

const scheduleDestination = computed(() => {
  if (!consultation.value) {
    if (!ctaUrl.value) return localePath('/contact')
    return ctaUrl.value.startsWith('/') ? localePath(ctaUrl.value) : ctaUrl.value
  }
  if (!canSchedule.value) return localePath('/contact')
  if (consultation.value.mode === 'native') return '#consultations'
  return consultation.value.external_url || localePath('/contact')
})
const scheduleLabel = computed(() => {
  if (consultation.value && !canSchedule.value) return t('site_pages.contact')
  return ctaLabel.value || consultation.value?.cta_label || t('site_pages.schedule')
})
</script>
