<template>
  <DashboardLeafPanel
    id="organization-website-reviews"
    title="Review settings"
    :saving="saving"
    :disabled="false"
    :error="pageError || (reviewsError ? getErrorMessage(reviewsError, 'Failed to load reviews') : '')"
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
            <div class="flex items-center gap-2">
              <h3 class="font-semibold text-highlighted text-base">
                Manual review
              </h3>
              <span class="rounded-full bg-accented px-2 py-0.5 text-xs font-medium text-highlighted">Recommended</span>
            </div>
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
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const orgSlug = computed(() => String(route.params.org_slug))
const organizationId = useDashboardOrganizationId()
const dashboardApi = useDashboardApi()

const preferencesPath = computed(() => `/dashboard/${orgSlug.value}/website/preferences`)
const reviewsPath = computed(() => `/dashboard/${orgSlug.value}/website/reviews`)

const approvalMode = ref<'manual' | 'auto'>('manual')
const saving = ref(false)
const pageError = ref<string | null>(null)

const isReviewsResponse = (value: unknown): value is { reviews: Array<{ id: string; status: string }> } =>
  isRecord(value) && Array.isArray(value.reviews)

const { data: reviewsData, error: reviewsError } = await useAsyncData(
  `dashboard-org-reviews-count-${organizationId}`,
  () => dashboardApi<{ reviews: Array<{ id: string; status: string }> }>(
    `/api/editor/organizations/${organizationId}/reviews`,
    { validate: isReviewsResponse },
  ),
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
</script>
