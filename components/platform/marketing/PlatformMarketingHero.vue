<template>
  <section v-if="page.path === '/plugin'" class="kc-mcp-hero" data-parity-section="hero">
    <div class="kc-mcp-hero__copy">
      <p v-if="eyebrow" class="kc-mcp-hero__eyebrow">{{ eyebrow }}</p>
      <h1>{{ title }}</h1>
      <p v-if="subtitle" class="kc-mcp-hero__subtitle">{{ subtitle }}</p>
      <div class="kc-mcp-hero__actions">
        <PlatformAccountCta v-if="ctaLabel && ctaUrl" :label="ctaLabel" :to="ctaUrl" size="xl" class="kc-mcp-hero__start" />
        <NuxtLink v-if="secondaryLabel && secondaryUrl" :to="secondaryUrl" class="kc-mcp-hero__link">{{ secondaryLabel }} <span aria-hidden="true">↗</span></NuxtLink>
      </div>
    </div>
    <figure v-if="pluginImage && mediaStillUrl(pluginImage)" class="kc-mcp-hero__art">
      <img :src="mediaStillUrl(pluginImage)!" :alt="pluginImage.alt_text || ''" :width="pluginImage.width ?? undefined" :height="pluginImage.height ?? undefined" fetchpriority="high" decoding="async">
    </figure>
  </section>
  <PlatformCoastalScene v-else-if="page.recipe === 'products'" :block="block" :page="page" />
  <template v-else-if="page.path === '/'">
    <section
      ref="homeHero"
      class="kc-parallax-hero"
      data-parity-section="hero"
      aria-label="KrabiClaw"
    >
      <div class="kc-parallax-hero__art" aria-hidden="true">
        <picture
          v-for="(layer, index) in parallaxLayers"
          :key="layer.name"
          class="kc-parallax-hero__layer"
          :class="'kc-parallax-hero__layer--' + (index + 1)"
          :style="{
            '--kc-layer-compensation': String(layer.compensation),
            '--kc-layer-top': layer.top + 'px',
          }"
        >
          <source media="(min-width: 1264px)" :srcset="layer.sources.lg">
          <source media="(min-width: 960px)" :srcset="layer.sources.md">
          <source media="(min-width: 600px)" :srcset="layer.sources.sm">
          <source media="(min-width: 376px)" :srcset="layer.sources.xs">
          <img
            :src="layer.sources.xxs"
            alt=""
            loading="eager"
            :fetchpriority="index === 0 ? 'high' : 'auto'"
            decoding="async"
          >
        </picture>

        <picture class="kc-parallax-hero__foreground">
          <source media="(min-width: 1264px)" :srcset="parallaxForeground.lg">
          <source media="(min-width: 960px)" :srcset="parallaxForeground.md">
          <source media="(min-width: 600px)" :srcset="parallaxForeground.sm">
          <source media="(min-width: 376px)" :srcset="parallaxForeground.xs">
          <img :src="parallaxForeground.xxs" alt="" loading="eager" decoding="async">
        </picture>
      </div>

      <div class="kc-parallax-hero__mark max-w-304 px-6">
        <div class="kc-parallax-hero__copy">
          <span v-if="eyebrow" class="kc-parallax-intro__eyebrow">
            <span class="size-1.5 rounded-full bg-(--kc-teal) shrink-0" />
            {{ eyebrow }}
          </span>

          <h1 class="kc-parallax-intro__title">
            <template v-for="(line, index) in titleLines" :key="index">
              <br v-if="index > 0">
              <span v-if="line.highlighted" class="kc-parallax-intro__highlight">{{ line.text }}</span>
              <span v-else>{{ line.text }}</span>
            </template>
            <template v-if="rotatingAccents.length">
              <br>
              <!-- Read once, whole; the turning phrase is for the eye. -->
              <span class="sr-only">{{ rotatingAccents.join(', ') }}</span>
              <span class="kc-parallax-intro__rotator" aria-hidden="true">
                <Transition name="kc-rotate" mode="out-in">
                  <span
                    :key="rotatingIndex"
                    class="kc-parallax-intro__rotating"
                    :class="'kc-parallax-intro__rotating--' + (rotatingIndex % 3)"
                  >{{ rotatingAccents[rotatingIndex] }}</span>
                </Transition>
              </span>
            </template>
          </h1>

          <p v-if="subtitle" class="kc-parallax-intro__subtitle">{{ subtitle }}</p>

          <!-- One action: sign up when signed out, the dashboard when signed in. -->
          <div v-if="ctaLabel && ctaUrl" class="kc-parallax-intro__actions">
            <PlatformAccountCta :label="ctaLabel" :to="ctaUrl" size="xl" />
          </div>
        </div>
      </div>
    </section>

    <section class="kc-parallax-intro" :style="{ '--kc-transition-image': transitionImage }" aria-hidden="true" />
  </template>

  <!-- The About header: a pill, a headline, a lede. Nothing else. -->
  <div v-else-if="page.path === '/about'" class="text-center space-y-4" data-parity-section="hero">
    <span v-if="eyebrow" class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold uppercase tracking-wider bg-primary/10 text-primary border border-primary/20">
      {{ eyebrow }}
    </span>
    <h1 class="text-4xl sm:text-6xl font-extrabold tracking-tight leading-[1.05] text-default m-0 text-balance">{{ title }}</h1>
    <p v-if="subtitle" class="text-lg sm:text-xl text-muted leading-relaxed max-w-2xl mx-auto m-0">{{ subtitle }}</p>
  </div>

  <!-- Pricing preserves the CMS headline and wording. -->
  <section v-else-if="page.path === '/pricing'" class="kc-pricing-hero" data-parity-section="hero">
    <h1>{{ title }}</h1>
    <p v-if="subtitle">{{ subtitle }}</p>
  </section>

  <!--
    The vertical pages and Features: centered, an icon pill, a two-line headline
    whose second line is the gradient, and two CTAs. The gradient's stops are the
    vertical's own accent.
  -->
  <div v-else class="text-center max-w-3xl mx-auto mb-20 flex flex-col items-center gap-6" data-parity-section="hero">
    <span v-if="eyebrow" :class="pillClass">
      <PlatformIcon v-if="eyebrowIcon" :name="eyebrowIcon" :class="pillIconClass" />
      {{ eyebrow }}
    </span>
    <h1 class="text-4xl sm:text-6xl font-extrabold tracking-tight leading-[1.05] text-default m-0 text-balance">
      <template v-for="(line, index) in titleLines" :key="index">
        <br v-if="index > 0" class="hidden sm:inline">
        <span v-if="line.highlighted" :class="gradientClass">{{ line.text }}</span>
        <template v-else>{{ line.text }} </template>
      </template>
    </h1>
    <p v-if="subtitle" class="text-lg sm:text-xl text-muted leading-relaxed m-0 text-balance">{{ subtitle }}</p>
    <div v-if="ctaLabel || secondaryLabel" class="flex flex-wrap items-center justify-center gap-4 mt-2">
      <PlatformAccountCta v-if="ctaLabel" :label="ctaLabel" :to="ctaUrl || '/signup'" size="lg" class="shadow-sm transition-transform hover:-translate-y-0.5" />
      <PlatformButton v-if="secondaryLabel && secondaryUrl" :to="secondaryUrl" variant="outline" size="lg" class="transition-transform hover:-translate-y-0.5">
        {{ secondaryLabel }}
      </PlatformButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import PlatformCoastalScene from '~/components/platform/marketing/PlatformCoastalScene.vue'
