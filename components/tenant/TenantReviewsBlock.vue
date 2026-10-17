<template>
  <section
    v-if="allReviews.length || ratingSummary"
    :class="isService ? 'bg-[var(--blawby-accent-200,var(--ui-bg-muted))] py-20 sm:py-32' : 'mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8'"
    data-parity-section="reviews"
  >
    <div :class="isService ? 'tenant-container' : undefined">
      <div :class="isService ? 'mx-auto max-w-2xl md:text-center' : 'mb-12 max-w-2xl'">
        <p v-if="kicker && !isService" class="tenant-kicker mb-4">{{ kicker }}</p>
        <template v-if="ratingSummary && !isService">
          <h2 class="tenant-display-md flex flex-wrap items-center gap-4 text-highlighted">
            <span class="flex text-primary" aria-hidden="true">
              <TenantIcon v-for="star in 5" :key="star" name="star" :solid="star <= Math.round(Number(ratingSummary.average))" class="size-8" />
            </span>
            <span v-if="ratingSummary.count">{{ t('saya.reviews.rating_summary', { average: ratingSummary.average, count: ratingSummary.count.toLocaleString() }) }}</span>
            <span v-else>{{ ratingSummary.average }}</span>
          </h2>
          <p class="mt-4 text-sm text-muted">{{ homeCopy.guestReviewsLabel }}</p>
        </template>
        <h2 v-else-if="isService" class="tenant-display text-3xl font-bold text-[var(--blawby-primary,var(--ui-text-highlighted))] sm:text-4xl">
          {{ splitTitle.before }}<span v-if="splitTitle.accent" class="text-[var(--blawby-accent-strong,var(--ui-primary))]">{{ splitTitle.accent }}</span>{{ splitTitle.after }}
        </h2>
        <h2 v-else class="tenant-display-md text-highlighted">
          {{ heading || t('saya.reviews.heading') }}
        </h2>
        <p v-if="description" :class="isService ? 'mt-4 text-lg text-toned' : 'mt-4 text-lg text-muted'">{{ description }}</p>
      </div>

      <!-- Service / Blawby Review Grid -->
      <template v-if="isService">
        <ul class="mx-auto mt-16 grid max-w-2xl grid-cols-1 gap-6 sm:gap-8 lg:mt-20 lg:max-w-none lg:grid-cols-3" role="list">
          <li v-for="(column, columnIndex) in columns" :key="columnIndex">
            <ul class="flex flex-col gap-y-6 sm:gap-y-8" role="list">
              <li v-for="review in column" :key="review.id">
                <figure class="relative rounded-2xl bg-elevated p-6 shadow-xl shadow-[color:rgb(37_53_108_/_0.1)]">
                  <svg class="absolute left-6 top-6 size-12 fill-(--ui-bg-muted)" viewBox="0 0 48 48" aria-hidden="true">
                    <path d="M14 10H4v14h8c0 6-2 10-7 14l4 4c8-6 11-13 11-23V10h-6Zm24 0H28v14h8c0 6-2 10-7 14l4 4c8-6 11-13 11-23V10h-6Z" />
                  </svg>
                  <blockquote class="relative">
                    <p class="text-lg text-[var(--blawby-primary,var(--ui-text-highlighted))]">{{ review.content }}</p>
                  </blockquote>
                  <figcaption class="relative mt-6 flex items-center justify-between border-t border-default pt-6">
                    <div>
                      <p class="tenant-display text-base font-bold text-[var(--blawby-primary,var(--ui-text-highlighted))]">{{ review.author_name }}</p>
                      <p v-if="review.title" class="mt-1 text-sm text-muted">{{ review.title }}</p>
                    </div>
                    <div v-if="portrait(review)" class="overflow-hidden rounded-full bg-muted">
                      <img :src="portrait(review)!.public_url!" :alt="review.author_name || ''" width="56" height="56" loading="lazy" class="size-14 object-cover">
                    </div>
                  </figcaption>
                </figure>
              </li>
            </ul>
          </li>
        </ul>
      </template>

      <!-- Hospitality / Saya Review Grid -->
      <template v-else>
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
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockRecords } from '~/utils/tenant-page-block-data'
import { blawbySplitAccent } from '~/types/blawby'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const { localePath, t } = useI18n()
const { organization } = useTenantOrganization()
const { locations, googleMaps } = useOrganizationShellState()

const isService = computed(() => organization.template?.slug === 'blawby' || organization.vertical === 'service')

const heading = computed(() => blockText(props.block.data.title))
const kicker = computed(() => blockText(props.block.data.kicker))
const description = computed(() => blockText(props.block.data.description))
const splitTitle = computed(() => blawbySplitAccent(heading.value || 'What Clients Say', blockText(props.block.data.accent) || 'Say'))

const homeCopy = computed(() => ({
  guestReviewsLabel: t('saya.home.guest_reviews'),
}))

// Authored reviews from block items
const authoredReviews = computed(() => blockRecords(props.block.data.items).map(item => {
  const mediaRecords = blockRecords(item.media)
  const rawRating = item.rating !== undefined && item.rating !== null && item.rating !== '' ? Number(item.rating) : null
  const rating = rawRating !== null && !Number.isNaN(rawRating) && rawRating > 0 ? rawRating : null
  const explicitAuthor = blockText(item.author_name)
  const authorName = explicitAuthor || blockText(item.title)
  const explicitTitle = blockText(item.review_title) || (explicitAuthor ? blockText(item.title) : null)
  return {
    id: blockText(item.id) || authorName,
    author_name: authorName,
    content: blockText(item.content) || blockText(item.description) || blockText(item.body),
    rating,
    title: explicitTitle || null,
    location_title: blockText(item.location_title) || null,
    media: mediaRecords.map(m => ({
      slot: blockText(m.slot),
      public_url: blockText(m.public_url) || null,
    })),
  }
}).filter(r => r.author_name || r.content))

// Google / Shell reviews
interface ShellReview {
  id: string
  author_name: string | null
  content: string | null
  rating: number | null
  location_title: string | null
  title?: string | null
  media?: Array<{ slot: string; public_url?: string | null }>
}
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
  title: r.title ?? null,
  media: r.media ?? ([] as Array<{ slot: string; public_url?: string | null }>),
})))

const allReviews = computed(() => authoredReviews.value.length ? authoredReviews.value : shellReviews.value)
const ratingSummary = computed(() => profile.value.ratingSummary)

const columns = computed(() => {
  const list = allReviews.value
  const size = Math.ceil(list.length / 3)
  return Array.from({ length: 3 }, (_, index) => list.slice(index * size, (index + 1) * size))
})

const portrait = (review: { media?: Array<{ slot: string; public_url?: string | null }> }) =>
  review.media?.find(m => m.slot === 'portrait' && m.public_url) ?? null
</script>
