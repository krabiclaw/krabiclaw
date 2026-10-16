<template>
  <!--
    The homepage opens full-bleed, its own picture behind, the heading split so
    an accent phrase can carry colour. It comes first because the home is the
    home whatever media its document also carries.
  -->
  <section
    v-if="isHome"
    data-blawby-critical-hero
    :data-has-background="backgroundSrc ? 'true' : undefined"
    class="relative overflow-hidden"
    data-parity-section="hero"
  >
    <!-- A hero declares that it takes an image or a video, so it draws both. -->
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
      alt=""
      width="1920"
      height="1080"
      fetchpriority="high"
      loading="eager"
      decoding="async"
      class="absolute inset-0 size-full object-cover object-center"
    >
    <div data-blawby-critical-hero-content class="blawby-container relative pb-36 pt-16 text-left min-[1920px]:pb-48 min-[1920px]:pt-24 min-[2560px]:pb-64 min-[2560px]:pt-32">
      <div data-blawby-critical-hero-columns class="flex flex-wrap gap-x-6 min-[1920px]:gap-x-12 min-[2560px]:gap-x-16">
        <div data-blawby-critical-hero-copy class="w-full lg:w-3/5">
          <h1 v-if="splitTitle.before || splitTitle.accent" class="max-w-4xl whitespace-pre-line blawby-display text-5xl font-medium text-white sm:text-7xl min-[1920px]:max-w-6xl min-[1920px]:text-8xl min-[2560px]:max-w-7xl min-[2560px]:text-9xl">
            {{ splitTitle.before }}<span v-if="splitTitle.accent" class="relative whitespace-nowrap text-[var(--blawby-accent)]">{{ splitTitle.accent }}</span>{{ splitTitle.after }}
          </h1>
          <p v-if="description" class="mt-6 max-w-2xl text-lg text-white min-[1920px]:max-w-3xl min-[1920px]:text-xl min-[2560px]:max-w-4xl min-[2560px]:text-2xl">{{ description }}</p>
        </div>
        <div data-blawby-critical-hero-actions class="w-full lg:w-2/5">
          <div class="mt-10 flex justify-start gap-x-6 min-[1920px]:mt-16 min-[2560px]:mt-20">
            <BlawbyButton v-if="ctaUrl && ctaLabel" :to="ctaUrl" class="gap-2">
              <svg class="size-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7.5 4.5h9A4.5 4.5 0 0 1 21 9v3a4.5 4.5 0 0 1-4.5 4.5h-4.86L7.2 20.2a.75.75 0 0 1-1.2-.6v-3.35A4.5 4.5 0 0 1 3 12V9a4.5 4.5 0 0 1 4.5-4.5Z" /></svg>
              {{ ctaLabel }}
            </BlawbyButton>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!--
    Any other page that carries its own picture opens with it, beside the title.
    `cover` and `gallery` are the document's own media slots — the same ones the
    social card is drawn from — so the picture is a property of the page, like
    its title, and the template renders it rather than the document holding a
    block that repeats it.
  -->
  <section
    v-else-if="gallery.length"
    class="mx-auto mb-8 max-w-7xl border-b border-default pt-8 sm:px-6 md:flex lg:px-8"
    data-parity-section="service-overview"
  >
    <BlawbyMediaGallery v-model="activeMedia" :media="gallery" :fallback-alt="page.title" />
    <!--
      The column beside the pictures: the rating, the name, the whole body copy
      and the two ways to start. It held the name and a line of summary, and the
      body copy sat in a band of its own below both columns.
    -->
    <div class="flex-1">
      <div class="blawby-container pb-8 pt-8">
        <h1 v-if="title" class="mx-auto max-w-4xl blawby-display text-3xl font-bold text-[var(--blawby-primary)] sm:text-4xl md:mt-2">
          <span class="flex items-center" aria-hidden="true">
            <BlawbyFeatureIcon v-for="star in 5" :key="star" name="StarIcon" class="size-5 shrink-0 text-yellow-400" />
          </span>
          {{ title }}
        </h1>
        <div v-if="overviewProse" class="mt-6">
          <BlawbyRichText
            :content="overviewProse"
            unstyled
            class="prose mx-auto mt-6 max-w-2xl text-left text-lg text-[var(--blawby-primary)]"
          />
        </div>
        <div v-if="overviewActions.length" class="mt-10 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <BlawbyButton v-for="action in overviewActions" :key="action.url" :to="action.url" class="gap-2">
            {{ action.label }}
          </BlawbyButton>
        </div>
      </div>
    </div>
  </section>

  <section v-else :data-blawby-dark-hero="isDark ? 'true' : undefined" :style="backgroundStyle" class="relative overflow-hidden" data-parity-section="page-hero">
    <div class="blawby-container relative">
      <div class="px-6 pb-4 pt-16 lg:px-8">
        <div class="mx-auto max-w-4xl text-center">
          <p v-if="eyebrow" class="mb-4 text-sm font-semibold uppercase text-[var(--blawby-accent-strong)]">
            {{ eyebrow }}
          </p>
          <h1 v-if="titleWords.length" :aria-label="title" class="blawby-display text-3xl font-bold sm:text-4xl">
            <template v-for="(word, index) in titleWords" :key="`${word}-${index}`">
              <span :class="titleWordClass(index)">{{ word + (index < titleWords.length - 1 ? ' ' : '') }}</span>
            </template>
          </h1>
          <div v-if="descriptionParts.length" class="mt-6 text-left text-lg leading-8 text-[var(--blawby-primary)]">
            <div v-for="(part, index) in descriptionParts" :key="index" class="flex items-start gap-3">
              <BlawbyRichText :content="part" unstyled class="blawby-page-hero-copy contents prose prose-lg max-w-none" />
            </div>
          </div>
          <div v-if="ctaUrl && ctaLabel" class="mt-10">
            <BlawbyButton :to="ctaUrl" class="gap-2" @click="trackCtaClick">
              <svg class="-ml-0.5 mr-2 size-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7.5 4.5h9A4.5 4.5 0 0 1 21 9v3a4.5 4.5 0 0 1-4.5 4.5h-4.86L7.2 20.2a.75.75 0 0 1-1.2-.6v-3.35A4.5 4.5 0 0 1 3 12V9a4.5 4.5 0 0 1 4.5-4.5Z" /></svg>
              {{ ctaLabel }}
            </BlawbyButton>
          </div>
          <div v-if="$slots.default" class="mt-12">
            <slot />
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import type { BlawbyDocumentPayload } from '~/utils/blawby-document-contract'
import { blockText, blockTextOrNull, blockMedia } from '~/utils/tenant-page-block-data'
import { blawbyHeroProseBlockId, blawbyShieldVariant, blawbySplitAccent, blawbySurface, type BlawbyShieldVariant } from '~/types/blawby'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const { localePath } = useI18n()