import type { PlatformIconName } from '~/components/platform/PlatformIcon.vue'
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockStrings, blockText, blockTextOrNull, blockMedia } from '~/utils/tenant-page-block-data'
import { mediaStillUrl } from '~/shared/media-placement-contract'

/**
 * Each marketing page renders its authored headline and media in its own
 * presentation. The MCP page’s split composition takes precedence over the
 * shared products recipe. Homepage artwork and parallax keep their own path.
 * `title` preserves authored line breaks; `accent` marks a highlighted line.
 */
const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()

type ParallaxBreakpoint = 'xxs' | 'xs' | 'sm' | 'md' | 'lg'

type ParallaxImageSet = Record<ParallaxBreakpoint, string>

type ParallaxLayer = {
  name: string
  slot: string
  top: number
  compensation: number
  sources: ParallaxImageSet
}

/**
 * The six artwork planes are CMS media placements on the homepage hero block.
 *
 * Each plane requires its exact breakpoint slots (parallax_sky_xxs, _xs,
 * _sm, _md, _lg). These placements keep the
 * original art-directed mobile/tablet/desktop compositions editable through
 * KrabiClaw's normal media tools instead of baking image URLs into the frontend.
 */
const PARALLAX_BREAKPOINTS: ParallaxBreakpoint[] = ['xxs', 'xs', 'sm', 'md', 'lg']

