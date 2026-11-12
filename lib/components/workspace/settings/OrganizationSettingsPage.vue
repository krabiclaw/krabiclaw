<template>
  <!--
    Website is the site: its content lists, its Brand, and the settings a guest
    never sees, one flat list. Brand is what a guest sees, a list of settings
    one level below it. Preferences holds status, languages, domains, currency.
    Each setting is a leaf below its list.
  -->
  <DashboardIndexPanel :id="panelId" :title="navbarTitle" :auto-open="autoOpenDestination">
    <template v-if="surface === 'settings'" #right>
      <UButton
        icon="i-lucide-settings"
        color="neutral"
        variant="soft"
        square
        aria-label="Website preferences"
        :to="preferencesPath"
      />
    </template>
    <UAlert v-if="loadError" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="loadError" />
    <template v-else>
      <!-- Status card (Airbnb parity: flat #F7F7F7 background, no hover, no border, no shadow) -->
      <div v-if="surface === 'settings'" class="mb-4">
        <button
          type="button"
          class="w-full text-left rounded-3xl bg-[#F7F7F7] dark:bg-neutral-800 p-5 sm:p-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          data-testid="website-status-banner"
          @click="statusModalOpen = true"
        >
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2.5">
              <span class="size-2.5 rounded-full shrink-0" :class="statusDotClass" />
              <span class="text-base font-semibold text-highlighted">{{ statusLabel }}</span>
            </div>
            <UIcon name="i-lucide-chevron-right" class="size-5 text-muted shrink-0" />
          </div>
          <p class="mt-1 text-sm text-muted leading-relaxed">{{ statusDescription }}</p>
        </button>
      </div>

      <!-- Airbnb Parity: Featured Pages card with 3-image fan stack (white card with shadow, no border) -->
      <div v-if="surface === 'settings'" class="mb-6">
        <div
          class="group block w-full text-left rounded-3xl p-5 sm:p-6 bg-white dark:bg-neutral-900 shadow-[0_4px_24px_rgba(0,0,0,0.06)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.3)] hover:shadow-[0_6px_28px_rgba(0,0,0,0.09)] transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          tabindex="0"
          role="link"
          :aria-current="isPagesActive ? 'page' : undefined"
          data-testid="website-pages-featured-card"
          @click="navigateTo(pagesPath)"
          @keydown.enter="navigateTo(pagesPath)"
        >
          <div>
            <h2 class="text-base font-semibold text-highlighted">Pages</h2>
            <p class="mt-0.5 text-sm text-muted">{{ pagesSummary }}</p>
          </div>

          <!-- Image Fan Stack -->
          <div v-if="previewImages.length > 0" class="relative flex items-center justify-center h-44 sm:h-52 my-3 select-none">
            <!-- Left image -->
            <img
              v-if="previewImages.length >= 3"
              :src="previewImages[0]"
              alt=""
              class="absolute left-1/2 -translate-x-[115%] w-36 sm:w-44 h-28 sm:h-36 rounded-2xl object-cover shadow-md -rotate-6 opacity-90 transition-transform group-hover:-rotate-8 group-hover:-translate-x-[120%]"
              loading="lazy"
              decoding="async"
            />
            <!-- Right image -->
            <img
              v-if="previewImages.length >= 2"
              :src="previewImages.length >= 3 ? previewImages[2] : previewImages[1]"
              alt=""
              class="absolute left-1/2 translate-x-[15%] w-36 sm:w-44 h-28 sm:h-36 rounded-2xl object-cover shadow-md rotate-6 opacity-90 transition-transform group-hover:rotate-8 group-hover:translate-x-[20%]"
              loading="lazy"
              decoding="async"
            />
            <!-- Center image with badge -->
            <div class="relative w-40 sm:w-48 h-32 sm:h-40 rounded-2xl overflow-hidden shadow-xl border-2 border-white/20 z-10 transition-transform group-hover:scale-105">
              <img
                :src="previewImages.length >= 3 ? previewImages[1] : previewImages[0]"
                alt=""
                class="size-full object-cover"
                loading="lazy"
                decoding="async"
              />
              <span class="absolute top-2.5 left-2.5 bg-white/95 dark:bg-neutral-900/95 text-neutral-900 dark:text-neutral-100 shadow-sm text-xs font-semibold px-2.5 py-1 rounded-full">
                {{ pagesCount }} {{ pagesCount === 1 ? 'page' : 'pages' }}
              </span>
            </div>
          </div>
          <div v-else class="flex flex-col items-center justify-center h-40 my-3 rounded-2xl bg-[#F7F7F7] dark:bg-neutral-800 text-muted">
            <UIcon name="i-lucide-file-text" class="size-8 mb-1.5 opacity-60" />
            <span class="text-xs font-medium">{{ pagesCount }} {{ pagesCount === 1 ? 'page' : 'pages' }}</span>
          </div>

          <!-- Task note under images -->
          <div class="flex items-center gap-2 pt-2 text-sm font-medium text-highlighted">
            <span class="size-2 rounded-full shrink-0" :class="pageTasks.length ? 'bg-amber-500' : 'bg-emerald-500'" />
            <button
              type="button"
              class="hover:underline focus:outline-none cursor-pointer"
              data-testid="pages-task-button"
              @click.stop="pageTasksModalOpen = true"
            >
              {{ pagesTaskText }}
            </button>
          </div>
        </div>
      </div>

      <!-- Airbnb Parity: Featured Blog Card -->
      <div v-if="surface === 'settings'" class="mb-4">
        <div
          class="group block w-full text-left rounded-3xl p-5 sm:p-6 bg-white dark:bg-neutral-900 shadow-[0_4px_24px_rgba(0,0,0,0.06)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.3)] hover:shadow-[0_6px_28px_rgba(0,0,0,0.09)] transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          tabindex="0"
          role="link"
          :aria-current="isBlogActive ? 'page' : undefined"
          data-testid="website-blog-featured-card"
          @click="navigateTo(blogPath)"
          @keydown.enter="navigateTo(blogPath)"
        >
          <div class="flex items-center justify-between">
            <h2 class="text-base font-semibold text-highlighted">Blog</h2>
            <UIcon name="i-lucide-chevron-right" class="size-4 text-muted group-hover:text-highlighted transition" />
          </div>

          <div v-if="blogPreviewItems.length > 0" class="mt-4 space-y-3">
            <div
              v-for="article in blogPreviewItems"
              :key="article.id"
              class="flex items-center gap-3.5"
            >
              <span class="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[#F7F7F7] dark:bg-neutral-800">
                <img
                  v-if="article.cover?.thumbnail_url || article.cover?.public_url"
                  :src="article.cover.thumbnail_url || article.cover.public_url || undefined"
                  alt=""
                  class="size-full object-cover"
                  loading="lazy"
                  decoding="async"
                />
                <UIcon v-else name="i-lucide-newspaper" class="size-5 text-muted opacity-70" />
              </span>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium text-highlighted">{{ article.title }}</p>
                <p class="truncate text-xs text-muted mt-0.5">
                  {{ articleSubtitle(article) }}
                </p>
              </div>
            </div>

            <!-- + X more text if more than 3 -->
            <p v-if="blogRemainingCount > 0" class="pt-1 text-sm text-muted font-medium">
              + {{ blogRemainingCount }} more
            </p>
          </div>
          <div v-else class="mt-3 flex items-center gap-3 text-muted">
            <span class="flex size-12 shrink-0 items-center justify-center rounded-xl bg-[#F7F7F7] dark:bg-neutral-800">
              <UIcon name="i-lucide-newspaper" class="size-5 opacity-50" />
            </span>
            <p class="text-sm">No articles published yet</p>
          </div>
        </div>
      </div>

      <!-- Airbnb Parity: Featured Posts Card -->
      <div v-if="surface === 'settings'" class="mb-6">
        <div
          class="group block w-full text-left rounded-3xl p-5 sm:p-6 bg-white dark:bg-neutral-900 shadow-[0_4px_24px_rgba(0,0,0,0.06)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.3)] hover:shadow-[0_6px_28px_rgba(0,0,0,0.09)] transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          tabindex="0"
          role="link"
          :aria-current="isPostsActive ? 'page' : undefined"
          data-testid="website-posts-featured-card"
          @click="navigateTo(postsPath)"
          @keydown.enter="navigateTo(postsPath)"
        >
          <div class="flex items-center justify-between">
            <h2 class="text-base font-semibold text-highlighted">Posts</h2>
            <UIcon name="i-lucide-chevron-right" class="size-4 text-muted group-hover:text-highlighted transition" />
          </div>

          <div v-if="postPreviewItems.length > 0" class="mt-4 space-y-3">
            <div
              v-for="post in postPreviewItems"
              :key="post.id"
              class="flex items-center gap-3.5"
            >
              <span class="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[#F7F7F7] dark:bg-neutral-800">
                <img
                  v-if="post.cover_image_url"
                  :src="post.cover_image_url"
                  alt=""
                  class="size-full object-cover"
                  loading="lazy"
                  decoding="async"
                />
                <UIcon v-else name="i-lucide-megaphone" class="size-5 text-muted opacity-70" />
              </span>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium text-highlighted">{{ post.title }}</p>
                <p class="truncate text-xs text-muted mt-0.5">
                  {{ postSubtitle(post) }}
                </p>
              </div>
            </div>

            <!-- + X more text if more than 3 -->
            <p v-if="postRemainingCount > 0" class="pt-1 text-sm text-muted font-medium">
              + {{ postRemainingCount }} more
            </p>
          </div>
          <div v-else class="mt-3 flex items-center gap-3 text-muted">
            <span class="flex size-12 shrink-0 items-center justify-center rounded-xl bg-[#F7F7F7] dark:bg-neutral-800">
              <UIcon name="i-lucide-megaphone" class="size-5 opacity-50" />
            </span>
            <p class="text-sm">No social posts published yet</p>
          </div>
        </div>
      </div>

      <!-- Booking Settings Card (Airbnb Parity) -->
      <div v-if="surface === 'settings'" class="mb-6">
        <div
          class="block w-full text-left rounded-3xl p-6 bg-white dark:bg-neutral-900 shadow-[0_4px_24px_rgba(0,0,0,0.06)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.3)] hover:shadow-[0_6px_28px_rgba(0,0,0,0.09)] transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          :class="{ 'ring-2 ring-highlighted': isBookingActive }"
          tabindex="0"
          role="link"
          :aria-current="isBookingActive ? 'page' : undefined"
          data-testid="website-booking-card"
          @click="navigateTo(`${settingsPath}/booking`)"
          @keydown.enter="navigateTo(`${settingsPath}/booking`)"
        >
          <div class="flex items-center justify-between">
            <h2 class="text-xl font-bold text-highlighted tracking-tight">
              {{ bookingCardTitle }}
            </h2>
            <UIcon name="i-lucide-chevron-right" class="size-5 text-muted" />
          </div>

          <p class="mt-2 text-sm text-muted">
            {{ bookingCardSubtitle }}
          </p>
        </div>
      </div>


      <!-- Airbnb Parity: Brand Profile Header (media_1794368807915_664e9a97.jpg) -->
      <div v-if="surface === 'brand'" class="flex flex-col items-center pt-2 pb-6 text-center">
        <!-- Circular logo container with Edit button overlay -->
        <div class="relative size-36 sm:size-44 rounded-full p-1 bg-white dark:bg-neutral-900 shadow-[0_4px_24px_rgba(0,0,0,0.08)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.3)] select-none">
          <div class="relative size-full rounded-full overflow-hidden bg-[#F7F7F7] dark:bg-neutral-800 flex items-center justify-center">
            <img
              v-if="brandLogoUrl"
              :src="brandLogoUrl"
              :alt="brandName"
              class="size-full object-cover"
              loading="lazy"
              decoding="async"
            />
            <span v-else class="text-4xl font-bold text-muted">
              {{ brandInitial }}
            </span>
          </div>

          <!-- Edit button pill overlaid at bottom center -->
          <button
            type="button"
            class="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/4 flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-white dark:bg-neutral-900 shadow-md text-sm font-semibold text-highlighted border border-neutral-200 dark:border-neutral-700 hover:scale-105 active:scale-95 transition cursor-pointer z-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            data-testid="brand-logo-edit-button"
            @click="navigateTo(`${brandPath}/logo`)"
          >
            <UIcon name="i-lucide-camera" class="size-4 text-highlighted" />
            <span>Edit</span>
          </button>
        </div>
      </div>

      <EditorNavigationList :groups="navigationGroups" :active-item="detailKey" />

      <!-- Airbnb Parity: Featured Brand ("About the business") card -->
      <div v-if="surface === 'settings'" class="mt-6 mb-6">
        <div
          class="block w-full text-left rounded-3xl p-6 sm:p-7 bg-white dark:bg-neutral-900 shadow-[0_4px_24px_rgba(0,0,0,0.06)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.3)] hover:shadow-[0_6px_28px_rgba(0,0,0,0.09)] transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          tabindex="0"
          role="link"
          data-testid="website-brand-featured-card"
          @click="navigateTo(brandPath)"
          @keydown.enter="navigateTo(brandPath)"
        >
          <h2 class="text-xl sm:text-2xl font-bold text-highlighted tracking-tight">About the business</h2>

          <div class="mt-6 flex items-center justify-between gap-6 sm:gap-10">
            <!-- Left Column: Avatar + Brand name + Vertical -->
            <div class="flex flex-col items-center flex-1 min-w-0">
              <div class="relative size-24 sm:size-28 rounded-full overflow-hidden bg-[#F7F7F7] dark:bg-neutral-800 flex items-center justify-center shadow-md shrink-0">
                <img
                  v-if="brandLogoUrl"
                  :src="brandLogoUrl"
                  :alt="brandName"
                  class="size-full object-cover"
                  loading="lazy"
                  decoding="async"
                />
                <span v-else class="text-2xl font-bold text-muted">
                  {{ brandInitial }}
                </span>
              </div>
              <h3 class="mt-3 text-lg sm:text-xl font-bold text-highlighted text-center truncate max-w-full">
                {{ brandName }}
              </h3>
              <p class="text-sm text-muted text-center truncate max-w-full">
                {{ brandVerticalLabel }}
              </p>
            </div>

            <!-- Right Column: 3 metrics stacked with dividers -->
            <div class="flex flex-col justify-center flex-1 min-w-0 divide-y divide-neutral-200 dark:divide-neutral-800">
              <!-- Reviews count (clickable) -->
              <div
                class="pb-3 rounded-xl -mx-2 px-2 transition hover:bg-[#F7F7F7] dark:hover:bg-neutral-800/60 cursor-pointer"
                role="button"
                tabindex="0"
                aria-label="View reviews"
                @click.stop="navigateTo(reviewsPath)"
                @keydown.enter.stop="navigateTo(reviewsPath)"
              >
                <div class="text-xl sm:text-2xl font-bold text-highlighted">
                  {{ brandReviewsCount }}
                </div>
                <div class="text-xs text-muted font-medium">
                  Reviews
                </div>
              </div>

              <!-- Rating (clickable) -->
              <div
                class="py-3 rounded-xl -mx-2 px-2 transition hover:bg-[#F7F7F7] dark:hover:bg-neutral-800/60 cursor-pointer"
                role="button"
                tabindex="0"
                aria-label="View rating and reviews"
                @click.stop="navigateTo(reviewsPath)"
                @keydown.enter.stop="navigateTo(reviewsPath)"
              >
                <div class="flex items-center text-xl sm:text-2xl font-bold text-highlighted">
                  {{ brandRatingText }}<span v-if="brandHasRating" class="text-base sm:text-lg ml-0.5">★</span>
                </div>
                <div class="text-xs text-muted font-medium">
                  Rating
                </div>
              </div>

              <!-- Years active -->
              <div class="pt-3 px-2">
                <div class="text-xl sm:text-2xl font-bold text-highlighted">
                  {{ brandYearsActive }}
                </div>
                <div class="text-xs text-muted font-medium">
                  {{ brandYearsActive === 1 ? 'Year active' : 'Years active' }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </DashboardIndexPanel>

  <!-- Quick Status Modal/Sheet (Airbnb Parity) -->
  <UModal v-model:open="statusModalOpen" :ui="{ content: 'max-w-md p-6 sm:p-8 rounded-3xl' }">
    <template #content>
      <div class="relative text-center">
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          aria-label="Close"
          class="absolute -top-2 -left-2 size-10 rounded-full justify-center"
          @click="statusModalOpen = false"
        />

        <div class="pt-4 pb-2 flex justify-center">
          <img
            src="/images/website/storefront.webp"
            alt=""
            class="size-36 sm:size-44 object-contain"
            decoding="async"
          />
        </div>

        <h2 class="mt-3 text-xl sm:text-2xl font-semibold text-highlighted">
          {{ isPublished ? 'Take your website offline?' : 'Ready to publish your website?' }}
        </h2>
        <p class="mt-2 text-sm text-muted max-w-sm mx-auto leading-relaxed">
          {{ isPublished
            ? 'Only members with dashboard access or a preview link will be able to view the site. Visitors will see an offline notice.'
            : 'Your website will become public immediately and search engines will be able to index it.' }}
        </p>

        <div class="mt-8 space-y-3">
          <UButton
            :label="isPublished ? 'Switch to draft' : 'Publish website'"
            color="neutral"
            variant="solid"
            size="xl"
            block
            class="h-12 rounded-xl text-base font-semibold justify-center"
            :loading="togglingStatus"
            data-testid="confirm-status-toggle"
            @click="toggleStatusFromModal"
          />
          <UButton
            label="Cancel"
            color="neutral"
            variant="ghost"
            size="xl"
            block
            class="h-10 text-base font-medium justify-center"
            :disabled="togglingStatus"
            @click="statusModalOpen = false"
          />
        </div>
      </div>
    </template>
  </UModal>

  <!-- Page Tasks Modal (Airbnb Parity) -->
  <PageTasksModal v-model="pageTasksModalOpen" :tasks="pageTasks" @dismiss="dismissPageTask" />

  <!-- Translating the brand is a row on the Brand list; this is the sheet it opens. -->
  <DashboardResourceLocalization
    v-if="surface === 'brand'"
    row-trigger
    :organization-id="organizationId"
    resource-type="organization"
    :resource-id="organizationId"
    :resource-label="loadedSettings?.name || 'Brand'"
    :fields="brandLocalizationFields"
    :language-settings-path="`${preferencesPath}/localization`"
  />
</template>

<script lang="ts">
import type { ComputedRef, InjectionKey, Reactive, Ref } from 'vue'
import type { CurrencyCode } from '~/shared/currencies'
import type { OrganizationFontPreset } from '~/shared/organization-fonts'
import type { SitePalette } from '~/shared/site-palette'
import type { LogoPresentation } from '~/shared/media-placement-contract'
import type { FormQuestion } from '~/shared/form-questions'
import type { FormQuestionWrite } from '~/utils/form-question-editing'

export interface OrganizationSettingsForm {
  name: string
  brand_description: string
  announcementEnabled: boolean
  announcementAssetId: string | null
  announcementHeadline: string
  announcementDescription: string
  announcementCtaLabel: string
  announcementCtaUrl: string
  announcementDismissible: boolean
  announcementFormat: 'modal' | 'banner'
  logoAssetId: string | null
  logoPresentation: LogoPresentation
  logoDarkAssetId: string | null
  logoDarkPresentation: LogoPresentation
  faviconAssetId: string | null
  socialShareAssetId: string | null
  contact_email: string
  /** Null on the platform template, whose palette is fixed. */
  palette: SitePalette | null
  font_preset: OrganizationFontPreset
  default_currency: CurrencyCode | null
  status: OrganizationStatus
  seo_title: string
  seo_description: string
  canonical_url: string
  native_consultations: boolean
}

/** Live and Draft are the tenant's; Suspended is KrabiClaw's hold. */
export type OrganizationStatus = 'active' | 'inactive' | 'suspended'

export interface OrganizationSettingsResponse {
  theme?: string
  status: OrganizationStatus
  name?: string | null
  brand_description?: string | null
  announcement: { headline: string; description: string | null; cta_label: string | null; cta_url: string | null; dismissible: boolean; enabled: boolean; format?: 'modal' | 'banner' | null } | null
  media?: Array<{ asset_id: string; slot: string; public_url?: string | null; presentation?: LogoPresentation | null }>
  contact_email?: string | null
  palette: SitePalette | null
  palette_source: 'custom' | 'default' | null
  font_preset?: OrganizationFontPreset
  default_currency?: string | null
  seo_title: string | null
  seo_description: string | null
  canonical_url: string | null
  /** Null when the organization has no consultation settings, so no website booking to switch. */
  consultation_mode: 'native' | 'external_url' | 'native_disabled' | null
  inquiry_questions: FormQuestion[]
  inquiry_questions_revision: string
  vertical?: string
  reviews_count?: number
  average_rating?: number
  created_at?: string
}

/**
 * The site's settings draft and everything a leaf shows or does beside its
 * one field. Brand and Website mount the same provider; a leaf reads what it
 * needs and commits through `save`, which writes only the open setting.
 */
export interface OrganizationSettingsEditor {
  form: Reactive<OrganizationSettingsForm>
  organizationId: string
  saving: Ref<boolean>
  saveDisabled: ComputedRef<boolean>
  editorError: ComputedRef<string | null>
  validationMessage: ComputedRef<string | null>
  nameCharactersRemaining: ComputedRef<number>
  descriptionCharactersRemaining: ComputedRef<number>
  theme: ComputedRef<string | undefined>
  /** The organization's vertical (e.g. 'service', 'restaurant', 'lodging', 'experience'). */
  vertical: ComputedRef<string | null>
  /** Whether the site wears its own palette or its template's. */
  paletteSource: ComputedRef<'custom' | 'default' | null>
  /** Returns the site to the default colors. */
  resetPalette: () => Promise<void>
  /** The saved website booking mode, or null where the organization has no consultation settings. */
  consultationMode: ComputedRef<OrganizationSettingsResponse['consultation_mode']>
  /** The saved logo assets' URLs, for previews before a new pick is saved. */
  logoUrl: (assetId: string | null) => string | null
  revert: () => void
  save: () => Promise<void>
  /** The inquiry form's saved questions, or null until the settings have loaded. */
  inquiryQuestions: ComputedRef<FormQuestion[] | null>
  /** Replaces them over the revision last read, then keeps Website on the saved settings. Throws what the writer refused. */
  saveInquiryQuestions: (questions: readonly FormQuestionWrite[]) => Promise<void>
}

export const organizationSettingsEditorKey = Symbol('organization-settings-editor') as InjectionKey<OrganizationSettingsEditor>
</script>

<script setup lang="ts">
import DashboardResourceLocalization from '~/components/dashboard/DashboardResourceLocalization.vue'
import EditorNavigationList, { type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'
import { isCurrencyCode } from '~/shared/currencies'
import { ORGANIZATION_FONT_OPTIONS, isOrganizationFontPreset, resolveOrganizationFontPreset } from '~/shared/organization-fonts'
import { parseSitePalette } from '~/shared/site-palette'
import { getErrorMessage } from '~/utils/errors'
import { ORIGINAL_LOGO_PRESENTATION } from '~/shared/media-placement-contract'
import PageTasksModal from '~/components/dashboard/PageTasksModal.vue'
import { isTenantPageListResponse, type PageTask, type TenantPageListRow } from '~/composables/useTenantPageDraft'
import { getVerticalLabel } from '~/utils/vertical-copy'
import type { BlogPost } from '~/lib/components/workspace/blog/types'

const props = withDefaults(defineProps<{ surface?: 'brand' | 'settings' | 'preferences' }>(), { surface: 'settings' })
const surface = computed(() => props.surface)
const dashboardApi = useDashboardApi()
const route = useRoute()
const editorError = ref<string | null>(null)
const dashboard = useDashboardOrganization()
const organizationDashboardPath = computed(() => `/dashboard/${String(route.params.orgSlug)}`)
const brandPath = computed(() => `${organizationDashboardPath.value}/website/brand`)
const preferencesPath = computed(() => `${organizationDashboardPath.value}/website/preferences`)
const panelId = computed(() => {
  if (surface.value === 'brand') return 'organization-brand'
  if (surface.value === 'preferences') return 'organization-preferences'
  return 'organization-website'
})
const navbarTitle = computed(() => {
  if (surface.value === 'brand') return 'Brand'
  if (surface.value === 'preferences') return 'Preferences'
  return 'Website'
})
// The level runs while setup is still synchronous: it injects the record the
// `<RouterView>` above rendered, and an `await` before it would bind nothing.
const level = useRouteLevel()

const organizationId = useDashboardOrganizationId()

interface SettingsPageResource {
  settings: { success: boolean; settings: OrganizationSettingsResponse }
}

const isSettingsResponse = (value: unknown): value is { success: boolean; settings: OrganizationSettingsResponse } =>
  isRecord(value) && typeof value.success === 'boolean' && isRecord(value.settings)
  && (value.settings.name === undefined || value.settings.name === null || typeof value.settings.name === 'string')
  && (value.settings.announcement === null || (isRecord(value.settings.announcement) && typeof value.settings.announcement.headline === 'string'))
  && (value.settings.font_preset === undefined || isOrganizationFontPreset(value.settings.font_preset))
  && (value.settings.palette === null || isRecord(value.settings.palette))
  && (value.settings.default_currency === undefined || value.settings.default_currency === null || typeof value.settings.default_currency === 'string')
  && [value.settings.seo_title, value.settings.seo_description, value.settings.canonical_url].every(field => field === null || typeof field === 'string')
  && (value.settings.consultation_mode === null || value.settings.consultation_mode === 'native' || value.settings.consultation_mode === 'external_url' || value.settings.consultation_mode === 'native_disabled')
  && isOrganizationStatus(value.settings.status)
  && Array.isArray(value.settings.inquiry_questions) && typeof value.settings.inquiry_questions_revision === 'string'
function isOrganizationStatus(value: unknown): value is OrganizationStatus {
  return value === 'active' || value === 'inactive' || value === 'suspended'
}


/** Which leaf is open, named by the route below this rail rather than counted here. */
const detailKey = computed(() => level.child.value)
const saving = ref(false)
const theme = computed(() => loadedSettings.value?.theme)
const paletteSource = computed(() => loadedSettings.value?.palette_source ?? null)
const originalSignature = ref('')
const form = reactive<OrganizationSettingsForm>({
  name: '', brand_description: '',
  announcementEnabled: true, announcementAssetId: null, announcementHeadline: '', announcementDescription: '', announcementCtaLabel: '', announcementCtaUrl: '', announcementDismissible: true, announcementFormat: 'modal',
  logoAssetId: null, logoPresentation: ORIGINAL_LOGO_PRESENTATION, logoDarkAssetId: null, logoDarkPresentation: ORIGINAL_LOGO_PRESENTATION,
  faviconAssetId: null, socialShareAssetId: null, contact_email: '', palette: null, font_preset: 'default',
  default_currency: null, status: 'inactive',
  seo_title: '', seo_description: '', canonical_url: '', native_consultations: false,
})

const statusModalOpen = ref(false)
const togglingStatus = ref(false)
const isPublished = computed(() => form.status === 'active')
const statusLabel = computed(() => {
  if (form.status === 'active') return 'Published'
  if (form.status === 'suspended') return 'Suspended'
  return 'Draft'
})
const statusDotClass = computed(() => {
  if (form.status === 'active') return 'bg-success'
  if (form.status === 'suspended') return 'bg-error'
  return 'bg-muted'
})
const statusDescription = computed(() => {
  if (form.status === 'active') return 'Anyone can visit the website, and search engines can list it.'
  if (form.status === 'suspended') return 'KrabiClaw has suspended this website. Contact support to restore it.'
  return 'Your website is in draft mode and not visible to the public or search engines. Publish to go live.'
})

async function toggleStatusFromModal() {
  if (form.status === 'suspended') return
  togglingStatus.value = true
  try {
    const nextStatus: OrganizationStatus = form.status === 'active' ? 'inactive' : 'active'
    await patchSettings({ status: nextStatus })
    form.status = nextStatus
    statusModalOpen.value = false
  } catch (error) {
    editorError.value = getErrorMessage(error, 'Failed to update website status')
  } finally {
    togglingStatus.value = false
  }
}
const brandLocalizationFields = computed(() => [
  { key: 'name', label: 'Brand name', source: loadedSettings.value?.name },
  { key: 'brand_description', label: 'Description', source: loadedSettings.value?.brand_description, multiline: true, rows: 6 },
])
const nameCharactersRemaining = computed(() => 50 - form.name.length)
const descriptionCharactersRemaining = computed(() => 500 - form.brand_description.length)

function explicitSummary(value: string | null | undefined, empty = 'Not set') { return value?.trim() || empty }
const STATUS_LABELS: Record<OrganizationStatus, string> = { active: 'Published', inactive: 'Draft', suspended: 'Suspended' }
const domainSummary = computed(() => dashboard.organization.value?.custom_domain || dashboard.organization.value?.public_url || 'Not connected')
const brandItems = computed<EditorNavigationItem[]>(() => [
  { id: 'name', label: 'Brand name', summary: explicitSummary(loadedSettings.value?.name), icon: 'i-lucide-building-2', to: `${brandPath.value}/name` },
  { id: 'description', label: 'Description', summary: explicitSummary(loadedSettings.value?.brand_description), icon: 'i-lucide-file-text', to: `${brandPath.value}/description` },
  { id: 'contact', label: 'Contact details', summary: explicitSummary(loadedSettings.value?.contact_email), icon: 'i-lucide-mail', to: `${brandPath.value}/contact` },
  { id: 'announcement', label: 'Announcement', summary: loadedSettings.value?.announcement?.enabled ? explicitSummary(loadedSettings.value.announcement.headline) : 'Off', icon: 'i-lucide-megaphone', to: `${brandPath.value}/announcement` },
  // Every customer site has its colors; KrabiClaw's own site keeps fixed ones.
  ...(loadedSettings.value?.palette ? [{ id: 'color', label: 'Colors', summary: paletteSource.value === 'custom' ? 'Your colors' : 'Default colors', icon: 'i-lucide-palette', to: `${brandPath.value}/color` }] : []),
  { id: 'font', label: 'Website font', summary: ORGANIZATION_FONT_OPTIONS.find(option => option.value === loadedSettings.value?.font_preset)?.label ?? 'Default', icon: 'i-lucide-type', to: `${brandPath.value}/font` },
  { id: 'favicon', label: 'Favicon', summary: loadedSettings.value?.media?.some(item => item.slot === 'favicon') ? 'Icon selected' : 'Not set', icon: 'i-lucide-globe', to: `${brandPath.value}/favicon` },
  { id: 'sharing-image', label: 'Social sharing image', summary: loadedSettings.value?.media?.some(item => item.slot === 'social_share') ? 'Image selected' : 'Not set', icon: 'i-lucide-share-2', to: `${brandPath.value}/sharing-image` },
  { id: 'translations', label: 'Translations', summary: 'Translate the brand name and description', icon: 'i-lucide-languages', to: `${brandPath.value}?editMode=translations` },
])
// The site's content lists and its Brand lead, because they are what the site is made of;
// Pages is featured above with its 3-image fan stack;
// preferences (status, languages, domains, currency) live behind the header's settings cog.
const settingsPath = computed(() => `${organizationDashboardPath.value}/website`)
const pagesPath = computed(() => dashboard.organizationPaths.value?.pages ?? `${organizationDashboardPath.value}/website/pages`)
const isBookingActive = computed(() => route.path.startsWith(`${settingsPath.value}/booking`) || route.path.startsWith(`${settingsPath.value}/inquiry-form`))

const pageTasksModalOpen = ref(false)
const dismissedPageTaskIds = ref<Set<string>>(new Set())

const { data: pagesResource } = await useAsyncData(
  `tenant-pages-summary:${String(organizationId)}`,
  () => dashboardApi<{ pages: TenantPageListRow[]; tasks?: PageTask[] }>(`/api/editor/organizations/${organizationId}/pages`, { validate: isTenantPageListResponse }),
)

const pagesList = computed(() => pagesResource.value?.pages ?? [])
const pageTasks = computed<PageTask[]>(() => {
  const all = pagesResource.value?.tasks ?? []
  return all.filter(t => !dismissedPageTaskIds.value.has(t.id))
})

function dismissPageTask(taskId: string) {
  dismissedPageTaskIds.value.add(taskId)
}

const pagesCount = computed(() => pagesList.value.length)
const pagesSummary = computed(() => {
  return pagesList.value.map(p => p.title).filter(Boolean).join(' · ')
})

const previewImages = computed(() => {
  const images: string[] = []
  for (const page of pagesList.value) {
    if (page.image_url && !images.includes(page.image_url)) images.push(page.image_url)
  }
  return images
})

const pagesTaskText = computed(() => {
  if (pageTasks.value.length === 1) return 'You have 1 task'
  if (pageTasks.value.length > 1) return `You have ${pageTasks.value.length} tasks`
  return 'All pages ready'
})

const blogPath = computed(() => dashboard.organizationPaths.value?.blog ?? `${organizationDashboardPath.value}/website/blog`)
const postsPath = computed(() => dashboard.organizationPaths.value?.posts ?? `${organizationDashboardPath.value}/website/posts`)

const isPagesActive = computed(() => route.path.startsWith(pagesPath.value))
const isBlogActive = computed(() => route.path.startsWith(blogPath.value))
const isPostsActive = computed(() => route.path.startsWith(postsPath.value))

const isBlogSummaryResponse = (value: unknown): value is { posts: BlogPost[] } =>
  isRecord(value) && Array.isArray(value.posts)

interface PostSummaryItem {
  id: string
  title: string
  status: string
  published_at?: string | null
  cover_image_url?: string | null
  channels?: string[]
}

const isPostsSummaryResponse = (value: unknown): value is { posts: PostSummaryItem[] } =>
  isRecord(value) && Array.isArray(value.posts)

const { data: blogResource } = await useAsyncData(
  `tenant-blog-summary:${String(organizationId)}`,
  () => dashboardApi<{ posts: BlogPost[] }>(`/api/editor/organizations/${organizationId}/blog/posts`, {
    query: { limit: 50 },
    validate: isBlogSummaryResponse,
  }).catch(() => ({ posts: [] })),
)

const { data: postsResource } = await useAsyncData(
  `tenant-posts-summary:${String(organizationId)}`,
  () => dashboardApi<{ posts: PostSummaryItem[] }>(`/api/editor/organizations/${organizationId}/posts`, {
    query: { limit: 50 },
    validate: isPostsSummaryResponse,
  }).catch(() => ({ posts: [] })),
)

const blogPreviewItems = computed(() => blogResource.value?.posts?.slice(0, 3) ?? [])
const blogRemainingCount = computed(() => Math.max(0, (blogResource.value?.posts?.length ?? 0) - 3))

const postPreviewItems = computed(() => postsResource.value?.posts?.slice(0, 3) ?? [])
const postRemainingCount = computed(() => Math.max(0, (postsResource.value?.posts?.length ?? 0) - 3))

const reviewsPath = computed(() => dashboard.organizationPaths.value?.reviews ?? `${organizationDashboardPath.value}/website/reviews`)

function articleSubtitle(article: BlogPost) {
  const parts: string[] = []
  if (article.status === 'draft') parts.push('Draft')
  else if (article.published_at) {
    parts.push('Published')
    parts.push(new Date(article.published_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
  } else {
    parts.push('Published')
  }
  if (article.category?.name) parts.push(article.category.name)
  return parts.join(' · ')
}

function postSubtitle(post: PostSummaryItem) {
  const parts: string[] = []
  if (post.status === 'draft') parts.push('Draft')
  else if (post.published_at) {
    parts.push('Published')
    parts.push(new Date(post.published_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
  } else {
    parts.push('Published')
  }
  const channels = Array.isArray(post.channels) ? post.channels.filter((c): c is string => typeof c === 'string' && c.length > 0) : []
  const firstChannel = channels[0]
  if (channels.length === 1 && firstChannel) parts.push(firstChannel)
  else if (channels.length > 1) parts.push(`${channels.length} channels`)
  return parts.join(' · ')
}

const settingsItems = computed<EditorNavigationItem[]>(() => [])

const bookingCardTitle = computed(() => {
  const v = loadedSettings.value?.vertical || dashboard.organization.value?.vertical
  if (v === 'service') return 'Consultation settings'
  if (v === 'restaurant') return 'Reservation settings'
  return 'Booking settings'
})

const bookingCardSubtitle = computed(() => {
  const v = loadedSettings.value?.vertical || dashboard.organization.value?.vertical
  if (v === 'service') {
    return form.native_consultations
      ? 'Accepting consultation requests online'
      : 'Inquiries only (offline scheduling)'
  }
  const questionsCount = loadedSettings.value?.inquiry_questions?.length ?? 0
  if (questionsCount > 0) {
    return `${questionsCount} intake ${questionsCount === 1 ? 'question' : 'questions'} configured`
  }
  return 'All bookings are automatically approved'
})

const brandLogoUrl = computed(() => {
  if (form.logoAssetId) return logoUrl(form.logoAssetId)
  return loadedSettings.value?.media?.find(item => item.slot === 'logo')?.public_url
    ?? dashboard.organization.value?.media?.find(item => item.slot === 'logo')?.public_url
    ?? null
})

const brandName = computed(() =>
  form.name?.trim() || loadedSettings.value?.name || dashboard.organization.value?.name || 'Brand'
)

const brandInitial = computed(() => brandName.value.charAt(0).toUpperCase())

const brandVerticalLabel = computed(() => {
  const v = loadedSettings.value?.vertical || dashboard.organization.value?.vertical || 'restaurant'
  return getVerticalLabel(v)
})

const brandReviewsCount = computed(() => loadedSettings.value?.reviews_count ?? 0)

const brandHasRating = computed(() => Boolean(loadedSettings.value?.average_rating && loadedSettings.value.average_rating > 0))

const brandRatingText = computed(() => {
  if (!loadedSettings.value?.average_rating || loadedSettings.value.average_rating <= 0) return '—'
  return Number(loadedSettings.value.average_rating).toFixed(2).replace(/\.?0+$/, '')
})

const brandYearsActive = computed(() => {
  const dateStr = loadedSettings.value?.created_at
  if (!dateStr) return 1
  const createdYear = new Date(dateStr).getFullYear()
  const currentYear = new Date().getFullYear()
  const diff = currentYear - createdYear
  return Math.max(1, diff)
})

const currencyIcon = computed(() => {
  const code = loadedSettings.value?.default_currency?.toUpperCase()
  if (code === 'EUR') return 'i-lucide-euro'
  if (code === 'GBP') return 'i-lucide-pound-sterling'
  if (code === 'JPY' || code === 'CNY') return 'i-lucide-japanese-yen'
  return 'i-lucide-dollar-sign'
})

const preferencesItems = computed<EditorNavigationItem[]>(() => [
  {
    id: 'status',
    label: 'Status',
    summary: loadedSettings.value ? STATUS_LABELS[loadedSettings.value.status] : 'Not set',
    status: form.status === 'active' ? 'success' : form.status === 'suspended' ? 'error' : 'neutral',
    to: `${preferencesPath.value}/status`,
  },
  { id: 'localization', label: 'Languages', summary: 'Languages the site is published in', icon: 'i-lucide-languages', to: `${preferencesPath.value}/localization` },
  { id: 'domains', label: 'Domains', summary: domainSummary.value, icon: 'i-lucide-globe-2', to: `${preferencesPath.value}/domains` },
  { id: 'currency', label: 'Currency', summary: explicitSummary(loadedSettings.value?.default_currency), icon: currencyIcon.value, to: `${preferencesPath.value}/currency` },
  {
    id: 'booking',
    label: bookingCardTitle.value,
    summary: bookingCardSubtitle.value,
    icon: 'i-lucide-calendar-check',
    to: `${preferencesPath.value}/booking`,
  },
  {
    id: 'reviews',
    label: 'Review settings',
    summary: 'Manual approval',
    icon: 'i-lucide-star',
    to: `${preferencesPath.value}/reviews`,
  },
])

const navigationGroups = computed(() => {
  if (surface.value === 'brand') return [{ id: 'brand', items: brandItems.value }]
  if (surface.value === 'preferences') return [{ id: 'preferences', items: preferencesItems.value }]
  return [{ id: 'settings', items: settingsItems.value }]
})

const autoOpenDestination = computed(() => {
  if (surface.value === 'settings') return pagesPath.value
  return navigationGroups.value[0]?.items.find(item => item.to)?.to ?? null
})

// Leaving a section resets its editor. This used to hang off the back button's
// click handler, which left browser back with stale editor state.
watch(() => route.path, (next, previous) => {
  if (previous && previous !== next) resetDraft()
})

function editorSignature(key: string | null) {
  switch (key) {
    case 'name': return JSON.stringify(form.name)
    case 'logo': return JSON.stringify([form.logoAssetId, form.logoPresentation, form.logoDarkAssetId, form.logoDarkPresentation])
    case 'favicon': return JSON.stringify(form.faviconAssetId)
    case 'sharing-image': return JSON.stringify(form.socialShareAssetId)
    case 'description': return JSON.stringify(form.brand_description)
    case 'announcement': return JSON.stringify([form.announcementEnabled, form.announcementAssetId, form.announcementHeadline, form.announcementDescription, form.announcementCtaLabel, form.announcementCtaUrl, form.announcementDismissible, form.announcementFormat])
    case 'color': return JSON.stringify(form.palette)
    case 'font': return JSON.stringify(form.font_preset)
    case 'contact': return JSON.stringify(form.contact_email)
    case 'currency': return JSON.stringify(form.default_currency)
    case 'status': return JSON.stringify(form.status)
    case 'search': return JSON.stringify([form.seo_title, form.seo_description, form.canonical_url])
    case 'booking': return JSON.stringify(form.native_consultations)
    default: return ''
  }
}
function isValidUrl(value: string) {
  if (!value.trim()) return true
  try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:' } catch { return false }
}
// Nothing is a draft until settings have loaded: an unfilled form is not an edit.
const dirty = computed(() => loadedSettings.value !== null && editorSignature(detailKey.value) !== originalSignature.value)
const validationMessage = computed(() => {
  if (!dirty.value) return null
  switch (detailKey.value) {
    case 'name': return form.name.trim() ? null : 'Enter a brand name.'
    case 'announcement': {
      if (!form.announcementEnabled) return null
      if (!form.announcementHeadline.trim() || form.announcementHeadline.length > 120) return 'Enter a headline of 120 characters or fewer.'
      if (form.announcementDescription.length > 500) return 'Keep the description within 500 characters.'
      if (Boolean(form.announcementCtaLabel.trim()) !== Boolean(form.announcementCtaUrl.trim())) return 'A button needs both a label and a URL.'
      if (form.announcementCtaUrl.trim() && !isValidUrl(form.announcementCtaUrl)) return 'Enter a complete http or https button URL.'
      return null
    }
    case 'color': {
      try {
        parseSitePalette(form.palette)
        return null
      } catch (error) {
        return (error as Error).message.replace(/^palette\.(light|dark)\.(\w+) must be a #RRGGBB color$/, 'Enter a six-digit hex color for $2 ($1).')
      }
    }
    case 'font': return isOrganizationFontPreset(form.font_preset) ? null : 'Choose a supported website font.'
    case 'contact': return !form.contact_email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.contact_email) ? null : 'Enter a valid email address.'
    case 'status': return form.status === 'suspended' ? 'This website is suspended. Contact support to restore it.' : null
    case 'search': return isValidUrl(form.canonical_url) ? null : 'Enter a complete http or https URL.'
    default: return null
  }
})
const saveDisabled = computed(() => {
  return !dirty.value || validationMessage.value !== null
})

function fillForm(settings: OrganizationSettingsResponse) {
  form.name = settings.name ?? ''
  form.brand_description = settings.brand_description ?? ''
  form.announcementEnabled = settings.announcement?.enabled ?? false
  form.announcementAssetId = settings.media?.find(item => item.slot === 'announcement')?.asset_id ?? null
  form.announcementHeadline = settings.announcement?.headline ?? ''
  form.announcementDescription = settings.announcement?.description ?? ''
  form.announcementCtaLabel = settings.announcement?.cta_label ?? ''
  form.announcementCtaUrl = settings.announcement?.cta_url ?? ''
  form.announcementDismissible = settings.announcement?.dismissible ?? true
  form.announcementFormat = settings.announcement?.format === 'banner' ? 'banner' : 'modal'
  const logo = settings.media?.find(item => item.slot === 'logo')
  const logoDark = settings.media?.find(item => item.slot === 'logo_dark')
  form.logoAssetId = logo?.asset_id ?? null
  form.logoPresentation = logo?.presentation ?? ORIGINAL_LOGO_PRESENTATION
  form.logoDarkAssetId = logoDark?.asset_id ?? null
  form.logoDarkPresentation = logoDark?.presentation ?? ORIGINAL_LOGO_PRESENTATION
  form.faviconAssetId = settings.media?.find(item => item.slot === 'favicon')?.asset_id ?? null
  form.socialShareAssetId = settings.media?.find(item => item.slot === 'social_share')?.asset_id ?? null
  form.contact_email = settings.contact_email ?? ''
  form.palette = settings.palette && structuredClone(settings.palette)
  form.font_preset = resolveOrganizationFontPreset(settings.font_preset)
  // A stored value that is not a supported code is not this form's to reinterpret:
  // showing it as USD invited the owner to save that over whatever is really there.
  form.default_currency = isCurrencyCode(settings.default_currency) ? settings.default_currency : null
  form.status = settings.status
  form.seo_title = settings.seo_title ?? ''
  form.seo_description = settings.seo_description ?? ''
  form.canonical_url = settings.canonical_url ?? ''
  form.native_consultations = settings.consultation_mode === 'native'
}
function resetDraft() {
  editorError.value = null
  if (loadedSettings.value) fillForm(loadedSettings.value)
  originalSignature.value = editorSignature(detailKey.value)
}

const settingsResourceKey = computed(() => `dashboard-organization-settings:${String(route.params.orgSlug)}`)
const { data: settingsResource, error: settingsResourceError, refresh: refreshSettingsResource } = await useAsyncData<SettingsPageResource>(settingsResourceKey, async () => {
  const [settings] = await Promise.all([
    dashboardApi<{ success: boolean; settings: OrganizationSettingsResponse }>('/api/dashboard/settings', { validate: isSettingsResponse }),
  ])
  return { settings }
})
// The saved settings are what the request answered; the form is the draft seeded from each answer.
const loadedSettings = computed(() => settingsResource.value?.settings.settings ?? null)
const loadError = computed(() => settingsResourceError.value ? getErrorMessage(settingsResourceError.value, 'Failed to load organization settings') : null)
watch(settingsResource, (resource) => {
  if (!resource) return
  fillForm(resource.settings.settings)
  originalSignature.value = editorSignature(detailKey.value)
}, { immediate: true })
watch(detailKey, () => resetDraft())

async function patchSettings(body: Record<string, unknown>) {
  const response = await dashboardApi<{ success: boolean; settings: OrganizationSettingsResponse }>('/api/dashboard/settings', { method: 'PATCH', body, validate: isSettingsResponse })
  // Website and Brand read the same settings resource; writing the response
  // through it keeps the other list's rows on the saved values.
  settingsResource.value = { settings: response }
  await dashboard.refresh()
}
async function refreshSettings() {
  await refreshSettingsResource()
  if (settingsResourceError.value) throw settingsResourceError.value
}
async function resetPalette() {
  saving.value = true
  editorError.value = null
  try { await patchSettings({ palette: null }) } catch (error) { editorError.value = getErrorMessage(error, 'Failed to reset the colors') } finally { saving.value = false }
}
function logoUrl(assetId: string | null) {
  return assetId ? loadedSettings.value?.media?.find(item => item.asset_id === assetId)?.public_url ?? null : null
}
async function saveCurrentEditor() {
  if (saveDisabled.value || !detailKey.value) return
  saving.value = true
  editorError.value = null
  try {
    switch (detailKey.value) {
      case 'name': await patchSettings({ name: form.name.trim() }); break
      case 'logo': await patchSettings({ media: [
        { asset_id: form.logoAssetId, slot: 'logo', presentation: form.logoAssetId ? form.logoPresentation : null },
        { asset_id: form.logoDarkAssetId, slot: 'logo_dark', presentation: form.logoDarkAssetId ? form.logoDarkPresentation : null },
      ] }); break
      case 'favicon': await patchSettings({ media: [{ asset_id: form.faviconAssetId, slot: 'favicon' }] }); break
      case 'sharing-image': await patchSettings({ media: [{ asset_id: form.socialShareAssetId, slot: 'social_share' }] }); break
      case 'description': await patchSettings({ brand_description: form.brand_description }); break
      case 'announcement': {
        await patchSettings({
          announcement: {
            headline: form.announcementHeadline.trim(),
            description: form.announcementDescription.trim() || null,
            cta_label: form.announcementCtaLabel.trim() || null,
            cta_url: form.announcementCtaUrl.trim() || null,
            dismissible: form.announcementDismissible,
            enabled: form.announcementEnabled,
            format: form.announcementFormat,
          },
          media: [{ asset_id: form.announcementAssetId, slot: 'announcement' }],
        })
        break
      }
      case 'color': await patchSettings({ palette: form.palette }); break
      case 'font': await patchSettings({ font_preset: form.font_preset }); break
      case 'contact': await patchSettings({ contact_email: form.contact_email.trim() }); break
      case 'currency': {
        if (!form.default_currency) throw new Error('Choose the currency this organization prices in.')
        await patchSettings({ default_currency: form.default_currency })
        break
      }
      case 'status': await patchSettings({ status: form.status }); break
      case 'search': await patchSettings({ seo_title: form.seo_title.trim() || null, seo_description: form.seo_description.trim() || null, canonical_url: form.canonical_url.trim() || null }); break
      case 'booking': {
        const current = loadedSettings.value?.consultation_mode
        if (!current) throw new Error('This website has no booking to switch.')
        // The one writer of the consultation mode, shared with MCP's set_consultation_mode.
        await dashboardApi(`/api/editor/organizations/${organizationId}/consultation`, {
          method: 'PUT', body: { mode: form.native_consultations ? 'native' : current === 'native' ? 'native_disabled' : current }, validate: isRecord,
        })
        await refreshSettings()
        break
      }
    }
  } catch (error) { editorError.value = getErrorMessage(error, 'Failed to save this setting') } finally { saving.value = false }
}
async function saveInquiryQuestions(questions: readonly FormQuestionWrite[]) {
  if (!loadedSettings.value) throw new Error('Read the website settings before editing the inquiry form.')
  await patchSettings({ inquiry_questions: questions, expected_inquiry_questions_revision: loadedSettings.value.inquiry_questions_revision })
}
provide(organizationSettingsEditorKey, {
  form,
  organizationId,
  saving,
  saveDisabled,
  // A leaf opened on settings that failed to load shows why.
  editorError: computed(() => loadError.value ?? editorError.value),
  validationMessage,
  nameCharactersRemaining,
  descriptionCharactersRemaining,
  theme,
  vertical: computed(() => loadedSettings.value?.vertical ?? dashboard.organization.value?.vertical ?? null),
  paletteSource,
  resetPalette,
  consultationMode: computed(() => loadedSettings.value?.consultation_mode ?? null),
  logoUrl,
  // A cancelled leaf puts the loaded settings back before it closes.
  revert: resetDraft,
  save: saveCurrentEditor,
  inquiryQuestions: computed(() => loadedSettings.value?.inquiry_questions ?? null),
  saveInquiryQuestions,
})
</script>
