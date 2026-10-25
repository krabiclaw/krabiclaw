<template>
  <!--
    A grid whose rows are KrabiClaw's plans is the plans section. `source` is a
    declared field on this block and the component reads it, the same way a
    Saya grid reads its own: the map keys presentation on the template and the
    block type, and what the block says about its own rows stays the block's.
  -->
  <PlatformPricingComparison v-if="isComparison" :block="block" />
  <PlatformPlansSection v-else-if="isPlans" :block="block" :page="page" />
  <section v-else-if="page.recipe === 'products'" class="kc-product-more" :class="{ 'kc-product-more--columns': block.data.layout === 'columns', 'kc-product-more--strip': block.data.layout === 'strip' }" data-parity-section="product-more">
    <div class="kc-product-more__inner">
      <div v-if="title || (ctaLabel && ctaUrl)" class="kc-product-more__heading">
        <h2 v-if="title">{{ title }}</h2>
        <NuxtLink v-if="ctaLabel && ctaUrl" :to="route(ctaUrl)" class="kc-product-link">{{ ctaLabel }} <span aria-hidden="true">↗</span></NuxtLink>
      </div>
      <div class="kc-product-more__columns" :style="{ '--kc-columns': String(Math.min(items.length, 3)) }">
        <div v-for="item in items" :key="item.title">
          <Icon v-if="item.icon.includes(':')" :name="item.icon" class="kc-product-more__mark" aria-hidden="true" />
          <h3>{{ item.title }}</h3>
          <p>{{ item.description }}</p>
          <NuxtLink v-if="item.url && item.linkLabel" :to="route(item.url)" class="kc-product-link">{{ item.linkLabel }} <span aria-hidden="true">↗</span></NuxtLink>
        </div>
      </div>
    </div>
  </section>

  <!--
    A grid whose cards carry pictures: a large headline, the cards as a
    picture with its title and words beneath, and the grid's one button.
  -->
  <section v-else-if="variant === 'pictures'" class="kc-picture-cards" data-parity-section="picture-cards">
    <div class="kc-picture-cards__inner">
      <h2 v-if="title" class="kc-picture-cards__title">{{ title }}</h2>
      <ul class="kc-picture-cards__grid" :style="{ '--kc-columns': String(Math.min(items.length, 3)) }">
        <li v-for="item in items" :key="item.title">
          <div class="kc-picture-cards__frame">
            <img v-if="item.image" :src="item.image.url" :alt="item.image.alt" loading="lazy" decoding="async">
          </div>
          <h3 class="kc-picture-cards__card-title">{{ item.title }}</h3>
          <p v-if="item.description" class="kc-picture-cards__card-body">{{ item.description }}</p>
        </li>
      </ul>
      <div v-if="ctaLabel && ctaUrl" class="kc-picture-cards__actions">
        <NuxtLink :to="route(ctaUrl)" class="kc-picture-cards__cta">{{ ctaLabel }}</NuxtLink>
      </div>
    </div>
  </section>

  <!--
    The homepage feature band: a gradient wash and cards with navy gradient
    icon tiles that lift on hover.
  -->
  <section v-else-if="variant === 'home'" id="features" class="relative py-24 overflow-hidden" data-parity-section="features">
    <div class="absolute inset-0 -z-10" style="background: linear-gradient(180deg, var(--ui-bg-elevated) 0%, var(--ui-bg) 100%);"></div>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="text-center max-w-2xl mx-auto mb-14 flex flex-col items-center gap-4">
        <span v-if="eyebrow" class="kc-eyebrow text-muted">{{ eyebrow }}</span>
        <h2 class="text-[clamp(32px,4vw,48px)] font-extrabold tracking-tight leading-[1.05] m-0">
          <span class="text-default">{{ title }}</span>
          <template v-if="titleMuted"><br><span class="text-muted font-bold">{{ titleMuted }}</span></template>
        </h2>
        <TenantPageMarkdown v-if="description" :content="description" class="text-lg leading-relaxed text-muted m-0 [&_a]:text-primary [&_a]:underline" />
      </div>
      <div class="grid md:grid-cols-3 gap-5">
        <div
          v-for="item in items"
          :key="item.title"
          class="group relative rounded-[18px] p-7 border border-default transition-all duration-300 hover:-translate-y-0.5 hover:border-(--kc-coral)/30 hover:shadow-lg bg-white dark:bg-(--ui-bg-elevated)"
        >
          <div
            class="absolute inset-x-0 top-0 h-px rounded-t-[18px] opacity-0 group-hover:opacity-100 transition-opacity"
            style="background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--kc-coral) 40%, transparent), transparent);"
          ></div>
          <div
            class="w-12 h-12 rounded-xl flex items-center justify-center mb-5 shadow-sm"
            style="background: linear-gradient(135deg, var(--kc-navy) 0%, var(--kc-navy-700) 100%); box-shadow: 0 4px 12px rgba(31,37,71,0.15);"
          >
            <PlatformIcon :name="item.icon" class="size-5 text-white" />
          </div>
          <h3 class="text-lg font-bold mb-2 m-0 text-default">{{ item.title }}</h3>
          <p class="text-[14px] leading-relaxed m-0 text-muted">{{ item.description }}</p>
        </div>
      </div>
    </div>
  </section>

  <!-- The Features page: larger cards with a spec checklist and a documentation link each. -->
  <div v-else-if="variant === 'detailed'" class="grid md:grid-cols-2 lg:grid-cols-3 gap-6 sm:gap-8 mb-24" data-parity-section="features">
    <div
      v-for="item in items"
      :key="item.title"
      class="group relative rounded-[22px] p-8 border border-default bg-elevated/40 backdrop-blur-md hover:bg-elevated/70 hover:border-primary/40 shadow-sm hover:shadow-[0_8px_30px_rgb(0,0,0,0.04)] transition-all duration-300 flex flex-col justify-between overflow-hidden"
    >
      <div class="absolute top-0 right-0 w-24 h-24 bg-linear-to-bl from-primary/5 to-transparent rounded-bl-full group-hover:from-primary/10 transition-all duration-300"></div>
      <div>
        <div
          class="w-12 h-12 rounded-xl flex items-center justify-center mb-6 shadow-sm"
          style="background: linear-gradient(135deg, var(--kc-navy) 0%, var(--kc-navy-700) 100%); box-shadow: 0 4px 12px rgba(31,37,71,0.15);"
        >
          <PlatformIcon :name="item.icon" class="size-6 text-white" />
        </div>
        <h3 class="text-xl font-extrabold text-default mb-3 group-hover:text-primary transition-colors">{{ item.title }}</h3>
        <p class="text-[14px] leading-relaxed text-muted mb-6">{{ item.description }}</p>
        <ul v-if="item.specs?.length" class="space-y-2.5 p-0 mb-8 list-none">
          <li v-for="spec in item.specs" :key="spec" class="flex items-start gap-2 text-[13px] text-muted leading-snug">
            <PlatformIcon name="check-circle" class="size-4 shrink-0 text-(--kc-teal) mt-0.5" />
            <span>{{ spec }}</span>
          </li>
        </ul>
      </div>
      <div v-if="item.url && item.linkLabel" class="pt-4 border-t border-default/50">
        <NuxtLink
          :to="item.url"
          class="inline-flex items-center gap-1 text-[13px] font-semibold text-primary hover:text-primary/80 transition-colors no-underline group/link"
        >
          {{ item.linkLabel }}
          <PlatformIcon name="arrow-right" class="size-3.5 transition-transform group-hover/link:translate-x-1" />
        </NuxtLink>
      </div>
    </div>
  </div>

  <!-- The vertical pages: solid navy icon tiles on elevated cards. -->
  <div v-else class="max-w-6xl mx-auto mb-24" data-parity-section="features">
    <div class="text-center max-w-2xl mx-auto mb-14">
      <span v-if="eyebrow" class="kc-eyebrow text-muted">{{ eyebrow }}</span>
      <h2 class="text-3xl sm:text-4xl font-extrabold text-default mt-2">{{ title }}</h2>
    </div>
    <div class="grid md:grid-cols-3 gap-6">
      <div
        v-for="item in items"
        :key="item.title"
        class="rounded-2xl border border-default bg-elevated/40 p-7 hover:border-primary/40 transition-all duration-200 flex flex-col justify-between"
      >
        <div>
          <div class="size-11 rounded-xl bg-(--kc-navy) text-white flex items-center justify-center mb-5 shadow-sm">
            <PlatformIcon :name="item.icon" class="size-5" />
          </div>
          <h3 class="text-lg font-bold text-default mb-2">{{ item.title }}</h3>
          <p class="text-sm text-muted leading-relaxed m-0">{{ item.description }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockTextOrNull, blockRecords, blockStrings, isInternalRoute } from '~/utils/tenant-page-block-data'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import type { PlatformIconName } from '~/components/platform/PlatformIcon.vue'

