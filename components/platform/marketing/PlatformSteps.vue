<template>
  <!--
    Numbered steps, each a link to where it is explained, beside two pictures,
    with one button under them.
  -->
  <section class="kc-steps" data-parity-section="steps">
    <div class="kc-steps__inner">
      <h2 v-if="title" class="kc-steps__title">{{ title }}</h2>

      <div class="kc-steps__body">
        <div class="kc-steps__pictures">
          <figure v-for="(picture, index) in pictures" :key="index" class="kc-steps__picture" :class="`kc-steps__picture--${index}`">
            <img v-if="picture" :src="picture.url" :alt="picture.alt" loading="lazy" decoding="async">
            <!-- A picture not chosen yet is an empty frame, not a stand-in. -->
          </figure>
        </div>

        <div class="kc-steps__list-wrap">
          <ol class="kc-steps__list">
            <li v-for="(step, index) in steps" :key="index" class="kc-steps__step">
              <span class="kc-steps__number">{{ String(index + 1).padStart(2, '0') }}</span>
              <NuxtLink v-if="step.url" :to="route(step.url)" class="kc-steps__label">{{ step.title }}</NuxtLink>
              <span v-else class="kc-steps__label">{{ step.title }}</span>
            </li>
          </ol>
          <PlatformAccountCta v-if="ctaLabel && ctaUrl" :label="ctaLabel" :to="route(ctaUrl)" class="kc-steps__cta" />
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockRecords, blockText, blockTextOrNull, isInternalRoute } from '~/utils/tenant-page-block-data'
import { mediaStillUrl } from '~/shared/media-placement-contract'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const { localePath } = useI18n()
function route(url: string) { return isInternalRoute(url) ? localePath(url) : url }

const title = computed(() => blockTextOrNull(props.block.data.title))
const ctaLabel = computed(() => blockTextOrNull(props.block.data.cta_label))
const ctaUrl = computed(() => blockTextOrNull(props.block.data.cta_url))
const steps = computed(() => blockRecords(props.block.data.items)
  .map(item => ({ title: blockText(item.title), url: blockTextOrNull(item.url) })))

/** Two frames, filled from the gallery in its order. */
const pictures = computed(() => {
  const gallery = props.block.media
    .filter(media => media.slot === 'gallery')
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
  return [0, 1].map((index) => {
    const media = gallery[index]
    const url = mediaStillUrl(media)
    return url ? { url, alt: media?.alt_text ?? '' } : null
  })
})
</script>

<style scoped>
.kc-steps {
  padding: clamp(4rem, 9vw, 7rem) 0;
  background: var(--ui-bg);
  color: var(--ui-text);
}

.kc-steps__inner {
  width: min(100% - clamp(2rem, 6vw, 6rem), 118rem);
  margin: 0 auto;
}

.kc-steps__title {
  margin: 0 0 clamp(2.5rem, 5vw, 4.5rem);
  color: var(--ui-text-highlighted);
  font-size: clamp(2.4rem, 5.5vw, 5rem);
  letter-spacing: -0.03em;
  line-height: 1.05;
  text-align: center;
}

.kc-steps__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  align-items: center;
  gap: clamp(2rem, 6vw, 6rem);
}

.kc-steps__pictures {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: clamp(0.75rem, 1.5vw, 1.5rem);
}

.kc-steps__picture {
  margin: 0;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  border-radius: 1rem;
  background: var(--ui-bg-elevated);
}

.kc-steps__picture--1 {
  margin-top: 20%;
}

.kc-steps__picture img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.kc-steps__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.kc-steps__step {
  display: flex;
  align-items: baseline;
  gap: clamp(1rem, 3vw, 2.5rem);
  padding: clamp(0.9rem, 1.6vw, 1.4rem) 0;
}

.kc-steps__step + .kc-steps__step {
  border-top: 1px solid var(--ui-border);
}

.kc-steps__number {
  flex: none;
  color: var(--kc-coral-400);
  font-size: clamp(1rem, 1.6vw, 1.4rem);
  font-variant-numeric: tabular-nums;
}

.kc-steps__label {
  color: var(--ui-text-highlighted);
  font-family: var(--font-heading);
  font-size: clamp(1.6rem, 3.2vw, 3rem);
  font-weight: 300;
  line-height: 1.15;
  text-decoration: none;
}

a.kc-steps__label:hover {
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 0.15em;
}

.kc-steps__cta {
  display: inline-flex;
  align-items: center;
  margin-top: clamp(2rem, 4vw, 3.5rem);
  padding: 0.9rem 1.75rem;
  border-radius: 999px;
  background: var(--ui-text-highlighted);
  color: var(--ui-bg);
  font-size: 1.05rem;
  font-weight: 600;
  text-decoration: none;
  transition: opacity 0.2s ease;
}

.kc-steps__cta:hover {
  opacity: 0.9;
}

@media (max-width: 899px) {
  .kc-steps__body {
    grid-template-columns: 1fr;
  }
}
</style>
