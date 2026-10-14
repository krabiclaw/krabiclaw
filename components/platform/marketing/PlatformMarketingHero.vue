<template>
  <PlatformCoastalScene v-if="page.recipe === 'products'" :block="block" :page="page" />
  <template v-else-if="page.path === '/'">
    <section
      ref="homeHero"
      class="kc-parallax-hero"
      data-parity-section="hero"
      aria-label="Krabiclaw"
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
          <div v-if="ctaLabel && ctaUrl" ref="heroActions" class="kc-parallax-intro__actions" :inert="heroActionCovered" :style="{ pointerEvents: heroActionCovered ? 'none' : undefined }">
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

  <!-- The plugin header: the app icon beside the title, the account CTA at the end of the row. -->
  <div v-else-if="page.path === '/plugin'" class="flex flex-col gap-6 md:flex-row md:items-center md:justify-between" data-parity-section="hero">
    <div class="flex items-center gap-6">
      <img src="/platform/apple-touch-icon.png" alt="Krabiclaw app icon" class="size-24 rounded-[28px] border border-default shadow-lg">
      <div>
        <h1 class="m-0 text-3xl font-extrabold tracking-tight text-default md:text-4xl">{{ title }}</h1>
        <p v-if="subtitle" class="mt-2 text-lg text-muted">{{ subtitle }}</p>
      </div>
    </div>
    <PlatformAccountCta v-if="ctaLabel" :label="ctaLabel" :to="ctaUrl || '/signup'" size="xl" />
  </div>

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
import { blockStrings, blockText, blockTextOrNull } from '~/utils/tenant-page-block-data'

/**
 * The hero of one of Krabiclaw's own marketing pages.
 *
 * Six pages, five shapes: the homepage's parallax artwork and intro, the
 * About header, the Pricing header with its pinging pill, the plugin header
 * with the app icon, and the centered hero the vertical pages and Features
 * share. Each shape is the markup the page rendered before it was a document,
 * chosen by the page path the way BlawbyPageHero chooses its own.
 *
 * `title` may carry "\n" where the original forced a line break, and
 * `accent` names the part of it rendered in the gradient. The vertical
 * accent decides which gradient that is. On the home shape,
 * `rotating_accents` closes the headline with one phrase at a time.
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
 * Krabiclaw's normal media tools instead of baking image URLs into the frontend.
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
const heroActions = ref<HTMLElement | null>(null)
const heroActionCovered = ref(true)
const heroAlphaMasks = new Map<string, { width: number, height: number, pixels: Uint8ClampedArray } | null>()

async function loadHeroAlphaMasks() {
  if (!homeHero.value) return
  const images = Array.from(homeHero.value.querySelectorAll<HTMLImageElement>('picture img')).slice(1)
  await Promise.all(images.map(async (image) => {
    let source = image.currentSrc
    if (source && heroAlphaMasks.has(source)) return
    try {
      await image.decode()
      source = image.currentSrc
      if (heroAlphaMasks.has(source)) return
      // Reserve this source before fetching so resize cannot fetch it twice.
      heroAlphaMasks.set(source, null)
      const response = await fetch(source)
      if (!response.ok) throw new Error('Artwork unavailable')
      const bitmap = await createImageBitmap(await response.blob())
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext('2d', { willReadFrequently: true })!
      context.drawImage(bitmap, 0, 0)
      heroAlphaMasks.set(source, { width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data })
      bitmap.close()
    }
    catch {
      // Unknown pixels keep the CTA inert; a later resize can reload them.
      heroAlphaMasks.delete(source)
    }
  }))
  updateHeroActionCoverage()
}

function updateHeroActionCoverage() {
  const hero = homeHero.value
  const action = heroActions.value
  if (!hero || !action) return
  const target = action.getBoundingClientRect()
  const clip = hero.getBoundingClientRect()
  let covered = target.top < clip.top || target.bottom > clip.bottom
  for (const image of Array.from(hero.querySelectorAll<HTMLImageElement>('picture img')).slice(1)) {
    const mask = heroAlphaMasks.get(image.currentSrc)
    // Keep interaction disabled until each covering plane's pixels are known.
    if (!mask) {
      covered = true
      continue
    }
    const bounds = image.getBoundingClientRect()
    const foreground = image.parentElement?.classList.contains('kc-parallax-hero__foreground')
    const scale = (foreground ? Math.max : Math.min)(bounds.width / mask.width, bounds.height / mask.height)
    const left = bounds.left + (bounds.width - mask.width * scale) / 2
    for (let y = Math.max(target.top, bounds.top); !covered && y < Math.min(target.bottom, bounds.bottom); y++) {
      const sourceY = Math.floor((y - bounds.top) / scale)
      if (sourceY < 0 || sourceY >= mask.height) continue
      for (let x = target.left; x < target.right; x++) {
        const sourceX = Math.floor((x - left) / scale)
        if (sourceX >= 0 && sourceX < mask.width && mask.pixels[(sourceY * mask.width + sourceX) * 4 + 3]! > 0) {
          covered = true
          break
        }
      }
    }
  }
  heroActionCovered.value = covered
}
let homeHeroFrame: number | null = null
let homeHeroScrollListener: (() => void) | null = null

function renderHomeParallax() {
  if (!homeHero.value) return
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    homeHero.value.style.setProperty('--kc-parallax-offset', String(Math.max(0, window.scrollY)) + 'px')
  }
  updateHeroActionCoverage()
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
  renderHomeParallax()
  homeHeroScrollListener = scheduleHomeParallax
  window.addEventListener('scroll', homeHeroScrollListener, { passive: true })
})

onMounted(() => {
  if (props.page.path !== '/') return
  void loadHeroAlphaMasks()
  window.addEventListener('resize', refreshHeroActionCoverage)
})

function refreshHeroActionCoverage() {
  void loadHeroAlphaMasks()
}

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
  window.removeEventListener('resize', refreshHeroActionCoverage)
  if (rotationTimer !== null) clearInterval(rotationTimer)
  if (homeHeroScrollListener) window.removeEventListener('scroll', homeHeroScrollListener)
  if (homeHeroFrame !== null) window.cancelAnimationFrame(homeHeroFrame)
})

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

@media (prefers-reduced-motion: reduce) {
  .kc-parallax-hero__layer {
    transform: none;
    will-change: auto;
  }

  .kc-parallax-hero__mark {
    transform: translateX(-50%);
    will-change: auto;
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