const title = computed(() => blockText(props.block.data.title))
const description = computed(() => blockTextOrNull(props.block.data.subtitle))
const eyebrow = computed(() => blockTextOrNull(props.block.data.eyebrow))

const variant = computed<BlawbyShieldVariant>(() => blawbyShieldVariant(props.page.path))

/** The page's own pictures, in the order the page carries them. */
const gallery = computed(() => props.page.media
  .filter(item => item.kind === 'image' && (item.slot === 'cover' || item.slot === 'gallery'))
  .map(item => ({
    asset_id: item.asset_id,
    public_url: item.public_url,
    alt_text: item.alt_text,
    width: item.width,
    height: item.height,
  })))
const activeMedia = ref(0)

const isHome = computed(() => props.page.path === '/')
const background = computed(() => blockMedia(props.block, 'media')[0] ?? null)
const backgroundSrc = computed(() => background.value?.public_url ?? null)
const ctaLabel = computed(() => blockTextOrNull(props.block.data.cta_label) ?? blockTextOrNull(props.block.data.label))
// An internal route is localized, so a Thai page's button stays on the Thai
// site; an absolute URL belongs to someone else and is left exactly as written.
const ctaUrl = computed(() => {
  const url = blockTextOrNull(props.block.data.cta_url) ?? blockTextOrNull(props.block.data.url)
  return url && url.startsWith('/') ? localePath(url) : url
})

