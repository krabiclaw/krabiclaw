<template>
  <div class="min-h-screen bg-default text-default">
    <section class="tenant-container max-w-2xl py-16">
      <div v-if="validationStatus === 'idle' || validationStatus === 'pending'" class="rounded-lg border border-default p-8">
        <div class="h-5 w-40 animate-pulse rounded bg-elevated" />
        <div class="mt-4 h-20 animate-pulse rounded bg-elevated" />
      </div>

      <div v-else-if="loadError" class="rounded-lg border border-default p-8">
        <h1 class="text-2xl font-semibold">This review link is not available</h1>
        <p class="mt-3 text-sm text-muted">{{ loadError }}</p>
      </div>

      <div v-else-if="optedOut" class="rounded-lg border border-default p-8">
        <h1 class="text-2xl font-semibold">You are opted out</h1>
        <p class="mt-3 text-sm text-muted">You will not receive more review request emails.</p>
      </div>

      <template v-else-if="requestData">
        <p class="tenant-eyebrow text-muted">{{ requestData.organization.name }}</p>
        <h1 class="mt-3 text-3xl font-semibold">{{ submitted ? 'Thank you' : 'How was your visit?' }}</h1>
        <p v-if="!submitted" class="mt-3 text-sm text-muted">{{ [requestData.visit.title, requestData.visit.at].filter(Boolean).join(' · ') }}</p>

        <!-- Ratings, then the public review, then what only the business reads, then the confirmation: one step at a time. -->
        <UStepper ref="stepper" v-model="step" :items="steps" :linear="true" disabled class="mt-10" data-testid="review-steps">
          <template #ratings>
            <div class="space-y-8 pt-8">
              <div>
                <p id="overall-rating-label" class="text-base font-semibold text-highlighted">Overall</p>
                <UInputRating v-model="rating" size="xl" class="mt-3" aria-labelledby="overall-rating-label" data-testid="review-overall-rating">
                  <template #item="{ filled }"><TenantIcon name="star" :solid="filled" class="block size-full" :class="filled ? '' : 'text-muted'" /></template>
                </UInputRating>
              </div>
              <div class="space-y-5 border-t border-default pt-6">
                <p class="text-sm text-muted">Rate any of these you’d like to. You can skip them.</p>
                <div v-for="question in requestData.questions" :key="question.key" class="flex flex-wrap items-center justify-between gap-3">
                  <p :id="`rating-${question.key}`" class="text-sm font-medium text-highlighted">{{ question.label }}</p>
                  <UInputRating v-model="categories[question.key]" clearable :aria-labelledby="`rating-${question.key}`" :data-testid="`review-category-${question.key}`">
                    <!-- A chosen star is solid, as on the site's review cards: color alone does not show it on every theme. -->
                    <template #item="{ filled }"><TenantIcon name="star" :solid="filled" class="block size-full" :class="filled ? '' : 'text-muted'" /></template>
                  </UInputRating>
                </div>
              </div>
            </div>
          </template>

          <template #public>
            <div class="space-y-6 pt-8">
              <USwitch v-model="publish" label="Share a public review" :description="`${requestData.organization.name} may show it on its website once they’ve checked it.`" data-testid="review-publish" />
              <template v-if="publish">
                <UFormField label="Show my name as">
                  <URadioGroup v-model="displayName" :items="requestData.displayNames" />
                </UFormField>
                <UFormField label="Title" hint="Optional">
                  <UInput v-model="title" maxlength="120" class="w-full" />
                </UFormField>
                <UFormField label="Your review" :hint="`${content.trim().length}/2000`">
                  <UTextarea v-model="content" :rows="6" maxlength="2000" class="w-full" data-testid="review-content" />
                </UFormField>
                <div>
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
                    <UButton color="neutral" variant="outline" :label="uploadingMedia ? 'Uploading…' : 'Add media'" :disabled="uploadingMedia || removingMediaAssetId !== null" @click="mediaInput?.click()" />
                    <div v-for="item in media" :key="item.asset_id" class="relative h-20 w-20 overflow-hidden rounded-lg border border-default bg-elevated">
                      <img v-if="item.preview_url && item.kind === 'image'" :src="item.preview_url" alt="" class="h-full w-full object-cover">
                      <div v-else class="flex h-full w-full items-center justify-center text-xs text-muted">Video</div>
                      <UButton class="absolute right-1 top-1" size="xs" color="neutral" icon="i-lucide-x" :disabled="removingMediaAssetId !== null" :aria-label="removingMediaAssetId === item.asset_id ? 'Removing media' : 'Remove media'" @click="removeMedia(item.asset_id)" />
                    </div>
                  </div>
                  <p v-if="mediaError" class="mt-3 text-sm text-error">{{ mediaError }}</p>
                </div>
              </template>
            </div>
          </template>

          <template #private>
            <div class="space-y-4 pt-8">
              <UFormField label="Anything you’d like to tell the team privately?" :description="`Only ${requestData.organization.name} reads this. It is never published.`" hint="Optional">
                <UTextarea v-model="privateFeedback" :rows="6" maxlength="2000" class="w-full" data-testid="review-private-feedback" />
              </UFormField>
            </div>
          </template>

          <template #done>
            <div class="space-y-6 pt-8" data-testid="review-confirmation">
              <p class="text-sm text-muted">
                <template v-if="publish">Your review is with {{ requestData.organization.name }}. It appears on their website once they’ve checked it.</template>
                <template v-else>Your feedback went to {{ requestData.organization.name }} only. Nothing was published.</template>
              </p>
              <UButton v-if="publish && requestData.location.googleReviewUrl" :label="copyButtonLabel" @click="copyAndOpenGoogle" />
              <GuestAccountPrompt />
            </div>
          </template>
        </UStepper>

        <UAlert v-if="submitError" class="mt-6" color="error" variant="soft" :description="submitError" />

        <div v-if="!submitted" class="mt-8 flex flex-wrap items-center justify-between gap-3">
          <UButton v-if="step !== 'ratings'" label="Back" color="neutral" variant="ghost" :disabled="submitting" @click="stepper?.prev()" />
          <UButton v-else label="Opt out of review emails" color="neutral" variant="link" @click="optOut" />
          <UButton v-if="step !== 'private'" label="Next" :disabled="!stepValid" @click="next" />
          <UButton v-else label="Submit" :loading="submitting" :disabled="removingMediaAssetId !== null" @click="submitReview" />
        </div>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import GuestAccountPrompt from '~/components/booking/GuestAccountPrompt.vue'
