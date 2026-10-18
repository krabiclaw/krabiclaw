<template>
  <div class="min-h-screen bg-default text-default">
    <section class="mx-auto max-w-2xl px-4 py-16 sm:px-6 lg:px-8">
      <NuxtLink :to="localePath(`/locations/${slug}`)" class="saya-kicker text-muted no-underline hover:text-default">
        Back to {{ requestData?.location?.title || 'location' }}
      </NuxtLink>

      <div v-if="pending" class="mt-12 rounded-lg border border-default p-8">
        <div class="h-5 w-40 animate-pulse rounded bg-elevated" />
        <div class="mt-4 h-20 animate-pulse rounded bg-elevated" />
      </div>

      <div v-else-if="loadError" class="mt-12 rounded-lg border border-default p-8">
        <h1 class="text-2xl font-semibold">This review link is not available</h1>
        <p class="mt-3 text-sm text-muted">{{ loadError }}</p>
      </div>

      <div v-else-if="optedOut" class="mt-12 rounded-lg border border-default p-8">
        <h1 class="text-2xl font-semibold">You are opted out</h1>
        <p class="mt-3 text-sm text-muted">You will not receive more review request emails.</p>
      </div>

      <div v-else-if="submitted" class="mt-12 rounded-lg border border-default p-8">
        <h1 class="text-3xl font-semibold">Thank you</h1>
        <p class="mt-3 text-sm text-muted">Your review is pending moderation.</p>
        <div class="mt-8 flex flex-wrap gap-3">
          <button v-if="requestData?.location?.googleReviewUrl" type="button" class="inline-flex items-center justify-center gap-2 rounded-full bg-primary px-6 py-3 text-sm font-medium text-on-primary no-underline transition hover:opacity-90" @click="copyAndOpenGoogle">
            {{ copyButtonLabel }}
          </button>
        </div>
        <GuestAccountPrompt class="mt-8" />
      </div>

      <form v-else class="mt-12 rounded-lg border border-default p-8" @submit.prevent="submitReview">
        <p class="saya-eyebrow text-muted">{{ requestData?.organization?.name }}</p>
        <h1 class="mt-3 text-3xl font-semibold">How was your visit?</h1>
        <p class="mt-3 text-sm text-muted">{{ requestData?.location?.title }}</p>

        <div class="mt-8">
          <label class="text-sm font-medium">Rating</label>
          <div class="mt-3 flex gap-2">
            <button
              v-for="star in 5"
              :key="star"
              type="button"
              class="rounded-full p-2 transition hover:bg-elevated"
              :aria-label="`${star} star${star === 1 ? '' : 's'}`"
              @click="rating = star"
            >
              <TenantIcon name="star" solid class="size-8" :class="star <= rating ? 'text-primary' : 'text-muted'" />
            </button>
          </div>
        </div>

        <label class="mt-8 block text-sm font-medium">
          Title
          <input v-model="title" class="mt-2 w-full rounded-lg border border-default bg-default px-3 py-2 text-sm outline-none focus:border-primary" maxlength="120">
        </label>

        <label class="mt-6 block text-sm font-medium">
          Review
          <textarea v-model="content" class="mt-2 min-h-36 w-full rounded-lg border border-default bg-default px-3 py-2 text-sm outline-none focus:border-primary" maxlength="2000" required />
        </label>

        <div class="mt-6">
          <div class="flex items-center justify-between gap-3">
            <label class="text-sm font-medium" for="review-media">Photos and videos</label>
            <span class="text-xs text-muted">{{ imageCount }}/5 photos / {{ videoCount }}/2 videos</span>
          </div>
          <input
            id="review-media"
            ref="mediaInput"
            class="sr-only"
            type="file"
            accept="image/jpeg,image/png,image/webp,video/mp4,video/webm"
            multiple
            @change="handleMediaSelect"
          >
          <div class="mt-3 flex flex-wrap gap-3">
            <button type="button" class="rounded-lg border border-dashed border-default px-4 py-3 text-sm text-muted hover:border-primary hover:text-default" :disabled="uploadingMedia || removingMediaAssetId !== null" @click="mediaInput?.click()">
              {{ uploadingMedia ? 'Uploading...' : 'Add media' }}
            </button>
            <div
              v-for="item in media"
              :key="item.asset_id"
              class="relative h-20 w-20 overflow-hidden rounded-lg border border-default bg-elevated"
            >
              <img v-if="item.preview_url && item.kind === 'image'" :src="item.preview_url" alt="" class="h-full w-full object-cover">
              <div v-else class="flex h-full w-full items-center justify-center text-xs text-muted">Video</div>
              <button
                type="button"
                class="absolute right-1 top-1 rounded-full bg-default/90 px-1.5 text-xs disabled:cursor-wait disabled:opacity-60"
                :disabled="removingMediaAssetId !== null"
                :aria-label="removingMediaAssetId === item.asset_id ? 'Removing media' : 'Remove media'"
                @click="removeMedia(item.asset_id)"
              >x</button>
            </div>
          </div>
          <p v-if="mediaError" class="mt-3 text-sm text-error">{{ mediaError }}</p>
        </div>

        <p v-if="submitError" class="mt-4 text-sm text-error">{{ submitError }}</p>

        <div class="mt-8 flex flex-wrap items-center gap-3">
          <TenantButton type="submit" :disabled="submitting || removingMediaAssetId !== null">
            {{ submitting ? 'Submitting...' : 'Submit review' }}
          </TenantButton>
          <button type="button" class="text-sm text-muted underline-offset-4 hover:underline" @click="optOut">
            Opt out of review emails
          </button>
        </div>
      </form>
    </section>
  </div>
