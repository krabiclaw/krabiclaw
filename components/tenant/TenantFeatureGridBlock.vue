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
  <section
    v-else-if="features.length"
    :class="isBlawby ? 'relative bg-[var(--blawby-accent-200)] pb-16 pt-4 sm:pb-16 sm:pt-4 lg:pb-16' : 'relative py-16'"
    data-parity-section="features"
  >
    <div :class="isBlawby ? 'blawby-container' : 'tenant-container'">
      <div v-if="heading || kicker" class="mb-12 max-w-2xl">
        <p v-if="kicker" class="tenant-kicker mb-4">{{ kicker }}</p>
        <h2 v-if="heading" class="tenant-display-md text-highlighted">{{ heading }}</h2>
      </div>
      <div class="relative z-20 mt-4 grid gap-8 sm:grid-cols-2 lg:grid-cols-3" :class="isBlawby ? 'gap-10' : ''">
        <article
          v-for="(feature, index) in features"
          :key="index"
          :class="isBlawby ? 'relative h-full rounded-2xl bg-elevated p-6 shadow-xl shadow-slate-900/10' : 'relative h-full rounded-2xl border border-default bg-elevated p-8 shadow-sm'"
        >
          <div v-if="feature.media[0]?.public_url" :class="isBlawby ? 'size-16 rounded-lg' : 'size-14 rounded-lg mb-6'">
            <img :src="feature.media[0].public_url!" :alt="feature.title" width="64" height="64" loading="lazy" class="size-full rounded object-cover">
          </div>
          <TenantFeatureIcon v-else-if="feature.icon && !isBlawby" :name="feature.icon" class="size-8 text-primary mb-6" />
          <h3 class="mt-4 tenant-display text-xl font-bold text-highlighted">
            {{ feature.title }}
          </h3>
          <TenantRichText v-if="feature.body" unstyled class="prose prose-sm max-w-none text-default" :class="isBlawby ? 'mt-4 text-sm' : 'mt-3 text-sm text-muted'" :content="feature.body" />
          <p v-else-if="feature.description" class="text-default" :class="isBlawby ? 'mt-4 text-sm' : 'mt-3 text-sm leading-relaxed text-muted'">{{ feature.description }}</p>
        </article>
      </div>
      <div v-if="ctaLabel && ctaUrl" :class="isBlawby ? 'mt-10 flex justify-center' : 'mt-12 flex justify-center'">
        <TenantButton :to="ctaUrl">{{ ctaLabel }}</TenantButton>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock, TenantPageMedia } from '~/utils/tenant-page-blocks'
import { blockText, blockRecords, isInternalRoute } from '~/utils/tenant-page-block-data'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const { localePath } = useI18n()

const heading = computed(() => blockText(props.block.data.title))
const kicker = computed(() => blockText(props.block.data.description))
const ctaLabel = computed(() => blockText(props.block.data.cta_label))
const ctaUrl = computed(() => {
  const url = blockText(props.block.data.cta_url)
  return url && isInternalRoute(url) ? localePath(url) : url
})

const { organization } = useTenantOrganization()
const isBlawby = computed(() => organization.template?.slug === 'blawby' || organization.vertical === 'service')

const isArticles = computed(() => blockText(props.block.data.source) === 'organization_posts' || props.page.recipe === 'blog')

const features = computed(() => blockRecords(props.block.data.items).map((item, index) => {
  const blockMedia = props.block.media?.filter(asset =>
    asset.slot === `items.${index}.image` ||
    asset.slot === `items.${index}.media` ||
    asset.slot === `items.${index}` ||
    asset.slot === `features.${index}.image` ||
    asset.slot === `features.${index}`
  ) ?? []
  const mediaRecords = blockMedia.length ? blockMedia : blockRecords(item.media)
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
const plans = computed(() => blockRecords(props.block.data.items)
  .map(item => ({
    discount: blockText(item.title),
    price: blockText(item.value),
    description: blockText(item.description),
    features: blockText(item.description) ? [blockText(item.description)] : [],
  }))
  .filter(plan => plan.price))
const calculator = computed(() => {
  const value = props.block.data.calculator
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
})
const isPricing = computed(() => plans.value.length > 0 || tableRows.value.length > 0 || props.page.recipe === 'pricing' || props.page.path === '/pricing')
const individualPlans = computed(() => {
  const direct = blockRecords(props.block.data.individual_plans)
  return direct.length ? direct : plans.value.slice(0, 4)
})
const businessPlans = computed(() => {
  const direct = blockRecords(props.block.data.business_plans)
  return direct.length ? direct : plans.value.slice(4)
})
const table = computed(() => (calculator.value.table && typeof calculator.value.table === 'object'
  ? calculator.value.table as Record<string, unknown>
  : { rows: Array.isArray(calculator.value.rows) ? calculator.value.rows : [], notice: '' }))
const tableColumns = computed(() => (Array.isArray(table.value.columns) ? table.value.columns.map(String) : []))
const tableRows = computed(() => (Array.isArray(table.value.rows) ? table.value.rows.filter(Array.isArray) as unknown[][] : []))

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