import { $fetch } from 'ofetch'
import { REVIEW_VIDEO_MAX_BYTES, REVIEW_VIDEO_MAX_LABEL } from '~/config/media-limits'

definePageMeta({ layout: 'tenant' })

const route = useRoute()
const token = computed(() => String(route.query.token || ''))

type Step = 'ratings' | 'public' | 'private' | 'done'
const steps: Array<{ value: Step; slot: Step; title: string }> = [
  { value: 'ratings', slot: 'ratings', title: 'Ratings' },
  { value: 'public', slot: 'public', title: 'Public review' },
  { value: 'private', slot: 'private', title: 'Private feedback' },
  { value: 'done', slot: 'done', title: 'Done' },
]
const step = ref<Step>('ratings')
const stepper = useTemplateRef<{ next: () => void; prev: () => void }>('stepper')

// The overall rating is asked for explicitly; nothing is preselected.
const rating = ref(0)
const categories = reactive<Record<string, number | undefined>>({})
const publish = ref(false)
const displayName = ref('')
const title = ref('')
const content = ref('')
const privateFeedback = ref('')
const submitting = ref(false)
const submitted = computed(() => step.value === 'done')
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

const { data: requestData, status: validationStatus, error: validationError } = await useAsyncData<{
  request: { id: string; bookingType: string; expiresAt: string }
  organization: { id: string; name: string }
  visit: { subject: string; title: string | null; at: string; locationTitle: string | null }
  questions: Array<{ key: string; label: string }>
  location: { googleReviewUrl: string | null }
  displayNames: string[]
}>(() => `review-request-validation-${token.value}`, () =>
  $fetch('/api/public/review-requests/validate', { query: { token: token.value } }),
// The link is the guest's private credential: it is read in their browser, as
// a booking-change link is, never during the server render.
{ server: false })
const loadError = computed(() => validationError.value ? 'The link may have expired or already been used.' : '')
watch(requestData, (data) => { if (data && !displayName.value) displayName.value = data.displayNames[0] ?? '' }, { immediate: true })

// Each step asks only for what it needs: an overall rating, then — if the guest shares one — the public text.
const stepValid = computed(() => step.value === 'ratings'
  ? rating.value >= 1
  : step.value === 'public'
    ? !publish.value || (content.value.trim().length >= 10 && Boolean(displayName.value) && !uploadingMedia.value)
    : true)

async function next() {
  submitError.value = ''
  // Media belongs to the public review; turning it off removes what was uploaded for it.
  if (step.value === 'public' && !publish.value) {
    for (const item of [...media.value]) await removeMedia(item.asset_id)
    if (media.value.length) return
    title.value = ''
    content.value = ''
  }
  stepper.value?.next()
}

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
  submitting.value = true
  try {
    const status = publish.value ? 'pending' : 'private'
    await publicApiMutation<{ success: true; reviewId: string; status: 'pending' | 'private' }>('/api/public/review-requests/submit', {
      method: 'POST',
      body: {
        token: token.value,
        rating: rating.value,
        // A question the guest skipped is left out, never sent as a score.
        categories: Object.fromEntries(Object.entries(categories).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] >= 1)),
        publish: publish.value,
        ...(publish.value ? { displayName: displayName.value, title: title.value, content: content.value } : {}),
        privateFeedback: privateFeedback.value,
      },
      validate: (value): value is { success: true; reviewId: string; status: 'pending' | 'private' } =>
        isRecord(value)
        && value.success === true
        && typeof value.reviewId === 'string'
        && value.status === status,
    })
    stepper.value?.next()
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
  path: '/review-submit',
  title: 'Leave a review',
  description: `Review your visit to ${requestData.value?.organization.name || 'this business'}.`,
  socialImage: null,
  discoverability: 'private',
}))
useHead({ meta: [{ name: 'referrer', content: 'no-referrer' }] })
</script>
