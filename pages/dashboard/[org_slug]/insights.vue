<template>
  <DashboardIndexPanel id="organization-insights" title="Insights">
    <div class="space-y-6 pb-12">
      <UAlert
        v-if="loadError"
        color="error"
        variant="soft"
        title="Analytics could not be loaded"
        :description="loadError"
        :actions="[{ label: 'Try again', onClick: () => refresh() }]"
      />

      <!-- Airbnb-Style Unified Filter Toolbar -->
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-default pb-4">
        <div class="flex flex-wrap items-center gap-2">
          <DashboardFilterPills
            id="insights-channel"
            v-model="tab"
            label="Analytics view"
            :items="tabItems"
            role="tablist"
          />
          <DateRangeFilterPill
            v-if="tab === 'views' || tab === 'instagram' || tab === 'ads'"
            :start-date="currentStartDate"
            :end-date="currentEndDate"
            :default-days="30"
            @update:range="onDateRangeUpdate"
          />
        </div>

        <div v-if="canReadAnalytics" class="flex items-center gap-3 text-xs text-muted">
          <span v-if="analytics?.period" class="hidden sm:inline">Last updated: {{ formatDate(analytics.period.end_date) }}</span>
          <UButton
            label="Booking income by channel"
            :to="`/dashboard/${route.params.org_slug}/earnings/performance`"
            color="neutral"
            variant="link"
            size="xs"
          />
        </div>
      </div>

      <!-- Test & Accessibility anchor for period verification -->
      <p v-if="tab === 'views' && analytics" class="sr-only" data-testid="insights-period">
        <time :datetime="analytics.period.start_date">{{ formatDate(analytics.period.start_date) }}</time> –
        <time :datetime="analytics.period.end_date">{{ formatDate(analytics.period.end_date) }}</time>
      </p>

      <!-- ========================================== -->
      <!-- TAB 1: VIEWS & CONVERSION FUNNEL          -->
      <!-- ========================================== -->
      <div v-if="tab === 'views' && analytics && !loadError" class="space-y-8">
        <!-- 1. Top-Level Metric Strip -->
        <MetricHeaderStrip :items="metricCards" />

        <!-- 2. Performance Acquisition Funnel -->
        <section class="rounded-2xl border border-default bg-default p-6 shadow-2xs" data-testid="insights-funnel">
          <header class="mb-4">
            <h2 class="text-base font-semibold text-highlighted">Funnel</h2>
            <p class="mt-1 text-xs text-muted">
              Each percentage is of the step before it. Visits are distinct sessions; confirmed is a request whose {{ funnelWords.confirmedNoun }} stands confirmed.
            </p>
          </header>

          <div class="space-y-4">
            <DashboardAnalyticsRow
              v-for="step in funnelSteps"
              :key="step.key"
              :label="step.label"
              :value="step.value"
              :percent="step.percent"
              :data-testid="`insights-funnel-${step.key}`"
            />
          </div>

          <div v-for="breakdown in funnelBreakdowns" :key="breakdown.title" class="mt-6 border-t border-default pt-4 overflow-x-auto">
            <h3 class="text-xs font-semibold text-muted uppercase tracking-wider mb-3">By {{ breakdown.title.toLowerCase() }}</h3>
            <table class="w-full text-left text-sm" :data-testid="breakdown.testId">
              <thead class="text-xs text-muted border-b border-default">
                <tr>
                  <th scope="col" class="pb-2.5 font-medium">{{ breakdown.title }}</th>
                  <th v-for="column in funnelWords.short" :key="column" scope="col" class="pb-2.5 pl-4 text-right font-medium">{{ column }}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-default">
                <tr v-for="row in breakdown.rows" :key="row.label" class="hover:bg-muted/30">
                  <td class="py-2.5 pr-4 font-medium text-highlighted">{{ row.label }}</td>
                  <td v-for="(cell, index) in row.cells" :key="index" class="py-2.5 pl-4 text-right tabular-nums">{{ cell }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- 3. Traffic Trend Chart Card -->
        <MetricChartCard
          title="Traffic trend"
          description="Daily pageviews and sessions over the selected period"
          :dates="dailyData.map(day => day.date)"
          :series="trafficSeries"
          empty-title="No traffic recorded yet"
          empty-description="Pageviews and sessions will show here once visitors view your website."
          learn-more-label="Learn more about website analytics"
        />

        <!-- 4. Top Landing Pages -->
        <BreakdownTable
          title="Top pages"
          label-heading="Page path"
          value-heading="Views"
          :items="topPagesItems"
          empty-message="No page data recorded yet."
        />

        <!-- 5. Attribution Sources & Campaigns -->
        <BreakdownTable
          title="Traffic sources & campaigns"
          label-heading="Source / medium"
          value-heading="Sessions"
          :items="attributionItems"
          empty-message="No attribution data recorded yet."
        />

        <!-- 6. Signup Funnel & Cohort -->
        <section v-if="analytics.signup_cohort.signups" class="rounded-2xl border border-default bg-default p-6 shadow-2xs">
          <header class="mb-4">
            <h2 class="text-base font-semibold text-highlighted">Signup funnel</h2>
            <p class="mt-1 text-xs text-muted">Progress of people who signed up in this period through their organizations.</p>
          </header>
          <div class="grid grid-cols-3 gap-4" aria-label="Signup conversion funnel">
            <div
              v-for="stage in [
                { label: 'Signups', count: analytics.signup_cohort.signups },
                { label: 'Onboarded', count: analytics.signup_cohort.onboarded_signups },
                { label: 'Paid', count: analytics.signup_cohort.first_paid_signups },
              ]"
              :key="stage.label"
              class="space-y-2 rounded-xl bg-muted/30 p-3"
            >
              <p class="text-xs font-medium text-muted uppercase">{{ stage.label }}</p>
              <p class="text-2xl font-semibold tabular-nums text-highlighted">{{ formatCount(stage.count) }}</p>
              <div class="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <div class="h-full rounded-full bg-primary" :style="{ width: `${stage.count / analytics.signup_cohort.signups * 100}%` }" />
              </div>
              <p class="text-xs tabular-nums text-muted">{{ Math.round(stage.count / analytics.signup_cohort.signups * 100) }}%</p>
            </div>
          </div>
        </section>

        <!-- 7. Geographic & Device Demographics Grid -->
        <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <BreakdownTable
            title="Countries"
            label-heading="Country"
            value-heading="Views"
            :items="countryItems"
            empty-message="No country data recorded yet."
          />
          <BreakdownTable
            title="Cities"
            label-heading="City"
            value-heading="Views"
            :items="cityItems"
            empty-message="No city data recorded yet."
          />
          <BreakdownTable
            title="Devices"
            label-heading="Device type"
            value-heading="Views"
            :items="deviceItems"
            empty-message="No device data recorded yet."
          />
          <BreakdownTable
            title="Referrers"
            label-heading="Referrer"
            value-heading="Views"
            :items="referrerItems"
            empty-message="No referrer data recorded yet."
          />
        </div>
      </div>

      <!-- ========================================== -->
      <!-- TAB 2: INSTAGRAM INSIGHTS                  -->
      <!-- ========================================== -->
      <div v-else-if="tab === 'instagram'" class="space-y-8">
        <UAlert
          v-if="instagramError"
          color="error"
          variant="soft"
          title="Instagram insights could not be loaded"
          :description="instagramError.message"
          :actions="[{ label: 'Try again', onClick: () => refreshInstagram() }]"
        />
        <div v-else-if="instagramLoading && !instagram" class="space-y-4" role="status" aria-label="Loading Instagram insights">
          <USkeleton class="h-28 w-full rounded-2xl" />
        </div>
        <UAlert
          v-else-if="instagram && instagram.status !== 'connected'"
          color="neutral"
          variant="soft"
          :description="instagram.message"
          :actions="[{ label: 'Instagram settings', to: `/dashboard/${scope?.orgSlug}/integrations/instagram` }]"
        />
        <template v-else-if="instagram && instagram.status === 'connected'">
          <p class="text-xs text-muted">@{{ instagram.username }} · Activity reported by Instagram can take up to 48 hours to update.</p>
          <MetricHeaderStrip :items="instagramMetricCards" />

          <section class="rounded-2xl border border-default bg-default p-6 shadow-2xs">
            <header class="mb-4">
              <h2 class="text-base font-semibold text-highlighted">Posts in this range</h2>
            </header>
            <p v-if="!instagram.media.length" class="text-sm text-muted">No posts were published in this range.</p>
            <ul v-else class="divide-y divide-default">
              <li v-for="post in instagram.media" :key="post.id" class="flex gap-4 py-4 first:pt-0 last:pb-0">
                <img v-if="post.thumbnailUrl" :src="post.thumbnailUrl" alt="" class="size-16 shrink-0 rounded-lg object-cover">
                <div class="min-w-0 flex-1">
                  <a v-if="post.permalink" :href="post.permalink" target="_blank" rel="noopener" class="line-clamp-2 text-sm font-medium text-highlighted hover:underline">{{ post.caption || 'Untitled post' }}</a>
                  <p v-else class="line-clamp-2 text-sm font-medium text-highlighted">{{ post.caption || 'Untitled post' }}</p>
                  <p class="mt-1 text-xs text-muted">{{ new Date(post.postedAt).toLocaleDateString() }} · {{ post.productType === 'REELS' ? 'Reel' : post.mediaType === 'CAROUSEL_ALBUM' ? 'Carousel' : 'Post' }}</p>
                  <p v-if="post.unavailableReason" class="mt-2 text-xs text-muted">{{ post.unavailableReason }}</p>
                  <dl v-else-if="post.insights" class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    <div v-for="field in MEDIA_FIELDS" :key="field.key" class="flex gap-1">
                      <dt class="text-muted">{{ field.label }}</dt>
                      <dd class="tabular-nums text-highlighted">{{ post.insights[field.key] === null ? '—' : formatCount(post.insights[field.key]!) }}</dd>
                    </div>
                  </dl>
                </div>
              </li>
            </ul>
            <p v-if="instagram.moreMedia" class="mt-3 text-xs text-muted">Showing the 100 most recent posts in this range.</p>
          </section>
        </template>
      </div>

      <!-- ========================================== -->
      <!-- TAB 3: GOOGLE ADS                          -->
      <!-- ========================================== -->
      <div v-else-if="tab === 'ads'" class="space-y-8">
        <UAlert
          v-if="adsError"
          color="error"
          variant="soft"
          title="Google Ads insights could not be loaded"
          :description="adsError.message"
          :actions="[{ label: 'Try again', onClick: () => refreshAds() }]"
        />
        <div v-else-if="adsLoading && !ads" class="space-y-4" role="status" aria-label="Loading Google Ads insights">
          <USkeleton class="h-28 w-full rounded-2xl" />
        </div>
        <UAlert
          v-else-if="ads && ads.status !== 'connected'"
          color="neutral"
          variant="soft"
          :description="ads.message"
          :actions="[{ label: 'Google Ads settings', to: `/dashboard/${scope?.orgSlug}/integrations/google-ads` }]"
        />
        <template v-else-if="ads && ads.status === 'connected'">
          <p class="text-xs text-muted">{{ ads.customer.name }} ({{ ads.customer.id }}) · Ad spend is reported by Google Ads.</p>
          <MetricHeaderStrip :items="adsMetricCards" />

          <section class="rounded-2xl border border-default bg-default p-6 shadow-2xs">
            <header class="mb-4">
              <h2 class="text-base font-semibold text-highlighted">Campaigns in this range</h2>
            </header>
            <p v-if="!ads.campaigns.length" class="text-sm text-muted">No campaign activity recorded in this range.</p>
            <div v-else class="overflow-x-auto">
              <table class="w-full table-fixed text-left text-sm">
                <thead class="text-xs text-muted border-b border-default">
                  <tr>
                    <th scope="col" class="w-2/5 pb-2.5 font-medium">Campaign</th>
                    <th scope="col" class="pb-2.5 text-right font-medium">Spend</th>
                    <th scope="col" class="pb-2.5 text-right font-medium">Clicks</th>
                    <th scope="col" class="pb-2.5 text-right font-medium">Conv.</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-default">
                  <tr v-for="c in ads.campaigns" :key="c.id" class="hover:bg-muted/30">
                    <td class="py-2.5 pr-4 font-medium text-highlighted truncate">{{ c.name }}</td>
                    <td class="py-2.5 text-right tabular-nums">{{ formatMicros(c.costMicros, ads.customer.currency) }}</td>
                    <td class="py-2.5 text-right tabular-nums">{{ formatCount(c.clicks) }}</td>
                    <td class="py-2.5 text-right tabular-nums">{{ formatCount(Math.round(c.conversions)) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </template>
      </div>

      <!-- ========================================== -->
      <!-- TAB 4: REPUTATION & REVIEWS                -->
      <!-- ========================================== -->
      <div v-else-if="tab === 'reviews'" class="space-y-8">
        <div class="flex flex-wrap items-center justify-between gap-4 border-b border-default pb-3">
          <p v-if="feedback" class="text-xs text-muted" data-testid="feedback-period">
            <time :datetime="feedback.period.startDate">{{ formatDate(feedback.period.startDate) }}</time> –
            <time :datetime="feedback.period.endDate">{{ formatDate(feedback.period.endDate) }}</time>
          </p>
          <div class="flex items-center gap-2" role="group" aria-label="Feedback range">
            <UButton
              v-for="days in FEEDBACK_RANGES"
              :key="days"
              :label="`${days}d`"
              color="neutral"
              :variant="feedbackDays === days ? 'solid' : 'outline'"
              class="h-8 rounded-full px-3 text-xs"
              :disabled="feedbackPending"
              @click="feedbackDays = days"
            />
          </div>
        </div>

        <UAlert v-if="feedbackError" color="error" variant="soft" title="Guest feedback could not be loaded" :description="feedbackError.message" />
        <section v-else-if="feedback" class="space-y-6" data-testid="insights-feedback">
          <MetricHeaderStrip
            :items="[
              { label: 'Overall rating', value: feedback.overall.average ?? '—', subtext: feedback.responses === 1 ? '1 response' : `${formatCount(feedback.responses)} responses`, testId: 'feedback-overall' },
              { label: 'Private feedback', value: formatCount(feedback.privateFeedbackCount), subtext: 'Read only by your team' }
            ]"
          />

          <!-- Categories Performance -->
          <div v-for="subject in feedback.subjects" :key="subject.subject" class="rounded-2xl border border-default bg-default p-6 shadow-2xs" :data-testid="`feedback-subject-${subject.subject}`">
            <h3 class="text-sm font-semibold text-highlighted">{{ subject.label }} · {{ subject.responses === 1 ? '1 response' : `${formatCount(subject.responses)} responses` }}</h3>
            <div class="mt-4 space-y-3">
              <DashboardAnalyticsRow
                v-for="category in subject.categories"
                :key="category.key"
                :label="category.label"
                :value="category.average === null ? '—' : `${category.average} · ${category.count === 1 ? '1 rating' : `${category.count} ratings`}`"
                :percent="category.average === null ? 0 : (category.average / 5) * 100"
                :data-testid="`feedback-category-${category.key}`"
              />
            </div>
          </div>

          <!-- Recent Guest Feedback Stream -->
          <div class="rounded-2xl border border-default bg-default p-6 shadow-2xs">
            <h3 class="text-base font-semibold text-highlighted mb-4">Recent guest feedback</h3>
            <div class="divide-y divide-default">
              <article v-for="entry in feedback.recent" :id="`review-${entry.id}`" :key="entry.id" class="py-4 first:pt-0 last:pb-0" :class="focusedReview === entry.id ? 'rounded-lg bg-elevated px-3' : ''" :data-testid="`feedback-review-${entry.id}`">
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span class="font-medium text-highlighted">{{ entry.author }}</span>
                  <span class="text-sm tabular-nums text-primary" :aria-label="`${entry.rating} out of 5`">{{ '★'.repeat(entry.rating) }}</span>
                  <UBadge :color="entry.status === 'private' ? 'neutral' : entry.status === 'approved' ? 'success' : 'warning'" variant="soft" size="xs" :label="FEEDBACK_STATUS_LABELS[entry.status]" />
                  <span class="text-xs text-muted">{{ [entry.visitTitle, formatDate(entry.createdAt.slice(0, 10))].filter(Boolean).join(' · ') }}</span>
                </div>
                <p v-if="entry.categories.length" class="mt-1 text-xs text-muted">{{ entry.categories.map(category => `${category.label} ${category.rating}`).join(' · ') }}</p>
                <p v-if="entry.title" class="mt-2 font-medium text-highlighted">{{ entry.title }}</p>
                <p v-if="entry.content" class="mt-1 text-sm leading-6 text-muted">{{ entry.content }}</p>
                <div v-if="entry.privateFeedback" class="mt-2 rounded-md bg-muted px-3 py-2">
                  <p class="text-xs font-medium text-highlighted">Private feedback</p>
                  <p class="mt-1 whitespace-pre-line text-sm text-muted">{{ entry.privateFeedback }}</p>
                </div>
                <NuxtLink v-if="canReadAnalytics && entry.status !== 'private'" :to="`/dashboard/${scope?.orgSlug}/website/reviews/${entry.id}`" class="mt-2 inline-block text-xs font-medium text-primary hover:underline">{{ entry.status === 'pending' ? 'Review and publish' : 'Open review' }}</NuxtLink>
              </article>
              <p v-if="!feedback.recent.length" class="py-4 text-center text-sm text-muted">No guest feedback in this period.</p>
            </div>
          </div>
        </section>

        <!-- Published Reviews (Google + Direct) -->
        <section v-if="canReadAnalytics && reviews && !loadError" class="rounded-2xl border border-default bg-default p-6 shadow-2xs" data-testid="insights-published-reviews">
          <header class="mb-4">
            <h2 class="text-base font-semibold text-highlighted">Published reviews</h2>
            <p class="mt-1 text-xs text-muted">What your website shows, imported Google reviews included.</p>
          </header>
          <div v-if="reviews.recent.length" class="divide-y divide-default">
            <article v-for="review in reviews.recent" :key="review.id" class="py-4 first:pt-0 last:pb-0">
              <div class="flex items-center gap-2">
                <span class="font-medium text-highlighted">{{ review.author_name }}</span>
                <span class="text-sm tabular-nums text-primary">{{ '★'.repeat(review.rating) }}</span>
                <UBadge v-if="review.source === 'google'" color="neutral" variant="soft" size="xs" label="Google" />
              </div>
              <p v-if="review.content" class="mt-1 line-clamp-3 text-sm leading-6 text-muted">{{ review.content }}</p>
            </article>
          </div>
          <p v-else class="py-4 text-center text-sm text-muted">No published reviews yet.</p>
        </section>
      </div>

    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import DashboardAnalyticsRow from '~/lib/components/workspace/dashboard/AnalyticsRow.vue'
import DateRangeFilterPill from '~/components/dashboard/insights/DateRangeFilterPill.vue'
import MetricHeaderStrip from '~/components/dashboard/insights/MetricHeaderStrip.vue'
import MetricChartCard from '~/components/dashboard/insights/MetricChartCard.vue'
import BreakdownTable from '~/components/dashboard/insights/BreakdownTable.vue'

import { formatCalendarDate } from '~/utils/timezone'
import { organizationAnalyticsSchema, type AnalyticsReport, type OrganizationAnalyticsReport } from '~/shared/analytics-report'
import { instagramInsightsSchema, type InstagramInsights } from '~/shared/instagram-insights'
import { googleAdsInsightsSchema, type GoogleAdsInsights } from '~/shared/google-ads-insights'
import { currencyFractionDigits, isCurrencyCode } from '~/shared/currencies'
import { reviewFeedbackSchema, type ReviewFeedback } from '~/shared/review-feedback'
import { authClient } from '~/lib/auth-client'

definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'menu' })
const dashboardApi = useDashboardApi()
const route = useRoute()
const scope = useDashboardRouteScope()
const dashboardOrganization = useDashboardOrganization()