export interface PlatformFeatureCard {
  title: string
  description: string
  icon: PlatformIconName
  specs?: string[]
  url?: string | null
  /** The link's words. A card that carries a route carries what to call it. */
  linkLabel?: string | null
  /** The card's own picture, at `items.<index>.image`. */
  image?: { url: string; alt: string } | null
}

/**
 * A grid of features, in the three shapes KrabiClaw's pages draw it: the
 * homepage band, the Features page's detailed cards, and the vertical pages'
 * plain grid.
 */
const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()

import PlatformPlansSection from '~/components/platform/marketing/PlatformPlansSection.vue'
import PlatformPricingComparison from '~/components/platform/marketing/PlatformPricingComparison.vue'

/** KrabiClaw's own plans, read from billing rather than written into a page. */
const isComparison = computed(() => blockText(props.block.data.source) === 'billing_features')
const isPlans = computed(() => blockText(props.block.data.source) === 'billing_plans')
const eyebrow = computed(() => blockTextOrNull(props.block.data.eyebrow))
const title = computed(() => blockTextOrNull(props.block.data.title))
const titleMuted = computed(() => blockTextOrNull(props.block.data.title_muted))
const description = computed(() => blockTextOrNull(props.block.data.description))
const items = computed<PlatformFeatureCard[]>(() => blockRecords(props.block.data.items).map((item, index) => ({
  title: blockText(item.title),
  description: blockText(item.description),
  icon: (blockTextOrNull(item.icon) ?? 'sparkles') as PlatformIconName,
  specs: blockStrings(item.specs),
  url: blockTextOrNull(item.url),
  linkLabel: blockTextOrNull(item.label),
  image: itemImage(index),
})).filter(item => item.title))
const ctaLabel = computed(() => blockTextOrNull(props.block.data.cta_label))
const ctaUrl = computed(() => blockTextOrNull(props.block.data.cta_url))
const { localePath } = useI18n()
function route(url: string) { return isInternalRoute(url) ? localePath(url) : url }

