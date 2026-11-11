<template>
  <DashboardLeafPanel
    id="organization-website-reviews"
    title="Review settings"
    :saving="saving"
    :disabled="false"
    :error="pageError ?? ''"
    @cancel="navigateTo(preferencesPath)"
    @save="saveSettings"
  >
    <!-- Review Approval Mode Selection Cards (Airbnb Parity) -->
    <div class="space-y-4" role="radiogroup" aria-label="Review settings">
      <!-- Option 1: Manual review (Recommended) -->
      <button
        type="button"
        role="radio"
        :aria-checked="approvalMode === 'manual'"
        data-testid="review-mode-manual"
        class="w-full text-left rounded-2xl p-5 border-2 transition-all cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlighted"
        :class="approvalMode === 'manual'
          ? 'border-highlighted bg-elevated shadow-sm ring-1 ring-highlighted/10'
          : 'border-default bg-default hover:border-accented'"
        @click="approvalMode = 'manual'"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="space-y-1">
            <h3 class="font-semibold text-highlighted text-base">
              Manual approval (Recommended)
            </h3>
            <p class="text-sm text-muted">
              Incoming reviews require your approval before appearing on your website.
            </p>
          </div>
          <div
            class="size-5 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5"
            :class="approvalMode === 'manual' ? 'border-highlighted' : 'border-default'"
          >
            <div v-if="approvalMode === 'manual'" class="size-2.5 rounded-full bg-highlighted" />
          </div>
        </div>

        <div class="mt-4 flex items-center gap-2 rounded-xl bg-accented px-3.5 py-2.5 text-xs text-muted">
          <UIcon name="i-lucide-shield-check" class="size-4 shrink-0 text-highlighted" />
          <span>Protects your reputation and gives you full control over published testimonials.</span>
        </div>
      </button>

      <!-- Option 2: Automatic publishing -->
      <button
        type="button"
        role="radio"
        :aria-checked="approvalMode === 'auto'"
        data-testid="review-mode-auto"
        class="w-full text-left rounded-2xl p-5 border-2 transition-all cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlighted"
        :class="approvalMode === 'auto'
          ? 'border-highlighted bg-elevated shadow-sm ring-1 ring-highlighted/10'
          : 'border-default bg-default hover:border-accented'"
        @click="approvalMode = 'auto'"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="space-y-1">
            <h3 class="font-semibold text-highlighted text-base">
              Automatic publishing
            </h3>
            <p class="text-sm text-muted">
              Verified guest and Google reviews appear immediately on your website upon submission.
            </p>
          </div>
          <div
            class="size-5 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5"
            :class="approvalMode === 'auto' ? 'border-highlighted' : 'border-default'"
          >
            <div v-if="approvalMode === 'auto'" class="size-2.5 rounded-full bg-highlighted" />
          </div>
        </div>
      </button>
    </div>

    <!-- Manual Client Testimonial / Review Entry -->
    <div class="mt-8 border-t border-default pt-6">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h3 class="font-semibold text-base text-highlighted">
            Client testimonials
          </h3>
          <p class="text-xs sm:text-sm text-muted">
            Add reviews received in person, by email, or from letters directly to your website.
          </p>
        </div>
      </div>

      <button
        type="button"
        class="inline-flex items-center gap-2 px-4 py-2.5 rounded-full border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-sm font-semibold text-highlighted hover:border-neutral-900 dark:hover:border-white transition cursor-pointer"
        data-testid="add-client-review-button"
        @click="isAddModalOpen = true"
      >
        <UIcon name="i-lucide-plus" class="size-4" />
        <span>Add a client review</span>
      </button>
    </div>

    <!-- Chevron Row: All Reviews Link -->
    <div class="mt-8 border-t border-default pt-6">
      <NuxtLink
        :to="reviewsPath"
        class="flex items-center justify-between p-4 rounded-2xl bg-default border border-default hover:bg-elevated transition group"
        data-testid="manage-reviews-link"
      >
        <div class="space-y-0.5">
          <div class="font-semibold text-sm sm:text-base text-highlighted transition">
            Manage published reviews
          </div>
          <div class="text-xs sm:text-sm text-muted">
            {{ reviewsSummaryText }}
          </div>
        </div>
        <UIcon name="i-lucide-chevron-right" class="size-5 text-muted group-hover:text-highlighted group-hover:translate-x-0.5 transition" />
      </NuxtLink>
    </div>

    <!-- Add Client Review Modal (Airbnb Parity) -->
    <UModal v-model:open="isAddModalOpen" :ui="{ content: 'divide-none max-w-lg p-6 sm:p-7 rounded-3xl shadow-2xl [&>*]:border-0' }">
      <template #content>
        <div class="space-y-5">
          <div class="flex items-center justify-between">
            <h3 class="text-lg sm:text-xl font-semibold text-highlighted">
              Add client review
            </h3>
            <UButton
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              square
              size="sm"
              aria-label="Close"
              @click="isAddModalOpen = false"
            />
          </div>

          <UAlert v-if="modalError" color="error" variant="soft" :description="modalError" />

          <div class="space-y-4">
            <!-- Author Name -->
            <div>
              <label class="block text-sm font-medium text-highlighted mb-1">
                Client or author name
              </label>
              <input
                v-model="newReview.author_name"
                type="text"
                placeholder="e.g. Sarah Jenkins"
                class="w-full px-3.5 py-2.5 rounded-xl border border-default bg-default text-highlighted text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                data-testid="new-review-author-name"
              />
            </div>

            <!-- Star Rating -->
            <div>
              <label class="block text-sm font-medium text-highlighted mb-1">
                Rating
              </label>
              <div class="flex items-center gap-2">
                <button
                  v-for="star in 5"
                  :key="star"
                  type="button"
                  class="p-1 text-2xl transition cursor-pointer select-none"
                  :class="star <= newReview.rating ? 'text-amber-400' : 'text-neutral-300 dark:text-neutral-700'"
                  @click="newReview.rating = star"
                >
                  ★
                </button>
                <span class="text-sm font-semibold text-highlighted ml-2">
                  {{ newReview.rating }} {{ newReview.rating === 1 ? 'star' : 'stars' }}
                </span>
              </div>
            </div>

            <!-- Title -->
            <div>
              <label class="block text-sm font-medium text-highlighted mb-1">
                Title (Optional)
              </label>
              <input
                v-model="newReview.title"
                type="text"
                placeholder="e.g. Exceptional counsel and quick resolution"
                class="w-full px-3.5 py-2.5 rounded-xl border border-default bg-default text-highlighted text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                data-testid="new-review-title"
              />
            </div>

            <!-- Content -->
            <div>
              <label class="block text-sm font-medium text-highlighted mb-1">
                Testimonial / Review
              </label>
              <textarea
                v-model="newReview.content"
                rows="4"
                placeholder="What did the client say about working with your business?"
                class="w-full px-3.5 py-2.5 rounded-xl border border-default bg-default text-highlighted text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-y"
                data-testid="new-review-content"
              />
            </div>

            <!-- Collection Method -->
            <div>
              <label class="block text-sm font-medium text-highlighted mb-1">
                Source / Collection method
              </label>
              <select
                v-model="newReview.collection_method"
                class="w-full px-3.5 py-2.5 rounded-xl border border-default bg-default text-highlighted text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="in_person">In person</option>
                <option value="email">Email</option>
                <option value="phone">Phone</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          <div class="flex items-center justify-end gap-3 pt-3">
            <UButton
              label="Cancel"
              color="neutral"
              variant="ghost"
              @click="isAddModalOpen = false"
            />
            <UButton
              label="Publish review"
              color="neutral"
              variant="solid"
              :loading="savingReview"
              :disabled="!newReview.author_name.trim()"
              data-testid="save-new-review-button"
              @click="submitNewReview"
            />
          </div>
        </div>
      </template>
    </UModal>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import type { OwnerReviewCollectionMethod } from '~/shared/organization-reviews'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const orgSlug = computed(() => String(route.params.orgSlug))