// Permissions
const { data: analyticsPermission } = await useAsyncData(
  () => `insights-analytics-permission:${dashboardOrganization.organizationId.value ?? ''}`,
  async () => {
    const organizationId = dashboardOrganization.organizationId.value
    if (!organizationId) throw createError({ statusCode: 404, statusMessage: 'Organization not found' })
    const permission = await authClient.organization.hasPermission({ organizationId, permissions: { analytics: ['read'] } })
    if (permission.error) throw new Error(permission.error.message || 'Your permissions could not be checked.')
    return permission.data!.success
  },
)
const canReadAnalytics = computed(() => analyticsPermission.value === true)

// Tabs
const TAB_VALUES = ['views', 'instagram', 'ads', 'reviews'] as const
type InsightsTab = typeof TAB_VALUES[number]
const isTab = (value: unknown): value is InsightsTab => TAB_VALUES.some(candidate => candidate === value)
const defaultTab = computed<InsightsTab>(() => canReadAnalytics.value ? 'views' : 'reviews')
const tab = ref<InsightsTab>(isTab(route.query.tab) && (canReadAnalytics.value || route.query.tab === 'reviews') ? route.query.tab : defaultTab.value)

watch(() => route.query.tab, (value) => {
  const next = isTab(value) && (canReadAnalytics.value || value === 'reviews') ? value : defaultTab.value
  if (tab.value !== next) tab.value = next
})
watch(tab, (next) => {
  void navigateTo({ query: next === 'views' ? { ...route.query, tab: undefined } : { ...route.query, tab: next } }, { replace: true })
})