function mediaUrl(slot: string): string | null {
  const media = props.block.media.find(item => item.slot === slot && item.public_url)
  return media?.public_url ?? null
}

function parallaxImageSet(slot: string): ParallaxImageSet {
  return Object.fromEntries(PARALLAX_BREAKPOINTS.map((breakpoint) => {
    const exactSlot = slot + '_' + breakpoint
    const url = mediaUrl(exactSlot)
    if (!url) throw new Error('Homepage hero is missing required media placement ' + exactSlot)
    return [breakpoint, url]
  })) as ParallaxImageSet
}

const parallaxLayers = computed<ParallaxLayer[]>(() => [
  {
    name: 'sky',
    slot: 'parallax_sky',
    top: 0,
    compensation: 1,
    sources: parallaxImageSet('parallax_sky'),
  },
  {
    name: 'clouds',
    slot: 'parallax_clouds',
    top: 0,
    compensation: 0.8,
    sources: parallaxImageSet('parallax_clouds'),
  },
  {
    name: 'mountains',
    slot: 'parallax_mountains',
    top: 120,
    compensation: 0.6,
    sources: parallaxImageSet('parallax_mountains'),
  },
  {
    name: 'far-trees',
    slot: 'parallax_far_trees',
    top: 440,
    compensation: 0.4,
    sources: parallaxImageSet('parallax_far_trees'),
  },
  {
    name: 'building-and-dark-trees',
    slot: 'parallax_building_trees',
    top: 580,
    compensation: 0.2,
    sources: parallaxImageSet('parallax_building_trees'),
  },
])

const parallaxForeground = computed<ParallaxImageSet>(() => parallaxImageSet('parallax_foreground'))
const transitionImage = computed(() => {
  const url = mediaUrl('media')
  if (!url) throw new Error('Homepage hero is missing required media placement media')
  return `url("${url}")`
})

const homeHero = ref<HTMLElement | null>(null)
let homeHeroFrame: number | null = null
let homeHeroScrollListener: (() => void) | null = null

function renderHomeParallax() {
  if (!homeHero.value) return
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    homeHero.value.style.setProperty('--kc-parallax-offset', String(Math.max(0, window.scrollY)) + 'px')
  }
}

function scheduleHomeParallax() {
  if (homeHeroFrame !== null) return
  homeHeroFrame = window.requestAnimationFrame(() => {
    homeHeroFrame = null
    renderHomeParallax()
  })
}

onMounted(() => {
  if (props.page.path !== '/') return
  // When CSS scroll-driven animations are supported, the compositor handles parallax natively without JS scroll listeners.
  if (typeof CSS !== 'undefined' && CSS.supports && CSS.supports('(animation-timeline: view()) and (animation-range: entry)')) {
    return
  }
  renderHomeParallax()
  homeHeroScrollListener = scheduleHomeParallax
  window.addEventListener('scroll', homeHeroScrollListener, { passive: true })
})

const ROTATION_INTERVAL_MS = 2600
const rotatingIndex = ref(0)
let rotationTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  if (rotatingAccents.value.length < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  rotationTimer = setInterval(() => {
    rotatingIndex.value = (rotatingIndex.value + 1) % rotatingAccents.value.length
  }, ROTATION_INTERVAL_MS)
})

onBeforeUnmount(() => {
  if (rotationTimer !== null) clearInterval(rotationTimer)
  if (homeHeroScrollListener) window.removeEventListener('scroll', homeHeroScrollListener)
  if (homeHeroFrame !== null) window.cancelAnimationFrame(homeHeroFrame)
})

const pluginImage = computed(() => blockMedia(props.block, 'media')[0])
const eyebrow = computed(() => blockTextOrNull(props.block.data.eyebrow))
const eyebrowIcon = computed(() => blockTextOrNull(props.block.data.eyebrow_icon) as PlatformIconName | null)
const title = computed(() => blockText(props.block.data.title))
const accent = computed(() => blockTextOrNull(props.block.data.accent))
const rotatingAccents = computed(() => blockStrings(props.block.data.rotating_accents))
const subtitle = computed(() => blockTextOrNull(props.block.data.subtitle))
const ctaLabel = computed(() => blockTextOrNull(props.block.data.cta_label))
const ctaUrl = computed(() => blockTextOrNull(props.block.data.cta_url))
const secondaryLabel = computed(() => blockTextOrNull(props.block.data.secondary_label))
const secondaryUrl = computed(() => blockTextOrNull(props.block.data.secondary_url))

