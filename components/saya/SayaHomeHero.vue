<template>
  <section id="section-hero" data-saya-critical-hero class="relative min-h-160 overflow-hidden flex items-center bg-zinc-900">
    <!-- Background media layer — wrapper opacity-50 matches location page style. -->
    <div data-saya-critical-hero-media class="absolute inset-0 opacity-50">
      <!-- Poster image -->
      <img
        v-if="hero.thumbnail_url && hero.video"
        :src="heroImageUrl ?? undefined"
        :srcset="heroImageSrcset ?? undefined"
        sizes="100vw"
        alt="" aria-hidden="true" loading="eager" fetchpriority="high" decoding="async"
        class="absolute inset-0 h-full w-full object-cover"
      />
      <!-- Image-only hero (no video) -->
      <img
        v-else-if="hero.image && hero.imageKind === 'image'"
        :src="heroImageUrl ?? undefined"
        :srcset="heroImageSrcset ?? undefined"
        sizes="100vw"
        alt="" aria-hidden="true" loading="eager" fetchpriority="high" decoding="async"
        class="absolute inset-0 h-full w-full object-cover"
      />
      <!-- No real photo yet: an action-color + icon treatment, not a stock photo that
           isn't actually theirs and not a blank panel either. -->
      <div
        v-else
        aria-hidden="true"
        class="absolute inset-0 flex items-center justify-center bg-[linear-gradient(135deg,var(--ui-primary)_0%,color-mix(in_srgb,var(--ui-primary)_60%,black)_100%)]"
      >
        <svg v-if="isExperienceVertical" viewBox="0 0 24 24" class="size-24 text-white/25" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09m8.445-7.188L18 9.75l-.259-1.035a3.38 3.38 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.38 3.38 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.38 3.38 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.38 3.38 0 0 0-2.456 2.456m-1.365 11.852L16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183l.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394l-1.183.394a2.25 2.25 0 0 0-1.423 1.423"/></svg>
        <svg v-else viewBox="0 0 24 24" class="size-24 text-white/25" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path d="M13.5 21v-7.5a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 .75.75V21m-4.5 0H2.36m11.14 0H18m0 0h3.64m-1.39 0V9.349M3.75 21V9.349m0 0a3 3 0 0 0 3.75-.615A3 3 0 0 0 9.75 9.75c.896 0 1.7-.393 2.25-1.016a3 3 0 0 0 2.25 1.016c.896 0 1.7-.393 2.25-1.015q.062.07.128.136a3 3 0 0 0 3.622.478m-16.5 0a3.004 3.004 0 0 1-.621-4.72l1.189-1.19A1.5 1.5 0 0 1 5.378 3h13.243a1.5 1.5 0 0 1 1.06.44l1.19 1.189a3 3 0 0 1-.621 4.72M6.75 18h3.75a.75.75 0 0 0 .75-.75V13.5a.75.75 0 0 0-.75-.75H6.75a.75.75 0 0 0-.75.75v3.75c0 .414.336.75.75.75"/></svg>
      </div>

      <!-- Video: opacity-0 in DOM, fades to opacity-100 after canplay.
           Parent opacity-50 applies, so final rendered opacity is 0.5. -->
      <ClientOnly v-if="hero.video && hero.videoKind === 'video'">
        <video
          v-if="showVideo"
          ref="videoEl"
          :poster="cfImageVariant(hero.thumbnail_url, { width: 1200 }) ?? undefined"
          muted loop playsinline preload="none"
          aria-hidden="true" role="presentation"
          class="absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-700"
        />
      </ClientOnly>
    </div>
    <div data-saya-critical-hero-overlay class="absolute inset-0" style="background: linear-gradient(to top, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.2) 50%, rgba(0,0,0,0.3) 100%)" />

    <!-- Content — plain transparent wrapper matching the proven inline hero
         (pages/index.vue, pre-consolidation): AppSection bg="black" rendered
         an opaque bg-inverted section here that painted over the hero image
         behind it. The dark look comes entirely from the image + gradient
         overlay above, not from a background on this wrapper. -->
    <div data-saya-critical-hero-content class="relative z-10 mx-auto w-full max-w-7xl px-4 py-36 sm:px-6 lg:px-8">
      <p v-if="eyebrow" data-field="hero.eyebrow" data-saya-critical-eyebrow class="saya-eyebrow mb-8 text-white/70">
        {{ eyebrow }}
      </p>
      <h1 data-field="hero.title" data-saya-critical-title class="saya-display-lg text-white max-w-4xl">
        {{ hero.title || businessTitle }}<br>
        <em v-if="hero.subtitle" data-field="hero.subtitle" class="saya-italic">{{ hero.subtitle }}</em>
        <em v-else-if="businessSubtitle" data-field="hero.subtitle" class="saya-italic">{{ businessSubtitle }}</em>
      </h1>

      <!-- Location pills -->
      <div v-if="hasLocations" class="mt-12 flex flex-wrap gap-3">
        <NuxtLink
          v-for="loc in locations"
          :key="loc.id"
          :to="localePath(publicLocationPath(loc))"
          class="inline-flex items-center rounded-full border border-white/40 bg-white/5 px-5 py-2.5 text-sm text-white backdrop-blur-sm no-underline transition hover:bg-white/10"
        >
          {{ loc.title }}
        </NuxtLink>
      </div>
      <div v-else class="mt-12 flex flex-wrap gap-4">
        <NuxtLink
          v-if="ctaRoute"
          :to="localePath(ctaRoute)"
          class="inline-flex items-center justify-center rounded-full bg-white px-6 py-3 text-base font-medium text-black no-underline transition hover:bg-zinc-100"
        >
          {{ reserveCta }}
        </NuxtLink>
        <NuxtLink
          v-if="showSecondaryCta"
          :to="localePath(viewMenuRoute)"
          class="inline-flex items-center justify-center rounded-full border border-white/50 px-6 py-3 text-base font-medium text-white no-underline transition hover:bg-white/10"
        >
          {{ viewMenuCta }}
        </NuxtLink>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { cfImageSrcset, cfImageVariant } from '~/utils/cf-image'