const tabItems = computed(() => canReadAnalytics.value
  ? [
      { label: 'Views', value: 'views' as const },
      { label: 'Instagram', value: 'instagram' as const },
      { label: 'Google Ads', value: 'ads' as const },
      { label: 'Reviews', value: 'reviews' as const },
    ]
  : [{ label: 'Reviews', value: 'reviews' as const }])

// Range handling
const requestedRange = computed(() => ({
  start_date: route.query.start_date === undefined ? undefined : String(route.query.start_date ?? ''),
  end_date: route.query.end_date === undefined ? undefined : String(route.query.end_date ?? ''),
}))

const currentStartDate = computed(() => {
  if (requestedRange.value.start_date) return requestedRange.value.start_date
  if (analytics.value?.period) return analytics.value.period.start_date
  const end = new Date()
  const start = new Date(end.getTime() - 29 * 86_400_000)
  return start.toISOString().slice(0, 10)
})

const currentEndDate = computed(() => {
  if (requestedRange.value.end_date) return requestedRange.value.end_date
  if (analytics.value?.period) return analytics.value.period.end_date
  return new Date().toISOString().slice(0, 10)
})

async function onDateRangeUpdate(range: { startDate: string; endDate: string }) {
  await navigateTo({ query: { ...route.query, start_date: range.startDate, end_date: range.endDate } })
}