</template>

<script setup lang="ts">
import GuestAccountPrompt from '~/components/booking/GuestAccountPrompt.vue'
import { $fetch } from 'ofetch'
import { REVIEW_VIDEO_MAX_BYTES, REVIEW_VIDEO_MAX_LABEL } from '~/config/media-limits'

const { localePath } = useI18n()

definePageMeta({ layout: 'tenant' })

const route = useRoute()
const slug = computed(() => String(route.params.slug))
const token = computed(() => String(route.query.token || ''))

const rating = ref(5)
const title = ref('')
const content = ref('')
const submitting = ref(false)
const submitted = ref(false)
// Whether this browser holds the anonymous identity the review belongs to, so
// signing in here links it through Better Auth. Another browser cannot.
const optedOut = ref(false)
const submitError = ref('')
const copyButtonLabel = ref('Copy my review & post on Google Maps')
const mediaError = ref('')
const uploadingMedia = ref(false)
const removingMediaAssetId = ref<string | null>(null)
const mediaInput = ref<HTMLInputElement | null>(null)
const media = ref<Array<{ asset_id: string; kind: 'image' | 'video'; preview_url: string | null }>>([])
const activeVideoUploads = new Set<AbortController>()
const imageCount = computed(() => media.value.filter(item => item.kind === 'image').length)
const videoCount = computed(() => media.value.filter(item => item.kind === 'video').length)

const { data: requestData, pending, error: validationError } = await useAsyncData<{
  request: { id: string; bookingType: string; expiresAt: string }
  organization: { id: string; name: string | null }
  location: { id: string | null; slug: string | null; title: string | null; googleReviewUrl: string | null }
  customer: { name: string | null }
}>(() => `review-request-validation-${token.value}`, () =>
  $fetch('/api/public/review-requests/validate', { query: { token: token.value } }),
)
const loadError = computed(() => validationError.value ? 'The link may have expired or already been used.' : '')

onMounted(async () => {
  if (route.query.optOut === '1' || route.query.optOut === 'true') {
    await optOut()
  }
})

onBeforeUnmount(() => {
  for (const controller of activeVideoUploads) controller.abort()
  for (const item of media.value) {
    if (item.preview_url) URL.revokeObjectURL(item.preview_url)
  }
})

async function handleMediaSelect(event: Event) {
  mediaError.value = ''
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length || !requestData.value?.request?.id) return

  uploadingMedia.value = true
  try {
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        if (imageCount.value >= 5) throw new Error('You can upload up to 5 photos.')
        await uploadImage(file)
      } else if (file.type === 'video/mp4' || file.type === 'video/webm') {
        if (videoCount.value >= 2) throw new Error('You can upload up to 2 videos.')
        await uploadVideo(file)
      } else {
        throw new Error('Use JPG, PNG, WebP, MP4, or WebM files.')
      }
    }
  } catch (error) {
    mediaError.value = error instanceof Error ? error.message : 'Could not upload media.'
  } finally {
    uploadingMedia.value = false
  }
}

async function uploadImage(file: File) {
  const requestId = requestData.value?.request?.id
  if (!requestId) return
  const form = new FormData()
  form.append('image', file)
  const uploaded = await postReviewMedia(requestId, form, 'image')
  media.value.push({ asset_id: uploaded.asset_id, kind: 'image', preview_url: URL.createObjectURL(file) })
}

async function uploadVideo(file: File) {
  const requestId = requestData.value?.request?.id
  if (!requestId) return
  if (file.size > REVIEW_VIDEO_MAX_BYTES) throw new Error(`Videos must be ${REVIEW_VIDEO_MAX_LABEL} or smaller.`)

  const controller = new AbortController()
  activeVideoUploads.add(controller)
  try {
    const poster = await generateVideoThumbnail(file)
    const form = new FormData()
    form.append('video', file)
    form.append('thumbnail', poster)
    const uploaded = await postReviewMedia(requestId, form, 'video', controller.signal)
    media.value.push({ asset_id: uploaded.asset_id, kind: 'video', preview_url: uploaded.thumbnail_url })
  } finally {
    activeVideoUploads.delete(controller)
  }
}

