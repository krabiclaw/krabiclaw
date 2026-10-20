<template>
  <div class="min-h-screen bg-default text-default">
    <section class="mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:px-8">
      <NuxtLink :to="localePath(`/locations/${slug}/reviews`)" class="tenant-kicker text-muted no-underline hover:text-default">
        Back to reviews
      </NuxtLink>

      <div v-if="pending" class="mt-12 rounded-lg border border-default p-8">
        <div class="h-6 w-48 animate-pulse rounded bg-elevated" />
        <div class="mt-5 h-32 animate-pulse rounded bg-elevated" />
      </div>

      <div v-else-if="!review" class="mt-12 rounded-lg border border-default p-8">
        <h1 class="text-2xl font-semibold">Review not found</h1>
      </div>

      <TenantReviewCard v-else :review="review" class="mt-12">
        <div v-if="mediaItems.length" class="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <button
            v-for="(item, index) in mediaItems"
            :key="item.id || index"
            type="button"
            class="aspect-square overflow-hidden rounded-lg bg-elevated"
            @click="openLightbox(index)"
          >
            <img :src="item.thumbnail_url || item.public_url" :alt="item.alt_text || ''" class="h-full w-full object-cover">
          </button>
        </div>

        <div class="mt-6 flex flex-wrap items-center gap-3">
          <TenantButton variant="soft" @click="markHelpful">
            Helpful / {{ helpfulCount }}
          </TenantButton>
          <TenantButton variant="outline" @click="shareReview">
            Share
          </TenantButton>
        </div>
      </TenantReviewCard>
    </section>

    <MediaLightbox v-model:open="lightboxOpen" v-model:index="lightboxIndex" :items="lightboxItems" :title="review?.title || 'Review media'" />
  </div>
</template>

<script setup lang="ts">
const { localePath } = useI18n()
definePageMeta({ layout: 'tenant' })

const route = useRoute()
const requestEvent = useRequestEvent()
const { organization } = useTenantOrganization()
const { id: organizationId } = organization
const slug = computed(() => String(route.params.slug))
const reviewId = computed(() => String(route.params.reviewId))

const { data: review, pending, error } = await useAsyncData<ApiRecord>(
  () => `review-${slug.value}-${reviewId.value}`,
  async () => {
    // Fetch directly against the real request's D1 binding instead of doing a nested
    // self-fetch back to our own API — Nitro's internal dispatch doesn't reliably
    // reproduce the same route-param/binding resolution as a real external request,
    // which caused pages/blog/[category]/[slug].vue and pages/docs/[...segments].vue
    // to 404/500 on records their own API served correctly. Same fix applied here.
    if (import.meta.server) {
      if (!requestEvent) throw createError({ statusCode: 500, statusMessage: 'Request event not available' })

      const [{ cloudflareEnv }, { getPublicReview }] = await Promise.all([
        import('~/server/utils/api-response'),
        import('~/server/utils/review-management'),
      ])
      const db = cloudflareEnv(requestEvent).db
      if (!db) throw createError({ statusCode: 500, statusMessage: 'Database not available' })

      const result = await getPublicReview(db, String(organizationId), slug.value, reviewId.value) as ApiRecord | null
      if (!result) throw createError({ statusCode: 404, statusMessage: 'Review not found' })
      return result
    }

    const endpoint = `/api/public/locations/${slug.value}/reviews/${reviewId.value}`
    const response = await publicApiRequest<{ review: ApiRecord }>(endpoint, {
      validate: (value): value is { review: ApiRecord } =>
        isRecord(value) && isRecord(value.review),
    })
    return response.review
  },
  { watch: [slug, reviewId] },
)
if (error.value) throw error.value
const helpfulCount = ref(0)
watchEffect(() => {
  helpfulCount.value = Number(review.value?.helpful_count ?? 0)
})

const mediaItems = computed(() => ((review.value?.media as ApiRecord[] | undefined) ?? []).filter((item) => item.public_url))
const lightboxOpen = ref(false)
const lightboxIndex = ref(0)
const lightboxItems = computed(() => mediaItems.value.map((item) => ({
  url: String(item.public_url),
  kind: (item.kind === 'video' ? 'video' : 'image') as 'image' | 'video',
  alt: String(item.alt_text || ''),
})))

function openLightbox(index: number) {
  lightboxIndex.value = index
  lightboxOpen.value = true
}

async function markHelpful() {
  const result = await publicApiMutation<{ helpful: boolean; helpfulCount: number }>(
    `/api/public/locations/${slug.value}/reviews/${reviewId.value}/helpful`,
    {
      method: 'POST',
      validate: (value): value is { helpful: boolean; helpfulCount: number } =>
        isRecord(value)
        && typeof value.helpful === 'boolean'
        && typeof value.helpfulCount === 'number',
    },
  )
  helpfulCount.value = result.helpfulCount
}

async function shareReview() {
  if (!import.meta.client) return
  const url = window.location.href
  if (navigator.share) {
    await navigator.share({ title: String(review.value?.title || 'Review'), url }).catch(() => undefined)
    return
  }
  await navigator.clipboard?.writeText(url)
}

useSocialMetadata(() => ({
  path: `/locations/${slug.value}/reviews/${reviewId.value}`,
  title: review.value ? `${review.value.rating}-star review from ${review.value.author_name}` : 'Review',
  description: String(review.value?.content || '').slice(0, 150),
  socialImage: review.value?.social_image ?? null,
  breadcrumbs: [
    { name: 'Locations', url: '/locations' },
    { name: String(review.value?.location_title || slug.value), url: `/locations/${slug.value}` },
    { name: 'Reviews', url: `/locations/${slug.value}/reviews` },
    { name: review.value ? `${review.value.rating}★ Review` : 'Review', url: `/locations/${slug.value}/reviews/${reviewId.value}` },
  ],
}))

useSchemaOrg([
  computed(() => {
    if (!review.value) return {}
    return {
      '@type': 'Review',
      author: { '@type': 'Person', name: review.value.author_name },
      reviewRating: { '@type': 'Rating', ratingValue: review.value.rating, bestRating: 5 },
      reviewBody: review.value.content,
      itemReviewed: {
        '@type': getBusinessSchemaTypes((organization as ApiValue)?.vertical),
        name: review.value.organization_name,
      },
    }
  }),
])
</script>