// Fetch main analytics
const { data: insightsResource, error: resourceError, refresh } = await useAsyncData(
  () => `dashboard-org-insights:${scope.value?.orgSlug}:${requestedRange.value.start_date ?? ''}:${requestedRange.value.end_date ?? ''}`,
  async () => !canReadAnalytics.value ? null : await dashboardApi<OrganizationAnalyticsReport>('/api/dashboard/analytics', {
    query: requestedRange.value,
    validate: (value): value is OrganizationAnalyticsReport => {
      const result = organizationAnalyticsSchema.safeParse(value)
      if (!result.success) {
        throw new ApiClientError(
          `Invalid analytics response: ${result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
          502, 'INVALID_ANALYTICS_RESPONSE', null,
        )
      }
      return true
    },
  }),
)
const analytics = computed<AnalyticsReport | null>(() => insightsResource.value?.report ?? null)
const loadError = computed(() => resourceError.value?.message ?? null)

// Fetch Instagram
const { data: instagram, pending: instagramLoading, error: instagramError, refresh: refreshInstagram, execute: loadInstagram } = await useAsyncData(
  () => `dashboard-org-instagram:${scope.value?.orgSlug}:${requestedRange.value.start_date ?? ''}:${requestedRange.value.end_date ?? ''}`,
  () => dashboardApi<InstagramInsights>('/api/dashboard/instagram-insights', {
    query: requestedRange.value,
    validate: (value): value is InstagramInsights => {
      const result = instagramInsightsSchema.safeParse(value)
      if (!result.success) throw new ApiClientError('Invalid Instagram insights response', 502, 'INVALID_INSTAGRAM_INSIGHTS_RESPONSE', null)
      return true
    },
  }),
  { lazy: true, immediate: false },
)
watch(() => tab.value === 'instagram' ? `${scope.value?.orgSlug}:${requestedRange.value.start_date ?? ''}:${requestedRange.value.end_date ?? ''}` : null, (key) => { if (key) void loadInstagram() }, { immediate: true })

// Fetch Google Ads
const { data: ads, pending: adsLoading, error: adsError, refresh: refreshAds, execute: loadAds } = await useAsyncData(
  () => `dashboard-org-ads:${scope.value?.orgSlug}:${requestedRange.value.start_date ?? ''}:${requestedRange.value.end_date ?? ''}`,
  () => dashboardApi<GoogleAdsInsights>('/api/dashboard/google-ads-insights', {
    query: requestedRange.value,
    validate: (value): value is GoogleAdsInsights => {
      const result = googleAdsInsightsSchema.safeParse(value)
      if (!result.success) throw new ApiClientError('Invalid Google Ads insights response', 502, 'INVALID_GOOGLE_ADS_INSIGHTS_RESPONSE', null)
      return true
    },
  }),
  { lazy: true, immediate: false },
)
watch(() => tab.value === 'ads' ? `${scope.value?.orgSlug}:${requestedRange.value.start_date ?? ''}:${requestedRange.value.end_date ?? ''}` : null, (key) => { if (key) void loadAds() }, { immediate: true })

// Guest feedback
const FEEDBACK_RANGES = [30, 90, 365] as const
const feedbackDays = ref<typeof FEEDBACK_RANGES[number]>(90)
const focusedReview = computed(() => typeof route.query.review === 'string' ? route.query.review : null)
const { data: feedback, pending: feedbackPending, error: feedbackError, execute: loadFeedback } = await useAsyncData(
  () => `dashboard-review-feedback:${scope.value?.orgSlug}:${feedbackDays.value}`,
  () => {
    return dashboardApi<ReviewFeedback>('/api/dashboard/review-feedback', {
      query: { days: feedbackDays.value },
      validate: (value): value is ReviewFeedback => {
        const result = reviewFeedbackSchema.safeParse(value)
        if (!result.success) throw new ApiClientError('Invalid guest feedback response', 502, 'INVALID_REVIEW_FEEDBACK_RESPONSE', null)
        return true
      },
    })
  },
  { lazy: true, immediate: false },
)
watch(() => tab.value === 'reviews' ? `${scope.value?.orgSlug}:${feedbackDays.value}` : null, (key) => { if (key) void loadFeedback() }, { immediate: true })
watch([feedback, focusedReview], ([loaded, reviewId]) => {
  if (!import.meta.client || !loaded || !reviewId) return
  void nextTick(() => document.getElementById(`review-${reviewId}`)?.scrollIntoView({ block: 'center' }))
})

const reviews = computed(() => insightsResource.value?.reviews)

// Multi-Vertical Funnel Mapping
type FunnelCounts = Omit<AnalyticsReport['funnel'], 'by_source' | 'by_location'>
const FUNNEL_KEYS = ['visits', 'viewed', 'intent', 'submitted', 'confirmed', 'paid'] as const
const FUNNEL_WORDS = {
  service: { long: ['Visits', 'Viewed a practice area', 'Clicked Book a consultation or called', 'Requested a consultation', 'Scheduled', 'Paid'], short: ['Visits', 'Viewed', 'Clicked or called', 'Requested', 'Scheduled', 'Paid'], confirmedNoun: 'consultation' },
  restaurant: { long: ['Visits', 'Viewed a dish', 'Started a reservation or called', 'Reserved', 'Seated', 'Paid'], short: ['Visits', 'Viewed', 'Started or called', 'Reserved', 'Seated', 'Paid'], confirmedNoun: 'reservation' },
  experience: { long: ['Visits', 'Viewed', 'Started checkout or called', 'Booked', 'Confirmed', 'Paid'], short: ['Visits', 'Viewed', 'Started or called', 'Booked', 'Confirmed', 'Paid'], confirmedNoun: 'booking' },
  lodging: { long: ['Visits', 'Viewed', 'Started checkout or called', 'Booked', 'Confirmed', 'Paid'], short: ['Visits', 'Viewed', 'Started or called', 'Booked', 'Confirmed', 'Paid'], confirmedNoun: 'stay' },
  platform: { long: ['Visits', 'Viewed an offering', 'Showed intent', 'Submitted', 'Confirmed', 'Paid'], short: ['Visits', 'Viewed', 'Intent', 'Submitted', 'Confirmed', 'Paid'], confirmedNoun: 'booking' },
} as const
const dashboard = useDashboardOrganization()
const funnelWords = computed(() => FUNNEL_WORDS[dashboard.organization.value?.vertical ?? 'platform'])

const funnelCell = (counts: FunnelCounts, key: typeof FUNNEL_KEYS[number]) => {
  if (!counts[key]) return '—'
  if (key !== 'paid' || !counts.paid_collected.length) return formatCount(counts[key])
  return `${formatCount(counts.paid)} · ${counts.paid_collected.map(paid => formatMoney(paid.collected_minor, paid.currency)).join(' · ')}`
}

const funnelSteps = computed(() => {
  const funnel = analytics.value?.funnel
  if (!funnel) return []
  return FUNNEL_KEYS.map((key, index) => {
    const previous = index ? funnel[FUNNEL_KEYS[index - 1]!] : 0
    const rate = index && previous && funnel[key] ? ` · ${formatNumber(Math.round(funnel[key] / previous * 1000) / 10)}%` : ''
    return { key, label: funnelWords.value.long[index]!, value: `${funnelCell(funnel, key)}${rate}`, percent: funnel.visits ? funnel[key] / funnel.visits * 100 : 0 }
  })
})

const funnelBreakdowns = computed(() => {
  const funnel = analytics.value?.funnel
  if (!funnel) return []
  const rows = (entries: Array<{ label: string; counts: FunnelCounts }>) => entries.map(({ label, counts }) => ({ label, cells: FUNNEL_KEYS.map(key => funnelCell(counts, key)) }))
  const locationTitle = (id: string | null) => id ? dashboard.locations.value.find(location => location.id === id)?.title ?? 'Removed location' : 'No location'
  return [
    { title: 'Source', testId: 'insights-funnel-by-source', rows: rows(funnel.by_source.map(row => ({ label: row.channel, counts: row }))) },
    ...(dashboard.locations.value.length > 1
      ? [{ title: 'Location', testId: 'insights-funnel-by-location', rows: rows(funnel.by_location.map(row => ({ label: locationTitle(row.location_id), counts: row }))) }]
      : []),
  ].filter(breakdown => breakdown.rows.length)
})

// Metrics strip
const metricCards = computed(() => {
  const metrics = analytics.value?.metrics
  if (!metrics) return []
  return [
    { label: 'Pageviews', value: formatCount(metrics.page_views), subtext: metrics.change_percent === null ? 'Not enough prior data' : `${formatSigned(metrics.change_percent)} vs previous period` },
    { label: 'Unique visitors', value: formatCount(metrics.unique_visitors), subtext: `${formatCount(metrics.returning_visitors)} returning` },
    { label: 'Sessions', value: formatCount(metrics.unique_sessions), subtext: `${formatNumber(metrics.pages_per_session)} pages per session` },
    { label: 'Avg. duration', value: formatDuration(metrics.avg_session_duration), subtext: 'Average session time' }
  ]
})

// Chart series
const dailyData = computed(() => analytics.value?.daily_data || [])
const trafficSeries = computed(() => [
  { label: 'Pageviews', values: dailyData.value.map(day => day.page_views), color: 'var(--ui-primary)' },
  { label: 'Sessions', values: dailyData.value.map(day => day.sessions), color: 'var(--ui-info)' },
])

// Breakdown items formatted for BreakdownTable
const topPagesItems = computed(() => {
  const pages = analytics.value?.top_pages || []
  return pages.map(p => ({
    label: p.path,
    value: p.views,
    formattedValue: formatCount(p.views),
    percent: p.percent_of_total,
  }))
})

const attributionItems = computed(() => {
  const att = analytics.value?.attribution || []
  return att.map(a => ({
    label: `${a.source} / ${a.medium}`,
    detail: [a.campaign, a.content].filter(Boolean).join(' · '),
    value: a.sessions,
    formattedValue: `${formatCount(a.sessions)} sessions · ${formatCount(a.converting_sessions)} conv.`,
    percent: a.session_conversion_rate !== null ? Math.round(a.session_conversion_rate) : 0,
  }))
})

const countryItems = computed(() => {
  const list = analytics.value?.countries || []
  return list.map(c => ({
    label: countryName(c.country_code),
    prefix: countryFlag(c.country_code),
    value: c.views,
    formattedValue: formatCount(c.views),
    percent: c.percent_of_total,
  }))
})

const cityItems = computed(() => {
  const list = analytics.value?.cities || []
  return list.map(c => ({
    label: c.region ? `${c.city}, ${c.region}` : c.city,
    prefix: countryFlag(c.country_code),
    value: c.views,
    formattedValue: formatCount(c.views),
    percent: percentOfViews(c.views),
  }))
})

const deviceItems = computed(() => {
  const list = analytics.value?.devices || []
  return list.map(d => ({
    label: d.type,
    prefix: deviceIcon(d.type),
    value: d.views,
    formattedValue: formatCount(d.views),
    percent: d.percent_of_total,
  }))
})

const referrerItems = computed(() => {
  const list = analytics.value?.referrers || []
  return list.map(r => ({
    label: r.source,
    value: r.views,
    formattedValue: formatCount(r.views),
    percent: r.percent_of_total,
  }))
})

// Instagram metrics
const INSTAGRAM_ACCOUNT_FIELDS = [
  { key: 'views', label: 'Views' }, { key: 'reach', label: 'Accounts reached' }, { key: 'accounts_engaged', label: 'Accounts engaged' },
  { key: 'total_interactions', label: 'Interactions' }, { key: 'likes', label: 'Likes' }, { key: 'comments', label: 'Comments' },
  { key: 'shares', label: 'Shares' }, { key: 'saves', label: 'Saves' }, { key: 'replies', label: 'Replies' }, { key: 'profile_links_taps', label: 'Profile link taps' },
] as const
const MEDIA_FIELDS = [
  { key: 'views', label: 'Views' }, { key: 'reach', label: 'Reach' }, { key: 'likes', label: 'Likes' }, { key: 'comments', label: 'Comments' },
  { key: 'shares', label: 'Shares' }, { key: 'saved', label: 'Saves' },
] as const

const instagramMetricCards = computed(() => {
  if (instagram.value?.status !== 'connected') return []
  const acc = (instagram.value as Extract<InstagramInsights, { status: 'connected' }>).account
  return INSTAGRAM_ACCOUNT_FIELDS.map(f => ({
    label: f.label,
    value: acc[f.key] === null ? '—' : formatCount(acc[f.key]!),
  }))
})

// Google Ads metrics
const adsMetricCards = computed(() => {
  const report = ads.value
  if (!report || report.status !== 'connected') return []
  const { totals, customer } = report
  const costPerConversion = totals.conversions > 0 ? totals.costMicros / totals.conversions : null
  return [
    { label: 'Spend', value: formatMicros(totals.costMicros, customer.currency) },
    { label: 'Clicks', value: formatCount(totals.clicks) },
    { label: 'Impressions', value: formatCount(totals.impressions) },
    { label: 'Conversions', value: formatCount(Math.round(totals.conversions)) },
    { label: 'Avg. CPC', value: formatMicros(totals.averageCpcMicros, customer.currency) },
    { label: 'Cost / conv.', value: costPerConversion === null ? '—' : formatMicros(costPerConversion, customer.currency) },
  ]
})

const FEEDBACK_STATUS_LABELS = { pending: 'Awaiting review', approved: 'Published', rejected: 'Not published', private: 'Private' } as const

// Formatters
function formatMicros(micros: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(micros / 1_000_000)
}
function formatMoney(minor: number, currency: string): string {
  if (!isCurrencyCode(currency)) throw new Error(`Unsupported currency in analytics report: ${currency}`)
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 10 ** currencyFractionDigits(currency))
}
function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}
function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)
}
function formatSigned(value: number): string {
  return value > 0 ? `+${value}%` : `${value}%`
}
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`
}
function formatDate(value: string): string {
  return formatCalendarDate(value, 'en')
}
function countryFlag(countryCode: string): string {
  if (!/^[A-Z]{2}$/.test(countryCode) || countryCode === 'XX') return '🏳'
  return countryCode
    .split('')
    .map(char => String.fromCodePoint(127397 + char.charCodeAt(0)))
    .join('')
}
function countryName(countryCode: string): string {
  if (!/^[A-Z]{2}$/.test(countryCode) || countryCode === 'XX') return 'Unknown'
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode) || countryCode
  } catch {
    return countryCode
  }
}
function deviceIcon(type: string): string {
  if (type === 'Mobile') return '📱'
  if (type === 'Tablet') return '▭'
  if (type === 'Bot') return '◇'
  if (type === 'Desktop') return '▣'
  return '•'
}
function percentOfViews(views: number): number {
  const total = analytics.value?.metrics.page_views || 0
  return total > 0 ? Math.round((views / total) * 100) : 0
}

useSeoMeta({ title: 'Insights | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
</script>