// Photos and videos share one upload route. The asset is active and placed on
// the review request when this returns; a response that names an asset but
// breaks the contract is discarded so nothing is left attached.
async function postReviewMedia(requestId: string, form: FormData, kind: 'image' | 'video', signal?: AbortSignal) {
  let assetId: string | null = null
  try {
    const response = await fetch(`/api/public/review-requests/${encodeURIComponent(requestId)}/media/upload`, {
      method: 'POST',
      headers: { 'x-review-token': token.value },
      body: form,
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      signal,
    })

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw normalizeApiError({
        statusCode: 502,
        message: 'API response did not match its contract',
        response,
        data: {},
        cause: error,
      })
    }

    if (!response.ok) {
      throw normalizeApiError({ statusCode: response.status, response, data: payload })
    }
    if (isRecord(payload) && typeof payload.asset_id === 'string') assetId = payload.asset_id
    if (
      !isRecord(payload)
      || typeof payload.asset_id !== 'string'
      || typeof payload.public_url !== 'string'
      || (kind === 'video' ? typeof payload.thumbnail_url !== 'string' : !(payload.thumbnail_url === null || typeof payload.thumbnail_url === 'string'))
      || payload.kind !== kind
      || payload.status !== 'active'
    ) {
      throw normalizeApiError({
        statusCode: 502,
        message: 'API response did not match its contract',
        response,
        data: isRecord(payload) ? payload : {},
      })
    }
    return { asset_id: payload.asset_id, thumbnail_url: payload.thumbnail_url as string | null }
  } catch (error) {
    if (assetId) {
      try {
        await discardReviewMedia(requestId, assetId)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `${kind === 'image' ? 'Photo' : 'Video'} upload and cleanup failed.`, { cause: cleanupError })
      }
    }
    throw normalizeApiError(error, `${kind === 'image' ? 'Photo' : 'Video'} upload failed.`)
  }
}

async function removeMedia(assetId: string) {
  if (removingMediaAssetId.value) return
  const requestId = requestData.value?.request?.id
  const item = media.value.find(entry => entry.asset_id === assetId)
  if (!requestId || !item) return

  mediaError.value = ''
  removingMediaAssetId.value = assetId
  try {
    await discardReviewMedia(requestId, assetId)

    if (item.preview_url) URL.revokeObjectURL(item.preview_url)
    media.value = media.value.filter(entry => entry.asset_id !== assetId)
  } catch (error) {
    mediaError.value = error instanceof Error
      ? error.message
      : 'Could not remove this media. Please try again.'
  } finally {
    removingMediaAssetId.value = null
  }
}

function discardReviewMedia(requestId: string, assetId: string) {
  return publicApiMutation<{ deleted: true; asset_id: string }>(
    `/api/public/review-requests/${encodeURIComponent(requestId)}/media/${encodeURIComponent(assetId)}`,
    {
      method: 'DELETE',
      body: { token: token.value },
      validate: (value): value is { deleted: true; asset_id: string } =>
        isRecord(value) && value.deleted === true && value.asset_id === assetId,
    },
  )
}

async function submitReview() {
  submitError.value = ''
  if (removingMediaAssetId.value) {
    submitError.value = 'Wait for the media removal to finish before submitting.'
    return
  }
  if (content.value.trim().length < 10) {
    submitError.value = 'Review text must be at least 10 characters.'
    return
  }
  submitting.value = true
  try {
    await publicApiMutation<{ success: true; reviewId: string; status: 'pending' }>('/api/public/review-requests/submit', {
      method: 'POST',
      body: {
        token: token.value,
        rating: rating.value,
        title: title.value,
        content: content.value,
      },
      validate: (value): value is { success: true; reviewId: string; status: 'pending' } =>
        isRecord(value)
        && value.success === true
        && typeof value.reviewId === 'string'
        && value.status === 'pending',
    })
    submitted.value = true
  } catch (error) {
    submitError.value = (error as { data?: { error?: string } })?.data?.error || 'Could not submit your review.'
  } finally {
    submitting.value = false
  }
}

async function copyAndOpenGoogle() {
  const googleUrl = requestData.value?.location?.googleReviewUrl
  if (!googleUrl) return

  // The new tab must open inside the click; a popup blocker refuses one that
  // opens after the clipboard promise settles. Copy afterwards.
  window.open(googleUrl, '_blank', 'noopener')
  const reviewText = [title.value, content.value].filter(Boolean).join('\n\n')
  if (!reviewText || !navigator.clipboard?.writeText) return
  try {
    await navigator.clipboard.writeText(reviewText)
    copyButtonLabel.value = 'Copied! Google Maps is open in a new tab'
  } catch {
    copyButtonLabel.value = 'Could not copy — Google Maps is open in a new tab'
  }
}

async function optOut() {
  submitError.value = ''
  try {
    await publicApiMutation<{ optedOut: true }>('/api/public/review-requests/opt-out', {
      method: 'POST',
      body: { token: token.value },
      validate: (value): value is { optedOut: true } =>
        isRecord(value) && value.optedOut === true,
    })
    optedOut.value = true
  } catch (error) {
    submitError.value = (error as { data?: { error?: string } })?.data?.error || 'Could not opt out.'
  }
}

useSocialMetadata(() => ({
  path: `/locations/${slug.value}/review-submit`,
  title: 'Leave a review',
  description: `Submit a review for ${requestData.value?.location?.title || 'this location'}.`,
  socialImage: null,
  discoverability: 'private',
}))
</script>