interface TitlePart { text: string; highlighted: boolean }

/** One entry per forced line; a line is highlighted when it is the accent. */
const titleLines = computed<TitlePart[]>(() => title.value.split('\n').map(line => line.trim()).filter(Boolean).map(line => ({
  text: line,
  highlighted: Boolean(accent.value) && line === accent.value!.trim(),
})))


const PILL_CLASS: Record<string, string> = {
  '/features': 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider bg-primary/10 text-primary border border-primary/20',
  '/restaurants': 'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold uppercase tracking-wider bg-primary/10 text-primary border border-primary/20',
  '/experiences': 'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold uppercase tracking-wider bg-(--kc-teal)/10 text-(--kc-teal-600) border border-(--kc-teal)/20',
  '/legal': 'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold uppercase tracking-wider bg-(--kc-navy)/10 text-default border border-default/30',
}
const pillClass = computed(() => PILL_CLASS[props.page.path] ?? PILL_CLASS['/restaurants'])
const pillIconClass = computed(() => (props.page.path === '/legal' ? 'size-3.5 text-primary' : 'size-3.5'))

const GRADIENT_CLASS: Record<string, string> = {
  '/features': 'bg-gradient-to-r from-primary via-(--kc-coral) to-(--kc-teal) bg-clip-text text-transparent',
  '/restaurants': 'bg-gradient-to-r from-primary via-(--kc-coral) to-(--kc-teal) bg-clip-text text-transparent',
  '/experiences': 'bg-gradient-to-r from-(--kc-teal) via-(--kc-coral) to-primary bg-clip-text text-transparent',
  '/legal': 'bg-gradient-to-r from-primary via-(--kc-navy-700) to-(--kc-teal) bg-clip-text text-transparent',
}
const gradientClass = computed(() => GRADIENT_CLASS[props.page.path] ?? GRADIENT_CLASS['/restaurants'])
</script>

<style scoped>
.kc-parallax-hero {
  --kc-scene-ratio: 1.8;
  --kc-parallax-offset: 0px;
  position: relative;
  isolation: isolate;
  height: calc(1600px / var(--kc-scene-ratio));
  overflow: hidden;
  overflow: clip;
  /* The artwork's own black, so no strip of another shade shows at its foot. */
  background: #000;
}

.kc-parallax-hero__art {
  position: absolute;
  inset: 0;
}

.kc-parallax-hero__layer {
  position: absolute;
  top: calc(var(--kc-layer-top) / var(--kc-scene-ratio));
  right: 0;
  left: 0;
  height: 100%;
  pointer-events: none;
  transform: translate3d(0, calc(var(--kc-parallax-offset) * var(--kc-layer-compensation)), 0);
  will-change: transform;
}

.kc-parallax-hero__layer--1 { z-index: 1; }
.kc-parallax-hero__layer--2 { z-index: 3; }
.kc-parallax-hero__layer--3 { z-index: 4; }
.kc-parallax-hero__layer--4 { z-index: 5; }
.kc-parallax-hero__layer--5 { z-index: 6; }

.kc-parallax-hero__layer img,
.kc-parallax-hero__foreground img {
  display: block;
  width: 100%;
  height: 100%;
}

.kc-parallax-hero__layer img {
  object-fit: contain;
  object-position: top center;
}

.kc-parallax-hero__foreground {
  position: absolute;
  z-index: 20;
  right: 0;
  bottom: -1px;
  left: 0;
  height: calc(582px / var(--kc-scene-ratio));
  pointer-events: none;
}

.kc-parallax-hero__foreground img {
  object-fit: cover;
  object-position: top center;
}

.kc-parallax-hero__mark {
  position: absolute;
  z-index: 2;
  top: calc(120px / var(--kc-scene-ratio));
  left: 50%;
  display: flex;
  width: 100%;
  flex-direction: column;
  align-items: center;
  color: white;
  font-family: var(--font-sans);
  font-size: 1rem;
  letter-spacing: normal;
  line-height: normal;
  text-align: center;
  text-shadow: 0 2px 18px rgb(0 0 0 / 32%);
  transform: translate3d(-50%, var(--kc-parallax-offset), 0);
  will-change: transform;
}

