<template>
  <article class="flex flex-col rounded-2xl border border-default bg-elevated p-8">
    <div class="flex items-center gap-3">
      <UAvatar :src="portrait || undefined" :alt="author" icon="i-lucide-user" size="md" loading="lazy" />
      <div class="min-w-0">
        <component :is="authorHref ? 'a' : 'span'" :href="authorHref || undefined" :target="authorHref ? '_blank' : undefined" :rel="authorHref ? 'noopener noreferrer' : undefined" class="block truncate text-sm font-medium text-default no-underline hover:underline">
          {{ author }}
        </component>
        <span v-if="locationTitle" class="block truncate text-xs text-muted">{{ locationTitle }}</span>
      </div>
    </div>

    <div class="mt-4 flex items-center gap-2">
      <div class="flex gap-0.5" role="img" :aria-label="t('saya.reviews.stars_aria', { rating: review.rating })">
        <TenantIcon
          v-for="s in 5"
          :key="s"
          name="star"
          solid
          aria-hidden="true"
          class="size-3.5"
          :class="s <= review.rating ? 'text-primary' : 'text-muted'"
        />
      </div>
      <span v-if="dateLabel" class="text-xs text-muted">{{ dateLabel }}</span>
    </div>

    <p v-if="review.title" class="tenant-display tenant-italic mt-4 text-2xl leading-tight text-default">{{ review.title }}</p>
    <p class="mt-3 text-sm leading-relaxed text-default">{{ review.content }}</p>

    <div v-if="review.owner_reply" class="mt-5 rounded-xl border-l-4 border-primary bg-default p-5">
      <p class="mb-2 text-xs text-muted">{{ t('saya.reviews_page.owner_response') }}<template v-if="review.owner_reply_at"> · {{ formatDate(review.owner_reply_at) }}</template></p>
      <p class="text-sm leading-relaxed text-default">{{ review.owner_reply }}</p>
    </div>

    <slot />
  </article>
</template>

<script setup lang="ts">
import type { GoogleReviewMetadata } from '~/shared/google-review'
const { t } = useI18n()
const { formatDate } = useLocaleDate()

/** The one review card. It takes a review row as the reviews API and the product payload carry it. */
const props = defineProps<{
  review: {
    id: string | number
    author_name: string | null
    rating: number
    content: string | null
    title?: string | null
    source?: string | null
    google_review_metadata?: GoogleReviewMetadata | null
    /** When an imported review was written; a Google review is dated by this. */
    original_review_date?: string | null
    /** When the row was written here; a review written on the organization's own pages is dated by this. */
    created_at?: string | null
    owner_reply?: string | null
    owner_reply_at?: string | null
    media?: Array<{ slot: string; public_url?: string | null }>
  }
  /** Named when the organization has several locations and the reader needs to know which one this is about. */
  locationTitle?: string | null
}>()

const author = computed(() => props.review.author_name ?? '')
/** A Google author is attributed by linking their name to their Google profile. */
const authorHref = computed(() => props.review.google_review_metadata?.author_uri ?? null)
/** A Google review is dated by its Google publish time, one written here by its row. No date, no date line. */
const dateLabel = computed(() => {
  const writtenAt = props.review.source === 'google_places' ? props.review.original_review_date : props.review.created_at
  return writtenAt ? formatDate(writtenAt) : null
})
const portrait = computed(() =>
  props.review.media?.find(item => item.slot === 'portrait')?.public_url ?? props.review.google_review_metadata?.author_photo_uri ?? null,
)
</script>
