<template>
  <div class="min-h-screen bg-default text-default">

    <!-- Loading -->
    <template v-if="pending">
      <div class="mx-auto max-w-2xl px-4 py-20 text-center">
        <div class="mx-auto h-24 w-48 animate-pulse rounded-lg bg-elevated" />
      </div>
    </template>

    <template v-else-if="location">
      <!-- Sub-nav (Level 2) -->
      <TenantSubNav 
        :location-slug="slug" 
        active="reviews" 
      />

      <!-- Compact Page header -->
      <header class="mx-auto max-w-7xl px-4 pt-12 pb-10 sm:px-6 lg:px-8 text-center">
        <NuxtLink :to="localePath(`/locations/${slug}`)" class="saya-kicker mb-8 inline-block text-muted no-underline hover:text-default">
          ← {{ t('saya.reviews_page.back_to', { title: location?.title }) }}
        </NuxtLink>
        
        <div class="flex flex-col gap-2">
          <h1 class="saya-display-md text-default">{{ t('saya.reviews_page.title') }}</h1>
          <p class="text-sm text-muted">
            {{ location?.title }}
          </p>
        </div>
      </header>
      <!-- Aggregate band — only shown when there are actual reviews -->
      <section v-if="reviews.length > 0" class="border-b border-default border-t bg-elevated">
        <div class="mx-auto grid max-w-7xl items-center gap-20 px-4 py-14 sm:px-6 lg:grid-cols-[1fr_1.4fr] lg:px-8">
          <!-- Big score -->
          <div>
            <div class="saya-display saya-italic text-default" style="font-size: clamp(72px, 10vw, 96px); line-height: 0.9; letter-spacing: -0.03em">
              {{ aggregate?.rating ? Number(aggregate.rating).toFixed(1) : '—' }}
            </div>
            <div class="mt-3 flex gap-1">
              <TenantIcon
                v-for="s in 5"
                :key="s"
                name="star"
                solid
                class="size-5"
                :class="s <= Math.round(aggregate?.rating ?? 0) ? 'text-primary' : 'text-muted'"
              />
            </div>
            <p class="mt-4 text-sm text-default">{{ t('saya.reviews_page.based_on', { count: aggregate?.review_count?.toLocaleString() ?? 0 }) }}</p>
            <a v-if="location.maps_url" :href="location.maps_url" target="_blank" rel="noopener noreferrer" class="mt-1 block text-xs tracking-wide text-muted no-underline hover:underline">{{ t('saya.reviews_page.synced_live') }}</a>
          </div>

          <!-- Star distribution -->
          <div class="flex flex-col gap-2.5">
            <div v-for="star in [5, 4, 3, 2, 1]" :key="star" class="grid grid-cols-[40px_1fr_36px] items-center gap-4">
              <div class="flex items-center gap-1 text-sm text-muted">
                {{ star }}
                <TenantIcon name="star" solid class="size-3 text-primary" />
              </div>
              <div class="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  class="h-full rounded-full bg-primary transition-all duration-500"
                  :style="`width: ${barPct(star)}%`"
                />
              </div>
              <div class="text-right tabular-nums text-sm text-muted">{{ distCount(star) }}</div>
            </div>
          </div>
        </div>
      </section>

      <!-- Filter chips — only shown when there are reviews to filter -->
      <TenantFilterTabs
        v-if="reviews.length > 0"
        v-model="activeFilter"
        :tabs="filters"
      >
        <template #extra>
          <span class="ml-auto text-[10px] tabular-nums text-muted/50">{{ filtered.length }}</span>
        </template>
      </TenantFilterTabs>

      <!-- Review list -->
      <section class="mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:px-8">
        <!-- Aggregate-only: verified Google rating exists, but no individual review rows yet -->
        <div v-if="reviews.length === 0 && aggregate?.rating" class="flex flex-col items-center justify-center rounded-3xl border border-dashed border-default py-20 text-center">
          <div class="flex gap-1 text-primary" aria-hidden="true">
            <TenantIcon v-for="s in 5" :key="s" name="star" solid class="size-5" :class="s <= Math.round(aggregate.rating) ? 'text-primary' : 'text-muted'" />
          </div>
          <div class="mt-4 saya-display saya-italic text-3xl text-default">
            {{ t('saya.reviews_page.aggregate_only_title', { rating: Number(aggregate.rating).toFixed(1), count: aggregate.review_count ?? 0 }) }}
          </div>
          <p class="mt-2 max-w-sm text-sm text-muted">{{ t('saya.reviews_page.aggregate_only_desc') }}</p>
        </div>

        <!-- True empty: no reviews, no verified aggregate -->
        <div v-else-if="reviews.length === 0" class="flex flex-col items-center justify-center rounded-3xl border border-dashed border-default py-20 text-center">
          <div class="flex size-14 items-center justify-center rounded-full bg-elevated text-muted">
            <TenantIcon name="star" class="size-7" />
          </div>
          <div class="mt-6 saya-display saya-italic text-3xl text-default">{{ t('saya.reviews_page.no_reviews_title') }}</div>
          <p class="mt-2 max-w-sm text-sm text-muted">{{ t('saya.reviews_page.no_reviews_desc') }}</p>
        </div>

        <!-- Has reviews but active filter hides them -->
        <div v-else-if="filtered.length === 0" class="rounded-3xl border border-dashed border-default p-14 text-center">
          <div class="saya-display saya-italic text-2xl text-default">{{ t('saya.reviews_page.no_match_title') }}</div>
          <p class="mt-2 text-sm text-muted">{{ t('saya.reviews_page.no_match_desc') }}</p>
          <button
            class="mt-6 rounded-full border border-default px-5 py-2.5 text-sm transition hover:bg-muted"
            @click="activeFilter = 'recent'"
          >
            {{ t('saya.reviews_page.reset_filter') }}
          </button>
        </div>

        <div v-else class="flex flex-col gap-8">
          <TenantReviewCard v-for="review in filtered" :key="review.id" :review="review" />
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'tenant' })