.kc-parallax-hero__copy {
  display: flex;
  width: 100%;
  max-width: 48rem;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
}

.kc-parallax-hero__copy .kc-parallax-intro__title {
  color: white;
  font-size: clamp(2rem, 4vw, 3.25rem);
  line-height: 1.08;
}

.kc-parallax-hero__copy .kc-parallax-intro__subtitle {
  max-width: 42rem;
  color: white;
  font-size: clamp(0.95rem, 1.4vw, 1.1rem);
  line-height: 1.5;
}

@media (max-width: 599px) {
  .kc-parallax-hero__copy { gap: 0.5rem; }
  .kc-parallax-hero__copy .kc-parallax-intro__title {
    width: 100%;
    max-width: none;
    font-size: clamp(1.4rem, 6vw, 1.7rem);
    line-height: 1.08;
  }
  .kc-parallax-hero__copy .kc-parallax-intro__subtitle {
    font-size: 0.85rem;
    line-height: 1.4;
  }
  .kc-parallax-hero__copy .kc-parallax-intro__actions a {
    box-sizing: border-box;
    min-height: 44px;
    padding: 10px 20px;
    font-size: 14px;
    line-height: 24px;
  }
}

.kc-parallax-intro {
  position: relative;
  z-index: 30;
  min-height: 128px;
  margin-top: -2px;
  overflow: hidden;
  background: var(--ui-bg);
  color: var(--ui-text);
}

.kc-parallax-intro::before {
  position: absolute;
  z-index: 0;
  top: 0;
  right: 0;
  left: 0;
  height: 128px;
  background: var(--kc-transition-image) top center / 100% 100% no-repeat;
  content: "";
  pointer-events: none;
}

.kc-parallax-intro__eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--ui-text-dimmed);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  line-height: 1.25rem;
  text-transform: uppercase;
}

.kc-parallax-intro__title {
  margin: 0;
  max-width: 30ch;
  color: var(--ui-text-highlighted);
  font-size: clamp(2.4rem, 6vw, 4.75rem);
  font-weight: 700;
  letter-spacing: -0.045em;
  line-height: 1.02;
  text-wrap: balance;
}

.kc-parallax-intro__highlight {
  color: var(--kc-coral-400);
}

.kc-parallax-intro__rotator {
  display: inline-block;
}

.kc-parallax-intro__rotating {
  display: inline-block;
}

.kc-parallax-intro__rotating--0 { color: var(--kc-coral-400); }
.kc-parallax-intro__rotating--1 { color: var(--kc-teal-400); }
.kc-parallax-intro__rotating--2 { color: var(--kc-navy-300); }

.kc-rotate-enter-active,
.kc-rotate-leave-active {
  transition: opacity 0.35s ease, transform 0.35s ease;
}

.kc-rotate-enter-from {
  opacity: 0;
  transform: translateY(0.35em);
}

.kc-rotate-leave-to {
  opacity: 0;
  transform: translateY(-0.35em);
}

.kc-parallax-intro__subtitle {
  margin: 0;
  max-width: 52rem;
  color: var(--ui-text-muted);
  font-size: clamp(1rem, 1.8vw, 1.15rem);
  line-height: 1.75;
  text-wrap: pretty;
}

.kc-parallax-intro__actions {
  display: flex;
  justify-content: center;
  margin-top: 0.25rem;
}

@media (min-width: 376px) {
  .kc-parallax-hero { --kc-scene-ratio: 2.3; }
}

@media (min-width: 600px) {
  .kc-parallax-hero { --kc-scene-ratio: 2.1; }
}

@media (min-width: 960px) {
  .kc-parallax-hero { --kc-scene-ratio: 1.5; }
}

@media (min-width: 1264px) {
  .kc-parallax-hero { --kc-scene-ratio: 1.5; }
}

@media (min-width: 1904px) {
  .kc-parallax-hero { --kc-scene-ratio: 1; }
}

@media (min-width: 2544px) {
  .kc-parallax-hero { --kc-scene-ratio: 0.7; }
}

@media (max-width: 599px) {
  .kc-parallax-intro__title {
    max-width: 12ch;
    font-size: clamp(2.15rem, 10vw, 3.15rem);
  }

  .kc-parallax-intro__subtitle {
    font-size: 0.96rem;
    line-height: 1.65;
  }
}