/** The heading with the phrase the firm chose to emphasise cut out of it. */
const splitTitle = computed(() => blawbySplitAccent(title.value, blockText(props.block.data.accent)))

/**
 * The body copy this column draws: the page's own prose block, which the
 * renderer leaves to us so it is not also drawn in a band below. A page with
 * no prose block falls back to its summary, which is what the column used to
 * show on its own.
 */
const overviewProse = computed(() => {
  const absorbedId = blawbyHeroProseBlockId(props.page)
  const absorbed = absorbedId ? props.page.blocks.find(item => item.id === absorbedId) : null
  return (absorbed ? blockTextOrNull(absorbed.data.markdown) : null) ?? description.value
})

/**
 * The two ways to start, as the page writes them. The original held "Schedule
 * Call" and "Contact Us" with their routes inside the template; the hero block
 * already declares both button pairs, so the firm's own words are used and a
 * pair it has not written simply does not appear.
 */
const overviewActions = computed(() => [
  { label: ctaLabel.value, url: ctaUrl.value },
  { label: blockTextOrNull(props.block.data.secondary_label), url: secondaryUrl.value },
].filter((action): action is { label: string; url: string } => Boolean(action.label && action.url)))

const secondaryUrl = computed(() => {
  const url = blockTextOrNull(props.block.data.secondary_url)
  return url && url.startsWith('/') ? localePath(url) : url
})

const document = inject<Ref<BlawbyDocumentPayload> | null>('blawby-document', null)
if (!document) throw createError({ statusCode: 500, statusMessage: 'Blawby layout did not provide the requested page' })
const { trackConsultationClick } = useOrganizationConversionTracking(() => document.value.shell.consultation)
function trackCtaClick() {
  trackConsultationClick(props.page.recipe ?? 'page', props.page.path, ctaUrl.value!, props.page.page_id)
}

// The page's own colour, which the shield below cuts its shape out of, so the
// two cannot drift apart. Only the dark one restates its text colours, on the
// words themselves: a colour on the heading lost to the colour each word sets.
const backgroundStyle = computed(() => ({ backgroundColor: blawbySurface(variant.value) }))
const isDark = computed(() => variant.value === 'schedule')
function titleWordClass(index: number) {
  if (index === 1 || index === 2) return isDark.value ? 'text-[var(--blawby-accent)]' : 'text-[var(--blawby-accent-strong)]'
  return isDark.value ? 'text-white' : 'text-[var(--blawby-primary)]'
}
const titleWords = computed(() => title.value.trim().split(/\s+/).filter(Boolean))
const descriptionParts = computed(() => (description.value ?? '')
  .split(/\n\s*\n/)
  .map(part => part.trim())
  .filter(Boolean))
</script>

<style>
.blawby-page-hero-copy p {
  color: var(--ui-text-muted) !important;
  font-size: 1.125rem !important;
  line-height: 2rem !important;
  margin: 0 0 1rem !important;
}

[data-blawby-dark-hero] .blawby-page-hero-copy p {
  color: var(--color-gray-200) !important;
}

[data-blawby-dark-hero] .blawby-page-hero-copy strong {
  color: var(--color-white);
}

.blawby-page-hero-copy strong {
  color: var(--blawby-primary);
  font-weight: 700;
}

.blawby-page-hero-copy a {
  color: var(--blawby-accent-strong);
}
</style>
