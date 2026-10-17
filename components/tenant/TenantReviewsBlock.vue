<template>
  <section v-if="allReviews.length || ratingSummary" class="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8" data-parity-section="reviews">
    <div class="mb-12 max-w-2xl">
      <p v-if="kicker" class="tenant-kicker mb-4">{{ kicker }}</p>
      <template v-if="ratingSummary">
        <h2 class="tenant-display-md flex flex-wrap items-center gap-4 text-highlighted">
          <span class="flex text-primary" aria-hidden="true">
            <TenantIcon v-for="star in 5" :key="star" name="star" :solid="star <= Math.round(Number(ratingSummary.average))" class="size-8" />
          </span>
          <span v-if="ratingSummary.count">{{ t('saya.reviews.rating_summary', { average: ratingSummary.average, count: ratingSummary.count.toLocaleString() }) }}</span>
          <span v-else>{{ ratingSummary.average }}</span>
        </h2>
        <p class="mt-4 text-sm text-muted">{{ homeCopy.guestReviewsLabel }}</p>
      </template>
      <h2 v-else class="tenant-display-md text-highlighted">
        {{ heading || t('saya.reviews.heading') }}
      </h2>
      <p v-if="description" class="mt-4 text-lg text-muted">{{ description }}</p>
    </div>

    <!-- Location filter chips if multiple locations -->
    <div v-if="locations.length > 1 && allReviews.length" class="mb-8 flex flex-wrap gap-2">
      <NuxtLink
        v-for="location in locations"
        :key="location.id"
        :to="localePath(`/locations/${location.slug}/reviews`)"
        class="rounded-full border border-default bg-elevated px-4 py-2 text-xs font-medium uppercase tracking-widest text-muted no-underline transition hover:border-muted hover:text-default"
      >
        {{ location.title }}
      </NuxtLink>
    </div>

    <div v-if="allReviews.length" class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      <TenantReviewCard
        v-for="review in allReviews"
        :key="review.id"
        :review="review"
        :location-title="locations.length > 1 ? (review.location_title || null) : null"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockRecords } from '~/utils/tenant-page-block-data'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const { localePath, t } = useI18n()
const { locations, googleMaps } = useOrganizationShellState()

const heading = computed(() => blockText(props.block.data.title))
const kicker = computed(() => blockText(props.block.data.kicker))
const description = computed(() => blockText(props.block.data.description))

const homeCopy = computed(() => ({
  guestReviewsLabel: t('saya.home.guest_reviews'),
}))

// Authored reviews from block items
const authoredReviews = computed(() => blockRecords(props.block.data.items).map(item => {
  const mediaRecords = blockRecords(item.media)
  const rawRating = item.rating !== undefined && item.rating !== null && item.rating !== '' ? Number(item.rating) : null
  const rating = rawRating !== null && !Number.isNaN(rawRating) && rawRating > 0 ? rawRating : null
  return {
    id: blockText(item.id) || blockText(item.title),
    author_name: blockText(item.title) || blockText(item.author_name),
    content: blockText(item.content) || blockText(item.description) || blockText(item.body),
    rating,
    title: blockText(item.title),
    location_title: blockText(item.location_title) || null,
    media: mediaRecords.map(m => ({
      slot: blockText(m.slot),
      public_url: blockText(m.public_url),
    })),
  }
}).filter(r => r.author_name || r.content))

// Google / Shell reviews
interface ShellReview { id: string; author_name: string | null; content: string | null; rating: number | null; location_title: string | null }
const profile = computed(() => {
  const record = googleMaps.value as { reviews?: unknown; business?: { reviewSummary?: { averageRating?: unknown; totalReviewCount?: number } | null } } | null
  return {
    reviews: Array.isArray(record?.reviews) ? record.reviews as ShellReview[] : [],
    ratingSummary: record?.business?.reviewSummary ? {
      average: Number(record.business.reviewSummary.averageRating) || 0,
      count: record.business.reviewSummary.totalReviewCount || 0,
    } : null,
  }
})

const shellReviews = computed(() => profile.value.reviews.map(r => ({
  id: r.id,
  author_name: r.author_name,
  content: r.content,
  rating: typeof r.rating === 'number' && r.rating > 0 ? r.rating : null,
  location_title: r.location_title,
})))

const allReviews = computed(() => authoredReviews.value.length ? authoredReviews.value : shellReviews.value)
const ratingSummary = computed(() => profile.value.ratingSummary)
</script>
