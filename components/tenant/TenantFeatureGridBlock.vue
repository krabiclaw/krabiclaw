<template>
  <!-- Pricing Section -->
  <section v-if="isPricing" class="bg-elevated py-16" data-parity-section="pricing">
    <div class="tenant-container">
      <template v-if="individualPlans.length">
        <div class="mx-4 mb-12 text-center">
          <h2 class="mb-2 text-3xl font-semibold text-highlighted">Pricing for Individuals &amp; Families</h2>
          <p class="text-base text-muted">Income-based sliding scale rates</p>
        </div>
        <div class="mx-4 mb-12 grid grid-cols-1 gap-y-10 sm:mx-auto lg:grid-cols-2 lg:gap-x-8 xl:grid-cols-3">
          <TenantPricePlan v-for="plan in individualPlans" :key="`${plan.discount}-${plan.price}`" :plan="plan" />
        </div>
      </template>

      <template v-if="businessPlans.length">
        <div class="mx-4 mb-12 text-center">
          <h2 class="mb-2 text-3xl font-semibold text-highlighted">Pricing for Small Business &amp; Nonprofits</h2>
          <p class="text-base text-muted">Discounted rates for organizations</p>
        </div>
        <div class="mx-4 mb-12 grid grid-cols-1 gap-y-10 sm:mx-auto lg:grid-cols-2 lg:gap-x-8 xl:grid-cols-3">
          <TenantPricePlan v-for="plan in businessPlans" :key="`${plan.discount}-${plan.price}`" :plan="plan" />
        </div>
      </template>

      <TenantPricingCalculator v-if="calculator.enabled !== false && tableRows.length" :rows="tableRows" :note="String(calculator.note || '')" />

      <div v-if="tableRows.length" class="mt-12 grid gap-6 lg:grid-cols-[1fr_2fr]">
        <div>
          <h3 class="text-lg font-semibold text-highlighted">Federal Poverty Level Guidelines</h3>
          <p class="mt-2 text-sm leading-6 text-muted">{{ table.notice }}</p>
        </div>
        <div class="overflow-x-auto rounded-lg shadow ring-1 ring-default">
          <table class="min-w-full divide-y divide-default">
            <thead class="bg-muted">
              <tr>
                <th v-for="column in tableColumns" :key="column" scope="col" class="whitespace-nowrap px-4 py-3 text-left text-sm font-semibold text-highlighted">{{ column }}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-default bg-elevated">
              <tr v-for="(row, index) in tableRows" :key="index">
                <td v-for="cell in row" :key="String(cell)" class="whitespace-nowrap px-4 py-4 text-sm text-default">{{ cell }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div v-if="ctaLabel && ctaUrl" class="mt-10 flex justify-center">
        <TenantButton :to="ctaUrl">{{ ctaLabel }}</TenantButton>
      </div>
    </div>
  </section>

  <!-- Published Articles / Blog Grid -->
  <div v-else-if="isArticles && posts.length" class="mx-auto my-8 max-w-7xl px-6 lg:px-8" data-parity-section="articles">
    <TenantSectionHeading v-if="heading" :title="heading" centered />
    <div class="mx-auto my-16 grid max-w-2xl gap-6 sm:mt-20 md:grid-cols-2 lg:mx-0 lg:max-w-none lg:grid-cols-3">
      <ArticleCard v-for="post in posts" :key="post.path" :article="post" />
    </div>
    <div v-if="ctaLabel && ctaUrl" class="mt-10 flex justify-center">
      <TenantButton :to="ctaUrl">{{ ctaLabel }}</TenantButton>
    </div>
  </div>

  <!-- Practice Area Features (list with interactive media preview) -->
  <TenantPracticeAreaFeatures v-else-if="isPracticeArea" :features="features" :cta-label="ctaLabel" :cta-url="ctaUrl" />

  <!-- Standard Feature Cards Grid -->
  <section v-else-if="features.length" class="relative py-16" data-parity-section="features">
    <div class="tenant-container">
      <div v-if="heading || kicker" class="mb-12 max-w-2xl">
        <p v-if="kicker" class="tenant-kicker mb-4">{{ kicker }}</p>
        <h2 v-if="heading" class="tenant-display-md text-highlighted">{{ heading }}</h2>
      </div>
      <div class="relative z-20 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
        <article v-for="(feature, index) in features" :key="index" class="relative h-full rounded-2xl border border-default bg-elevated p-8 shadow-sm">
          <div v-if="feature.media[0]?.public_url" class="size-14 rounded-lg mb-6">
            <img :src="feature.media[0].public_url!" :alt="feature.title" width="56" height="56" loading="lazy" class="size-14 rounded object-cover">
          </div>
          <TenantFeatureIcon v-else-if="feature.icon" :name="feature.icon" class="size-8 text-primary mb-6" />
          <h3 class="tenant-display text-xl font-bold text-highlighted">{{ feature.title }}</h3>
          <p v-if="feature.description" class="mt-3 text-sm leading-relaxed text-muted">{{ feature.description }}</p>
        </article>
      </div>
      <div v-if="ctaLabel && ctaUrl" class="mt-12 flex justify-center">
        <TenantButton :to="ctaUrl">{{ ctaLabel }}</TenantButton>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock, TenantPageMedia } from '~/utils/tenant-page-blocks'