function itemImage(index: number) {
  const media = props.block.media.find(asset => asset.slot === `items.${index}.image`)
  const url = mediaStillUrl(media)
  return url ? { url, alt: media?.alt_text ?? '' } : null
}

/**
 * A card list with specifications reads as a detail page; one on a vertical
 * landing page reads as that vertical's. Both are this component's own reading
 * of its content and its page, which is what a template is for.
 */
const variant = computed<'home' | 'detailed' | 'vertical' | 'pictures'>(() => {
  if (blockText(props.block.data.layout) === 'pictures') return 'pictures'
  if (items.value.some(item => (item.specs ?? []).length)) return 'detailed'
  return ['/restaurants', '/experiences', '/lodging', '/legal'].includes(props.page.path) ? 'vertical' : 'home'
})
</script>

<style scoped>
.kc-picture-cards {
  padding: clamp(4rem, 9vw, 7rem) 0;
  background: var(--ui-bg);
  color: var(--ui-text);
}

.kc-picture-cards__inner {
  width: min(100% - clamp(2rem, 6vw, 6rem), 118rem);
  margin: 0 auto;
}

.kc-picture-cards__title {
  max-width: 22ch;
  margin: 0 0 clamp(2.5rem, 5vw, 4.5rem);
  color: var(--ui-text-highlighted);
  font-size: clamp(2.4rem, 5.5vw, 5rem);
  letter-spacing: -0.03em;
  line-height: 1.05;
  text-wrap: balance;
}

.kc-picture-cards__grid {
  display: grid;
  grid-template-columns: repeat(var(--kc-columns), minmax(0, 1fr));
  gap: clamp(1rem, 2vw, 1.75rem);
  margin: 0;
  padding: 0;
  list-style: none;
}

.kc-picture-cards__frame {
  aspect-ratio: 16 / 10;
  overflow: hidden;
  border-radius: 1rem;
  background: var(--ui-bg-elevated);
}