import { publicLocationPath } from '~/utils/product-presentation'

const { localePath } = useI18n()

interface HeroData {
  title?: string
  subtitle?: string
  image?: string
  imageKind?: string
  video?: string
  videoKind?: string
  thumbnail_url?: string | null
}

interface Props {
  data?: {
    hero?: HeroData
    // Pre-resolved via usePublicPageData().getField('hero.eyebrow', ...) by the
    // caller — not part of getHero()'s return shape, so it can't be read off
    // `hero` the way title/subtitle/image/video can.
    eyebrow?: string | null
    locations?: Array<{ id: string; slug: string; title: string; home_slug: string | null }>
    businessTitle?: string
    businessSubtitle?: string
    ctaRoute?: string
    reserveCta?: string
    // Vertical-aware CTA copy (e.g. "View Experiences" for experience-vertical
    // tenants vs "View Menu" for restaurants) — must come from the caller's
    // homeCopy, never hardcoded here. Getting this wrong is the canonical
    // Pottery House regression (restaurant copy on an experience-vertical site).
    viewMenuCta?: string
    viewMenuRoute?: string
    vertical?: string
  }
}

const props = withDefaults(defineProps<Props>(), { data: () => ({}) })

const hero = computed(() => props.data?.hero || {})
const eyebrow = computed(() => typeof props.data?.eyebrow === 'string' ? props.data.eyebrow : '')
const locations = computed(() => props.data?.locations || [])
const hasLocations = computed(() => locations.value.length > 1)
const businessTitle = computed(() => props.data?.businessTitle || '')
const businessSubtitle = computed(() => props.data?.businessSubtitle || '')
const ctaRoute = computed(() => props.data?.ctaRoute || '')
const reserveCta = computed(() => props.data?.reserveCta || '')
const viewMenuCta = computed(() => props.data?.viewMenuCta || '')
const viewMenuRoute = computed(() => props.data?.viewMenuRoute || '')
const showSecondaryCta = computed(() =>
  !!viewMenuRoute.value && !!viewMenuCta.value && viewMenuRoute.value !== ctaRoute.value
)
const isExperienceVertical = computed(() => props.data?.vertical === 'experience')

const heroImageSource = computed(() => {
  if (hero.value.thumbnail_url && hero.value.video) return hero.value.thumbnail_url
  if (hero.value.image && hero.value.imageKind === 'image') return hero.value.image
  return null
})
const heroImageUrl = computed(() => {
  const source = heroImageSource.value
  return source ? cfImageVariant(source, { width: 960, quality: 45 }) : null
})
const heroImageSrcset = computed(() => cfImageSrcset(heroImageSource.value, [320, 640, 960, 1440], { quality: 45 }))
const { videoEl, showVideo } = useHeroVideo(() => hero.value?.video)
</script>