@keyframes kc-parallax-layer-exit {
  from {
    transform: translate3d(0, 0, 0);
  }
  to {
    transform: translate3d(0, calc(100% * var(--kc-layer-compensation)), 0);
  }
}

@keyframes kc-parallax-mark-exit {
  from {
    transform: translate3d(-50%, 0, 0);
  }
  to {
    transform: translate3d(-50%, calc(1600px / var(--kc-scene-ratio)), 0);
  }
}

@keyframes kc-hero-copy-fade {
  0%, 55% {
    opacity: 1;
    pointer-events: auto;
  }
  80%, 100% {
    opacity: 0;
    pointer-events: none;
  }
}

@supports ((animation-timeline: view()) and (animation-range: entry)) {
  .kc-parallax-hero {
    view-timeline: --kc-hero-timeline block;
  }

  .kc-parallax-hero__layer {
    animation: kc-parallax-layer-exit linear both;
    animation-timeline: --kc-hero-timeline;
    animation-range: exit 0% exit 100%;
  }

  .kc-parallax-hero__mark {
    animation: kc-parallax-mark-exit linear both;
    animation-timeline: --kc-hero-timeline;
    animation-range: exit 0% exit 100%;
  }

  .kc-parallax-hero__copy {
    animation: kc-hero-copy-fade linear both;
    animation-timeline: --kc-hero-timeline;
    animation-range: exit 0% exit 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .kc-parallax-hero__layer {
    animation: none;
    transform: none;
    will-change: auto;
  }

  .kc-parallax-hero__mark {
    animation: none;
    transform: translateX(-50%);
    will-change: auto;
  }

  .kc-parallax-hero__copy {
    animation: none;
  }
}
.kc-parallax-hero__foreground::after {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 96px;
  background: linear-gradient(to bottom, transparent, #000 calc(100% - 2px), #000);
  content: '';
  pointer-events: none;
}

</style>

<style scoped>
.kc-pricing-hero { background: #171b31; color: white; text-align: center; padding: 5rem 1.5rem 3rem; }
.kc-pricing-hero h1 { font-size: clamp(2.3rem, 5vw, 4rem); line-height: 1.1; letter-spacing: -.04em; margin: 0; font-weight: 400; }
.kc-pricing-hero p { max-width: 42rem; margin: 1.5rem auto 0; color: #bbc0cf; line-height: 1.6; }
</style>

<style scoped>
.kc-mcp-hero { display: grid; grid-template-columns: 1.05fr 1fr; align-items: center; gap: clamp(2.5rem, 6vw, 6rem); padding: clamp(4rem, 7vw, 7rem) max(7%, calc((100% - 86rem) / 2)); background: #f0ece3; color: #171b31; }
.kc-mcp-hero__eyebrow { margin: 0 0 1.5rem; color: #945448; font-size: .75rem; font-weight: 600; text-transform: uppercase; letter-spacing: .15em; }
.kc-mcp-hero h1 { margin: 0; max-width: 12ch; font-size: clamp(3.4rem, 6.5vw, 6.5rem); line-height: 1.02; font-weight: 400; letter-spacing: -.055em; white-space: pre-line; text-wrap: balance; }
.kc-mcp-hero__subtitle { max-width: 32rem; margin: 2rem 0; color: #62646c; font-size: clamp(1.1rem, 1.65vw, 1.5rem); line-height: 1.6; }
.kc-mcp-hero__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 1rem 1.75rem; }
.kc-mcp-hero :deep(.kc-mcp-hero__start) { background: #171b31; color: #fff; border-radius: 999px; padding: 1rem 1.75rem; }
.kc-mcp-hero__link { display: inline-flex; align-items: center; gap: .75rem; padding: .4rem 0; border-bottom: 1px solid currentColor; color: #944537; font-size: .95rem; font-weight: 500; text-decoration: none; }
.kc-mcp-hero__link:hover { opacity: .75; }
.kc-mcp-hero__art { min-width: 0; margin: 0; }
.kc-mcp-hero__art img { display: block; width: 100%; height: auto; }
@media (max-width: 767px) {
  .kc-mcp-hero { grid-template-columns: 1fr; gap: 3rem; padding-top: 4rem; }
  .kc-mcp-hero h1 { font-size: clamp(3.2rem, 11vw, 5rem); }
}
</style>