.kc-picture-cards__frame img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.kc-picture-cards__card-title {
  margin: 1.5rem 0 0;
  color: var(--ui-text-highlighted);
  font-size: clamp(1.25rem, 1.8vw, 1.6rem);
  font-weight: 500;
}

.kc-picture-cards__card-body {
  max-width: 40ch;
  margin: 0.75rem 0 0;
  color: var(--ui-text-muted);
  font-size: clamp(1rem, 1.4vw, 1.25rem);
  line-height: 1.55;
}

.kc-picture-cards__actions {
  display: flex;
  justify-content: center;
  margin-top: clamp(2.5rem, 5vw, 4rem);
}

.kc-picture-cards__cta {
  padding: 0.9rem 1.75rem;
  border: 1.5px solid var(--ui-text-highlighted);
  border-radius: 999px;
  color: var(--ui-text-highlighted);
  font-size: 1.05rem;
  font-weight: 600;
  text-decoration: none;
  transition: background-color 0.2s ease, color 0.2s ease;
}

.kc-product-more--columns, .kc-product-more--strip { background: #f6f4ef; color: #171920; padding: clamp(3rem, 5.5vw, 5.5rem) 0; }
.kc-product-more--columns .kc-product-more__inner, .kc-product-more--strip .kc-product-more__inner { width: min(calc(100% - 3rem), 75rem); }
.kc-product-more--columns .kc-product-more__inner { display: grid; grid-template-columns: .9fr 1.6fr; gap: 3rem; align-items: center; }
.kc-product-more--columns h2 { font-size: clamp(2rem, 3vw, 3rem); font-weight: 600; letter-spacing: -.045em; line-height: 1.1; white-space: pre-line; color: inherit; margin: 0; }
.kc-product-more--columns .kc-product-more__columns { gap: 1.5rem; }
.kc-product-more--columns .kc-product-more__columns > div { border-top: 0; border-left: 1px solid #d8d7d3; padding: 0 0 0 1.5rem; }
.kc-product-more--columns h3 { font-size: 1.1rem; letter-spacing: -.02em; }
.kc-product-more--columns p { color: #606168; font-size: .95rem; line-height: 1.5; margin: .75rem 0 0; }
.kc-product-more--columns .kc-product-link { color: #b64436; font-size: 1rem; margin-top: 1.5rem; }
.kc-product-more--columns .kc-product-more__mark { width: 2rem; height: 2rem; color: #252c47; margin-bottom: 1.25rem; }
.kc-product-more--strip { padding: 2rem 0; }
.kc-product-more--strip .kc-product-more__columns { gap: 2rem; }
.kc-product-more--strip .kc-product-more__columns > div { border: 0; padding: 0; display: grid; grid-template-columns: auto 1fr; column-gap: 1rem; align-items: center; }
.kc-product-more--strip .kc-product-more__columns > div + div { border-left: 1px solid #d8d7d3; padding-left: 2rem; }
.kc-product-more--strip .kc-product-more__mark { grid-row: 1 / 3; margin: 0; color: #db4f40; }
.kc-product-more--strip h3, .kc-product-more--strip p { grid-column: 2; }
.kc-product-more--strip h3 { font-size: 1.15rem; letter-spacing: -.02em; }
.kc-product-more--strip p { font-size: .8rem; color: #606168; margin: .25rem 0 0; line-height: 1.5; }
@media (max-width: 1100px) {
  .kc-product-more--columns .kc-product-more__inner { grid-template-columns: 1fr; }
}
.kc-picture-cards__cta:hover {
  background: var(--ui-text-highlighted);
  color: var(--ui-bg);
}

@media (max-width: 767px) {
  .kc-product-more--columns .kc-product-more__columns { grid-template-columns: 1fr; gap: 2rem; }
  .kc-product-more--columns .kc-product-more__columns > div { border-left: 0; border-top: 1px solid #d8d7d3; padding: 1.5rem 0 0; }
  .kc-product-more--strip .kc-product-more__columns { grid-template-columns: 1fr; gap: 1.25rem; }
  .kc-product-more--strip .kc-product-more__columns > div + div { border-left: 0; padding-left: 0; }
  .kc-picture-cards__grid {
    grid-template-columns: 1fr;
  }
}
</style>
