<template>
  <section v-if="reviews.length || ratingSummary" class="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
    <div class="mb-12 max-w-2xl">
      <p class="saya-kicker mb-6">{{ kicker }}</p>
      <template v-if="ratingSummary">
        <h2 class="saya-display-md flex flex-wrap items-center gap-4 text-default">
          <span class="flex text-primary" aria-hidden="true">
            <SayaIcon v-for="star in 5" :key="star" name="star" :solid="star <= Math.round(Number(ratingSummary.average))" class="size-8" />
          </span>
          <span v-if="ratingSummary.count">{{ t('saya.reviews.rating_summary', { average: ratingSummary.average, count: ratingSummary.count.toLocaleString() }) }}</span>
          <span v-else>{{ ratingSummary.average }}</span>
        </h2>
        <p class="mt-6 text-sm text-muted">{{ homeCopy.guestReviewsLabel }}</p>
      </template>
      <h2 v-else class="saya-display-md text-default">{{ heading }}</h2>
    </div>

    <!-- One chip per location, so a visitor can read a single restaurant's reviews. -->
    <div v-if="locations.length > 1 && reviews.length" class="mb-8 flex flex-wrap gap-2">
      <NuxtLink
        v-for="location in locations"
        :key="location.id"
        :to="localePath(`/locations/${location.slug}/reviews`)"
        class="rounded-full border border-default bg-default px-4 py-2 text-xs font-medium uppercase tracking-widest text-muted no-underline transition hover:border-muted hover:text-default"
      >
        {{ location.title }}
      </NuxtLink>
    </div>

    <div v-if="reviews.length" class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      <SayaReviewCard
        v-for="review in reviews"
        :key="review.id"
        :review="review"
        :location-title="locations.length > 1 ? review.location_title : null"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import SayaReviewCard from '~/components/saya/SayaReviewCard.vue'
import SayaIcon from '~/components/saya/SayaIcon.vue'
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText } from '~/utils/tenant-page-block-data'

// Saya's reviews band. The reviews themselves are the site's published records
// — the block selects them, it never stores a copy — and the star summary
// beside them is the Google profile's, which is site chrome.
const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const { localePath, locale, t } = useI18n()
const { organization } = useTenantOrganization()
const { locations, googleMaps } = useOrganizationShellState()

// The Google profile is carried on the shell as an open record; these are the
// two shapes this band reads out of it.
interface ShellReview { id: string; author_name: string | null; content: string | null; rating: number | null; location_title: string | null }
const profile = computed(() => {
  const record = googleMaps.value as { reviews?: unknown; business?: { reviewSummary?: { averageRating?: unknown; totalReviewCount?: number } | null } } | null
  // Each row is checked before it is trusted: the band reads `author_name` off
  // every entry, so one null in the shell's list took the page down.
  const rows = Array.isArray(record?.reviews) ? record.reviews : []
  return {
    reviews: rows.filter((row): row is ShellReview => Boolean(row) && typeof row === 'object' && 'id' in row),
    summary: record?.business?.reviewSummary ?? null,
  }
})

const homeCopy = computed(() => getVerticalCopy(organization.vertical, locale.value))
const kicker = computed(() => blockText(props.block.data.description) || homeCopy.value.reviewsKicker)
const heading = computed(() => blockText(props.block.data.title) || homeCopy.value.whatGuestsSayLabel)

const reviews = computed(() => profile.value.reviews
  .filter(review => review.author_name && review.content)
  .slice(0, 3)
  .map(review => ({ ...review, rating: review.rating ?? 0 })))

const ratingSummary = computed(() => {
  const summary = profile.value.summary
  if (summary) {
    const average = Number(summary.averageRating)
    return Number.isFinite(average) && average > 0 ? { average: average.toFixed(1), count: summary.totalReviewCount ?? 0 } : null
  }
  const ratings = profile.value.reviews.map(review => review.rating).filter((rating): rating is number => typeof rating === 'number' && rating > 0)
  if (!ratings.length) return null
  return { average: (ratings.reduce((total, rating) => total + rating, 0) / ratings.length).toFixed(1), count: ratings.length }
})
</script>