const { localePath, t } = useI18n()

const route = useRoute()
const { organization } = useTenantOrganization()
const slug = computed(() => String(route.params.slug))
const organizationName = computed(() => String((organization as ApiValue)?.name ?? '').trim())

const { location, reviewsAggregate, reviewsList, pending } = await usePublicPageData()
if (!location.value) throw createError({ statusCode: 404, statusMessage: 'Location not found' })
// A section with nothing on it is not a page; the navigation hides it by the same flag.
if (!location.value.sections.reviews) throw createError({ statusCode: 404 })
const aggregate = reviewsAggregate
const reviews = reviewsList

const filters = computed(() => [
  { key: 'recent', label: t('saya.reviews_page.most_recent') },
  { key: 'highest', label: t('saya.reviews_page.highest_rated') },
  { key: 'lowest', label: t('saya.reviews_page.lowest_rated') },
  { key: 'photos', label: t('saya.reviews_page.with_photos') }
])
const activeFilter = ref('recent')
const reviewMedia = (review: ApiRecord, slot: string) => Array.isArray(review.media)
  ? review.media.filter((item: ApiRecord) => item.slot === slot)
  : []

const filtered = computed(() => {
  let list = [...reviews.value]
  if (activeFilter.value === 'highest') list.sort((a, b) => b.rating - a.rating)
  else if (activeFilter.value === 'lowest') list.sort((a, b) => a.rating - b.rating)
  else if (activeFilter.value === 'photos') list = list.filter(r => reviewMedia(r, 'media').length)
  else {
    const ts = (value: ApiValue) => {
      if (typeof value !== 'string' || !value) return 0
      const parsed = Date.parse(value)
      return Number.isNaN(parsed) ? 0 : parsed
    }
    list.sort((a, b) => ts(b.created_at) - ts(a.created_at))
  }
  return list
})

const maxBarCount = computed(() =>
  Math.max(...(aggregate.value?.distribution ?? []).map((d: ApiValue) => d.count), 1)
)
function barPct(star: number) {
  const row = aggregate.value?.distribution?.find((d: ApiValue) => d.star === star)
  return row ? (row.count / maxBarCount.value) * 100 : 0
}
function distCount(star: number) {
  return aggregate.value?.distribution?.find((d: ApiValue) => d.star === star)?.count ?? 0
}





useSocialMetadata(() => ({
  path: `/locations/${slug.value}/reviews`,
  title: `Reviews · ${location.value?.title ?? ''}`,
  description: `Guest reviews for ${location.value?.title ?? ''} at ${organizationName.value}.`,
  socialImage: location.value?.social_image ?? null,
  breadcrumbs: [
    { name: 'Locations', url: '/locations' },
    { name: location.value?.title ?? slug.value, url: `/locations/${slug.value}` },
    { name: 'Reviews', url: `/locations/${slug.value}/reviews` },
  ],
}))

useSchemaOrg([
  computed(() => ({
    '@type': getBusinessSchemaTypes((organization as ApiValue)?.vertical),
    name: `${organizationName.value} — ${location.value?.title ?? ''}`,
    ...(aggregate.value?.rating ? {
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: aggregate.value.rating,
        reviewCount: aggregate.value.review_count ?? 0
      }
    } : {}),
    review: reviews.value.slice(0, 10).map((r: ApiValue) => ({
      '@type': 'Review',
      author: { '@type': 'Person', name: r.author_name },
      datePublished: r.created_at,
      reviewBody: r.content,
      reviewRating: { '@type': 'Rating', ratingValue: r.rating, bestRating: 5 }
    }))
  })),
])
</script>