import { blockText, blockRecords } from '~/utils/tenant-page-block-data'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()

const heading = computed(() => blockText(props.block.data.title))
const kicker = computed(() => blockText(props.block.data.description))
const ctaLabel = computed(() => blockText(props.block.data.cta_label))
const ctaUrl = computed(() => blockText(props.block.data.cta_url))

const isPricing = computed(() => props.page.recipe === 'pricing' || props.page.path === '/pricing')
const isArticles = computed(() => blockText(props.block.data.source) === 'organization_posts' || props.page.recipe === 'blog')

const features = computed(() => blockRecords(props.block.data.items).map(item => {
  const mediaRecords = blockRecords(item.media)
  return {
    title: blockText(item.title),
    description: blockText(item.description),
    body: blockText(item.body),
    icon: blockText(item.icon),
    media: mediaRecords.map(m => ({
      asset_id: blockText(m.asset_id) || '',
      slot: blockText(m.slot),
      public_url: blockText(m.public_url),
      thumbnail_url: blockText(m.thumbnail_url) || null,
      kind: (blockText(m.kind) || 'image') as TenantPageMedia['kind'],
      alt_text: blockText(m.alt_text) || null,
    })),
  }
}).filter(f => f.title || f.description))

const isPracticeArea = computed(() => !isPricing.value && !isArticles.value && features.value.length > 0 && features.value.every(f => f.icon))

// Pricing data structures
const individualPlans = computed(() => blockRecords(props.block.data.individual_plans))
const businessPlans = computed(() => blockRecords(props.block.data.business_plans))
const calculator = computed(() => (props.block.data.calculator as ApiRecord) || {})
const table = computed(() => (props.block.data.table as ApiRecord) || {})
const tableColumns = computed(() => Array.isArray(table.value.columns) ? table.value.columns.map(String) : [])
const tableRows = computed(() => Array.isArray(table.value.rows) ? table.value.rows as unknown[][] : [])

// Articles data
const posts = computed(() => blockRecords(props.block.data.items).map(item => {
  const firstMedia = blockRecords(item.media)[0]
  return {
    path: blockText(item.url) || blockText(item.path),
    title: blockText(item.title),
    excerpt: blockText(item.description) || blockText(item.summary) || null,
    cover: firstMedia ? {
      public_url: blockText(firstMedia.public_url) || null,
      thumbnail_url: blockText(firstMedia.thumbnail_url) || null,
      alt_text: blockText(firstMedia.alt_text) || null,
      kind: blockText(firstMedia.kind) || null,
    } : null,
  }
}))
</script>
