<template>
  <div class="min-h-screen bg-default text-default">
    <header class="mx-auto max-w-7xl px-4 pt-16 pb-12 sm:px-6 lg:px-8">
      <p class="tenant-kicker mb-6">{{ t('site.reviews.title') }}</p>
      <h1 class="tenant-display-md text-default">
        <template v-if="googleReviewSummary">
          <span class="flex flex-wrap items-center gap-4">
            <span class="flex text-primary" aria-hidden="true">
              <svg
                v-for="i in 5"
                :key="i"
                viewBox="0 0 24 24"
                :fill="i <= Math.round(Number(googleReviewSummary.average)) ? 'currentColor' : 'none'"
                stroke="currentColor"
                stroke-width="1.5"
                class="size-8"
              ><path stroke-linecap="round" stroke-linejoin="round" d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z"/></svg>
            </span>
            <span class="text-muted">{{ t('site.reviews.rating_summary', { average: googleReviewSummary.average, count: googleReviewSummary.count?.toLocaleString() }) }}</span>
          </span>
        </template>
        <em v-else class="tenant-italic">{{ t('site.reviews_page.title') }}</em>
      </h1>

      <!-- Multi-location pills -->
      <div v-if="locations.length > 1" class="mt-8 flex flex-wrap gap-3">
        <NuxtLink
          v-for="loc in locations"
          :key="loc.id"
          :to="localePath(`/locations/${loc.slug}/reviews`)"
          class="inline-flex items-center gap-2 rounded-full border border-default px-5 py-2.5 text-sm text-muted no-underline transition hover:bg-muted hover:text-default"
        >
          <TenantIcon name="map-pin" class="size-3.5 opacity-70" />
          {{ loc.title }}
        </NuxtLink>
      </div>
    </header>

    <section class="mx-auto max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
      <div v-if="visibleReviews.length" class="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <TenantReviewCard
          v-for="review in visibleReviews"
          :key="review.id"
          :review="review"
          :location-title="locations.length > 1 ? review.location_title : null"
        />
      </div>
      <div v-else class="rounded-2xl border border-dashed border-default py-20 text-center">
        <h2 class="tenant-display tenant-italic text-3xl text-default">{{ t('site.reviews.empty_title') }}</h2>
        <p class="mt-2 text-sm text-muted">{{ t('site.reviews.empty_desc') }}</p>
      </div>
    </section>

    <!-- Load more -->
    <div v-if="hasMore" class="mx-auto max-w-7xl px-4 pb-20 sm:px-6 lg:px-8 text-center">
      <button
        class="inline-flex items-center gap-2 rounded-full border border-default px-8 py-3 text-[11px] font-medium uppercase tracking-widest text-default transition hover:bg-muted"
        @click="loadMore"
      >
        {{ t('site.posts.show_more') }} <span class="opacity-50">({{ remaining }} {{ t('site.posts.remaining') }})</span>
      </button>
    </div>
  </div>
</template>

<script setup>
definePageMeta({ layout: 'tenant' })

const { organization } = useTenantOrganization()
const { localePath, t } = useI18n()

const { googleMaps, locations, sections } = await usePublicPageData()
// A section with nothing on it is not a page; the navigation hides it by the same flag.
if (sections.value?.reviews === false) throw createError({ statusCode: 404 })
const allReviews = computed(() => googleMaps.value?.reviews ?? [])

const googleReviewSummary = computed(() => {
  const summary = googleMaps.value?.business?.reviewSummary
  if (!summary) {
    const ratings = allReviews.value.map(r => r.rating).filter(Boolean)
    if (!ratings.length) return null
    return { average: (ratings.reduce((s, r) => s + r, 0) / ratings.length).toFixed(1), count: ratings.length }
  }
  const average = Number(summary.averageRating)
  if (!Number.isFinite(average) || average <= 0) return null
  return { average: average.toFixed(1), count: summary.totalReviewCount }
})

// Progressive reveal — 8 at a time
const PAGE_SIZE = 8
const visibleCount = ref(PAGE_SIZE)
const visibleReviews = computed(() => allReviews.value.slice(0, visibleCount.value))
const hasMore = computed(() => visibleCount.value < allReviews.value.length)
const remaining = computed(() => allReviews.value.length - visibleCount.value)
function loadMore() { visibleCount.value += PAGE_SIZE }

const organizationName = organization.name

useSocialMetadata(() => ({
  path: '/reviews',
  title: `${t('site.footer.reviews')} | ${organizationName}`,
  description: t('site.reviews_page.meta_description', { organization: organizationName }),
  label: t('site.footer.reviews'),
  socialImage: organization.social_image,
  breadcrumbs: [
    { name: t('site.footer.reviews'), url: '/reviews' },
  ],
}))

useSchemaOrg([
  computed(() => ({
    '@type': getBusinessSchemaTypes(organization.vertical),
    name: organizationName,
    ...(googleReviewSummary.value ? {
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: Number(googleReviewSummary.value.average),
        reviewCount: Number(googleReviewSummary.value.count),
      },
    } : {}),
    review: allReviews.value.map(r => ({
      '@type': 'Review',
      author: { '@type': 'Person', name: r.author_name || t('site.qa.guest') },
      datePublished: r.source === 'google_places' ? r.original_review_date : r.created_at,
      reviewBody: r.content ?? '',
      reviewRating: { '@type': 'Rating', ratingValue: r.rating, bestRating: 5 }
    }))
  }))
])
</script>