const dashboard = useDashboardOrganization()
const organizationId = useDashboardOrganizationId()
const dashboardApi = useDashboardApi()

const preferencesPath = computed(() => `/dashboard/${orgSlug.value}/website/preferences`)
const reviewsPath = computed(() => `/dashboard/${orgSlug.value}/website/reviews`)

const approvalMode = ref<'manual' | 'auto'>('manual')
const saving = ref(false)
const pageError = ref<string | null>(null)

// Add client review modal
const isAddModalOpen = ref(false)
const savingReview = ref(false)
const modalError = ref<string | null>(null)

const newReview = reactive({
  author_name: '',
  rating: 5,
  title: '',
  content: '',
  collection_method: 'in_person' as OwnerReviewCollectionMethod,
})

const isReviewsResponse = (value: unknown): value is { reviews: Array<{ id: string; status: string }> } =>
  isRecord(value) && Array.isArray(value.reviews)

const { data: reviewsData, refresh: refreshReviews } = await useAsyncData(
  `dashboard-org-reviews-count-${organizationId}`,
  () => dashboardApi<{ reviews: Array<{ id: string; status: string }> }>(
    `/api/editor/organizations/${organizationId}/reviews`,
    { validate: isReviewsResponse },
  ).catch(() => ({ reviews: [] })),
)

const reviewsSummaryText = computed(() => {
  const count = reviewsData.value?.reviews?.length ?? 0
  if (count === 0) return 'No reviews yet'
  if (count === 1) return '1 review recorded'
  return `${count} reviews recorded`
})

async function saveSettings() {
  saving.value = true
  pageError.value = null
  try {
    await navigateTo(preferencesPath.value)
  } catch (error) {
    pageError.value = getErrorMessage(error, 'Failed to save review settings')
  } finally {
    saving.value = false
  }
}

async function submitNewReview() {
  if (!newReview.author_name.trim()) return
  savingReview.value = true
  modalError.value = null
  try {
    await dashboardApi(`/api/editor/organizations/${organizationId}/reviews`, {
      method: 'POST',
      body: {
        author_name: newReview.author_name.trim(),
        rating: newReview.rating,
        title: newReview.title.trim() || null,
        content: newReview.content.trim() || null,
        collection_method: newReview.collection_method,
      },
      validate: isRecord,
    })
    isAddModalOpen.value = false
    newReview.author_name = ''
    newReview.rating = 5
    newReview.title = ''
    newReview.content = ''
    newReview.collection_method = 'in_person'
    await refreshReviews()
    await dashboard.refresh()
  } catch (error) {
    modalError.value = getErrorMessage(error, 'Failed to publish client review')
  } finally {
    savingReview.value = false
  }
}
</script>
