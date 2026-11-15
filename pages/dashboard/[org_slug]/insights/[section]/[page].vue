<template>
  <!--
    One Insights page, beside the list, as Airbnb's Performance page: its
    title, two chips (what is shown and when), two or three headline numbers
    that each switch the chart, the chart of the chosen number over time, and
    the list underneath. Filters and the chosen number are in the URL, so Back
    returns to the number and range that were shown.
  -->
  <div :id="`insights-${pageId.replace('/', '-')}`" class="space-y-8 px-4 pb-12 pt-6 sm:px-8">
    <div class="space-y-4">
      <div class="flex items-center gap-3">
        <UButton class="md:hidden" icon="i-lucide-menu" color="neutral" variant="ghost" aria-label="Insights pages" @click="openList()" />
        <h1 class="text-2xl font-semibold text-highlighted">{{ view?.title ?? fallbackTitle }}</h1>
      </div>
      <p v-if="view?.subtitle" class="text-sm text-muted">{{ view.subtitle }}</p>
      <div class="flex flex-wrap items-center gap-2">
        <UPopover v-if="kindItems.length > 1 || locationItems.length > 1" :content="{ align: 'start', side: 'bottom', sideOffset: 8 }">
          <button type="button" class="inline-flex h-9 items-center rounded-full border border-default bg-default px-3.5 text-xs font-medium text-highlighted shadow-xs hover:border-accented" data-testid="insights-offering-pill">
            {{ selectionLabel }}
          </button>
          <template #content>
            <div class="w-72 space-y-4 p-4 text-sm">
              <URadioGroup v-if="kindItems.length > 1" v-model="kindFilter" legend="What" :items="kindItems" />
              <URadioGroup v-if="locationItems.length > 1" v-model="locationFilter" legend="Location" :items="locationItems" />
            </div>
          </template>
        </UPopover>
        <DateRangeFilterPill :start-date="period?.start_date ?? ''" :end-date="period?.end_date ?? ''" :default-days="30" @update:range="setRange" />
      </div>
      <p v-if="menuNote" class="text-sm text-muted">Your menu is not booked, so its dishes count only under Page views and Top pages.</p>
    </div>

    <UAlert v-if="error" color="error" variant="soft" :title="`${fallbackTitle} could not be loaded`" :description="getErrorMessage(error, 'Insights request failed')" />
    <UAlert v-else-if="view?.unavailable" color="neutral" variant="soft" :description="view.unavailable.message" :actions="[{ label: view.unavailable.action, to: view.unavailable.to }]" />
    <template v-else-if="view">
      <p v-if="view.note" class="text-sm text-muted">{{ view.note }}</p>
      <dl class="flex flex-wrap gap-x-10 gap-y-5" data-testid="insights-metrics">
        <div v-for="metric in view.metrics" :key="metric.key" class="flex min-w-32 flex-col-reverse">
          <dt class="text-sm">
            <NuxtLink v-if="metric.daily" :to="{ query: { ...route.query, metric: metric.key } }" class="underline underline-offset-4" :class="metric.key === selected?.key ? 'font-semibold text-highlighted' : 'text-muted'" :aria-current="metric.key === selected?.key ? 'true' : undefined" :data-testid="`insights-metric-link-${metric.key}`">{{ metric.label }}</NuxtLink>
            <span v-else class="text-muted">{{ metric.label }}</span>
          </dt>
          <dd class="text-3xl font-semibold tabular-nums text-highlighted" :data-testid="`insights-metric-${metric.key}`">{{ metric.display }}</dd>
        </div>
      </dl>

      <section v-if="selected" class="space-y-5 rounded-2xl bg-muted p-6" data-testid="insights-chart">
        <h2 class="text-xl font-semibold text-highlighted">{{ selected.label }}</h2>
        <UFormField label="Compare" class="max-w-xs">
          <USelect :model-value="'over_time'" :items="[{ label: 'Over time', value: 'over_time' }]" class="w-full" />
        </UFormField>
        <AnalyticsTrendChart :label="`${selected.label} over time`" :dates="view.dates" :series="[{ label: selected.label, values: selected.daily!, color: 'var(--ui-text-highlighted)' }]" :format="selected.format" />
      </section>

      <section v-if="view.reviews" class="divide-y divide-default" data-testid="insights-reviews">
        <article v-for="review in view.reviews" :id="`review-${review.id}`" :key="review.id" class="py-4" :class="focusedReview === review.id ? 'rounded-lg bg-elevated px-3' : ''" :data-testid="`insights-review-${review.id}`">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span class="font-medium text-highlighted">{{ review.author }}</span>
            <span class="text-sm text-highlighted" :aria-label="`${review.rating} out of 5`">{{ '★'.repeat(review.rating) }}</span>
            <UBadge v-if="review.status !== 'approved'" color="neutral" variant="soft" size="xs" :label="REVIEW_STATUS[review.status]" />
            <span class="text-xs text-muted">{{ [review.subject, formatDate(review.date)].filter(Boolean).join(' · ') }}</span>
          </div>
          <p v-if="review.categories.length" class="mt-1 text-xs text-muted">{{ review.categories.map(category => `${category.label} ${category.rating}`).join(' · ') }}</p>
          <p v-if="review.title" class="mt-2 font-medium text-highlighted">{{ review.title }}</p>
          <p v-if="review.content" class="mt-1 text-sm text-muted">{{ review.content }}</p>
          <div v-if="review.private_feedback" class="mt-2 rounded-md bg-muted px-3 py-2">
            <p class="text-xs font-medium text-highlighted">Private feedback</p>
            <p class="mt-1 whitespace-pre-line text-sm text-muted">{{ review.private_feedback }}</p>
          </div>
        </article>
        <p v-if="!view.reviews.length" class="py-4 text-sm text-muted">Once a guest reviews a visit in this range, the review will appear here.</p>
      </section>
      <table v-else-if="view.table" class="w-full text-left text-sm" data-testid="insights-list">
        <thead class="border-b border-default text-xs text-muted">
          <tr>
            <th scope="col" class="pb-2.5 font-medium">{{ view.table.heading }}</th>
            <th v-for="column in view.table.columns" :key="column" scope="col" class="pb-2.5 pl-4 text-right font-medium">{{ column }}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr v-for="row in view.table.rows" :key="row.key">
            <td class="max-w-0 py-2.5 pr-4 break-words text-highlighted">{{ row.label }}</td>
            <td v-for="(cell, index) in row.cells" :key="index" class="py-2.5 pl-4 text-right tabular-nums">{{ cell }}</td>
          </tr>
          <tr v-if="!view.table.rows.length"><td :colspan="view.table.columns.length + 1" class="py-4 text-muted">Nothing in this range matches these filters.</td></tr>
        </tbody>
      </table>
    </template>
  </div>
</template>

<script setup lang="ts">
import AnalyticsTrendChart from '~/components/dashboard/AnalyticsTrendChart.vue'
import DateRangeFilterPill from '~/components/dashboard/insights/DateRangeFilterPill.vue'
import { paymentMoney } from '~/shared/payment-display'
import { formatCalendarDate, localDateAt } from '~/utils/timezone'
import { INSIGHTS_KINDS, INSIGHTS_KIND_LABELS, insightsPage, insightsPageSchema, pageShown, pageTitle, type InsightsFormat, type InsightsIndex, type InsightsKind, type InsightsPage, type InsightsReview } from '~/shared/insights'
import { instagramInsightsSchema, type InstagramInsights } from '~/shared/instagram-insights'
import { googleAdsInsightsSchema, type GoogleAdsInsights } from '~/shared/google-ads-insights'
import { insightsListKey } from '~/composables/useInsightsRead'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const router = useRouter()
const dashboardApi = useDashboardApi()
const recentOrRead = useInsightsRead()
const orgSlug = computed(() => String(route.params.org_slug))
const pageId = computed(() => `${String(route.params.section)}/${String(route.params.page)}`)
const definition = computed(() => insightsPage(pageId.value))
if (!definition.value) throw createError({ statusCode: 404, statusMessage: 'Insights page not found', fatal: true })
const index = useNuxtData<InsightsIndex>(`insights-index:${orgSlug.value}`).data
// The kinds this page reads: the business's bookings of the kinds the page is about.
const booked = computed<InsightsKind[]>(() => (index.value?.kinds ?? []).filter(kind => !definition.value!.kinds || (definition.value!.kinds as readonly string[]).includes(kind)))
const openList = inject(insightsListKey, () => {})
// A page about kinds the business does not book is not one of its pages.
if (index.value && !pageShown(definition.value!, index.value.kinds)) throw createError({ statusCode: 404, statusMessage: 'Insights page not found', fatal: true })

// The filters this page reads, from the URL; the rest are not offered.
const queryText = (name: string) => typeof route.query[name] === 'string' && route.query[name] ? route.query[name] as string : undefined
const filters = computed(() => {
  const page = definition.value!
  const kind = page.filters === 'range' ? undefined : queryText('kind')
  return { kind, location_id: page.filters === 'kind_location' ? queryText('location_id') : undefined, start_date: queryText('start_date'), end_date: queryText('end_date') }
})
const readKey = computed(() => `${orgSlug.value}:${pageId.value}:${filters.value.kind ?? 'all'}:${filters.value.location_id ?? ''}:${filters.value.start_date ?? ''}:${filters.value.end_date ?? ''}`)

type Read = { kind: 'stored'; page: InsightsPage } | { kind: 'instagram'; page: InstagramInsights } | { kind: 'ads'; page: GoogleAdsInsights }
const isRead = (value: unknown): value is Read => isRecord(value) && (
  (value.kind === 'stored' && insightsPageSchema.safeParse(value.page).success)
  || (value.kind === 'instagram' && instagramInsightsSchema.safeParse(value.page).success)
  || (value.kind === 'ads' && googleAdsInsightsSchema.safeParse(value.page).success))
const { data, error } = await useAsyncData(() => `insights:${readKey.value}`, () => recentOrRead(readKey.value, async (): Promise<Read> => {
  const range = { start_date: filters.value.start_date, end_date: filters.value.end_date }
  // The Marketing pages are read from Instagram and Google Ads as they open.
  if (pageId.value === 'marketing/instagram') return { kind: 'instagram', page: await dashboardApi<InstagramInsights>('/api/dashboard/instagram-insights', { query: range, validate: (value): value is InstagramInsights => instagramInsightsSchema.safeParse(value).success }) }
  if (pageId.value === 'marketing/google-ads') return { kind: 'ads', page: await dashboardApi<GoogleAdsInsights>('/api/dashboard/google-ads-insights', { query: range, validate: (value): value is GoogleAdsInsights => googleAdsInsightsSchema.safeParse(value).success }) }
  return { kind: 'stored', page: await dashboardApi<InsightsPage>(`/api/dashboard/insights/${pageId.value}`, { query: filters.value, validate: (value): value is InsightsPage => insightsPageSchema.safeParse(value).success }) }
}, isRead))

// Every page reads as the same shape: numbers with their days, and a list.
interface ViewMetric { key: string; label: string; display: string; daily: Array<number | null> | null; format: (value: number) => string }
interface View {
  title: string; subtitle: string | null; note: string | null; dates: string[]; metrics: ViewMetric[]
  reviews: InsightsReview[] | null; table: { heading: string; columns: string[]; rows: Array<{ key: string; label: string; cells: string[] }> } | null
  unavailable: { message: string; action: string; to: string } | null
}
const count = (value: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)
function formatter(format: InsightsFormat, currency: string | null): (value: number) => string {
  if (format === 'percent') return value => `${count(value)}%`
  if (format === 'rating') return value => new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(value)
  if (format === 'money') return value => paymentMoney(Math.round(value), currency)
  if (format === 'nights') return value => `${count(value)} ${value === 1 ? 'night' : 'nights'}`
  if (format === 'days') return value => `${count(value)} ${value === 1 ? 'day' : 'days'}`
  return count
}
const micros = (currency: string) => (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value / 1_000_000)
const daysOf = (start: string, end: string) => { const dates: string[] = []; for (let date = start; date <= end; date = addDay(date)) dates.push(date); return dates }
const addDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

const view = computed<View | null>(() => {
  const read = data.value
  if (!read) return null
  if (read.kind === 'stored') {
    const page = read.page
    const metrics = page.metrics.map((metric) => {
      const format = formatter(metric.format, page.currency)
      return { key: metric.key, label: metric.label, format, daily: page.series.values[metric.key] ?? null,
        display: metric.format === 'text' ? metric.text ?? '—' : metric.value === null ? '—' : format(metric.value) }
    })
    const list = page.list
    return { title: page.title, subtitle: page.subtitle, note: null, dates: page.series.dates, metrics, unavailable: null,
      reviews: list.kind === 'reviews' ? list.reviews : null,
      table: list.kind === 'rows' ? { heading: list.heading, columns: list.columns.map(column => column.label),
        rows: list.rows.map(row => ({ key: row.key, label: page.page === 'conversion/page-views' ? formatDate(row.label) : row.label,
          cells: row.values.map((value, position) => value === null ? '—' : formatter(list.columns[position]!.format, page.currency)(value)) })) } : null }
  }
  if (read.kind === 'instagram') {
    const page = read.page
    if (page.status !== 'connected') return { ...emptyView('Instagram'), unavailable: { message: page.message, action: 'Instagram settings', to: `/dashboard/${orgSlug.value}/integrations/instagram` } }
    const dates = daysOf(page.period.startDate, page.period.endDate)
    const posted = dates.map(date => page.media.filter(post => localDateAt(new Date(post.postedAt), page.period.timezone) === date).length)
    const total = (value: number | null) => value === null ? '—' : count(value)
    return { ...emptyView('Instagram'), note: `@${page.username} · Instagram reports its numbers up to 48 hours late.`, dates,
      metrics: [
        { key: 'posts', label: 'Posts published', display: count(page.media.length), daily: posted, format: count },
        { key: 'reach', label: 'Accounts reached', display: total(page.account.reach), daily: null, format: count },
        { key: 'views', label: 'Views', display: total(page.account.views), daily: null, format: count },
      ],
      table: { heading: 'Post', columns: ['Views', 'Reach'], rows: page.media.map(post => ({ key: post.id, label: post.caption || 'Untitled post',
        cells: post.insights ? [total(post.insights.views), total(post.insights.reach)] : ['—', '—'] })) } }
  }
  const page = read.page
  if (page.status !== 'connected') return { ...emptyView('Google Ads'), unavailable: { message: page.message, action: 'Google Ads settings', to: `/dashboard/${orgSlug.value}/integrations/google-ads` } }
  const dates = daysOf(page.period.startDate, page.period.endDate)
  const day = (field: 'costMicros' | 'clicks' | 'conversions') => dates.map(date => page.days.find(entry => entry.date === date)?.[field] ?? 0)
  const money = micros(page.customer.currency)
  return { ...emptyView('Google Ads'), note: `${page.customer.name} · Spend is as Google Ads reports it.`, dates,
    metrics: [
      { key: 'spend', label: 'Spend', display: money(page.totals.costMicros), daily: day('costMicros'), format: money },
      { key: 'clicks', label: 'Clicks', display: count(page.totals.clicks), daily: day('clicks'), format: count },
      { key: 'conversions', label: 'Conversions', display: count(page.totals.conversions), daily: day('conversions'), format: count },
    ],
    table: { heading: 'Campaign', columns: ['Spend', 'Clicks'], rows: page.campaigns.map(campaign => ({ key: campaign.id, label: campaign.name, cells: [money(campaign.costMicros), count(campaign.clicks)] })) } }
})
function emptyView(title: string): View {
  return { title, subtitle: null, note: null, dates: [], metrics: [], reviews: null, table: null, unavailable: null }
}
const fallbackTitle = computed(() => pageTitle(definition.value!.id, booked.value, (filters.value.kind ?? 'all') as InsightsKind | 'all'))
const selected = computed(() => {
  const linkable = (view.value?.metrics ?? []).filter(metric => metric.daily)
  return linkable.find(metric => metric.key === route.query.metric) ?? linkable[0] ?? null
})
const period = computed(() => {
  const read = data.value
  if (!read) return null
  if (read.kind === 'stored') return read.page.period
  return 'period' in read.page ? { start_date: read.page.period.startDate, end_date: read.page.period.endDate } : null
})

// One chip names what is shown and opens the choice of kind and location; filters are links in history.
const kindItems = computed(() => definition.value!.filters === 'range' || booked.value.length < 2 ? []
  : [{ value: 'all', label: 'All offerings' }, ...INSIGHTS_KINDS.filter(kind => booked.value.includes(kind)).map(kind => ({ value: kind, label: INSIGHTS_KIND_LABELS[kind] }))])
const locationItems = computed(() => definition.value!.filters !== 'kind_location' || (index.value?.locations.length ?? 0) < 2 ? []
  : [{ value: 'all', label: 'All locations' }, ...index.value!.locations.map(location => ({ value: location.id, label: location.title }))])
const selectionLabel = computed(() => [
  kindItems.value.find(item => item.value === kindFilter.value)?.label ?? 'All offerings',
  locationFilter.value === 'all' ? null : locationItems.value.find(item => item.value === locationFilter.value)?.label,
].filter(Boolean).join(' · '))
const kindFilter = computed({
  get: () => filters.value.kind ?? 'all',
  set: (kind: string) => void router.push({ query: { ...route.query, kind: kind === 'all' ? undefined : kind, metric: undefined } }),
})
const locationFilter = computed({
  get: () => filters.value.location_id ?? 'all',
  set: (location: string) => void router.push({ query: { ...route.query, location_id: location === 'all' ? undefined : location } }),
})
function setRange(range: { startDate: string; endDate: string }) {
  void router.push({ query: { ...route.query, start_date: range.startDate, end_date: range.endDate } })
}
const menuNote = computed(() => index.value?.has_menu === true && (definition.value!.section === 'rates' || pageId.value === 'conversion/booking-conversion'))

const REVIEW_STATUS = { pending: 'Awaiting review', approved: 'Published', rejected: 'Not published', private: 'Private' } as const
const focusedReview = computed(() => typeof route.query.review === 'string' ? route.query.review : null)
watch([view, focusedReview], ([loaded, reviewId]) => {
  if (!import.meta.client || !loaded || !reviewId) return
  void nextTick(() => document.getElementById(`review-${reviewId}`)?.scrollIntoView({ block: 'center' }))
}, { immediate: true })
function formatDate(value: string) { return formatCalendarDate(value, 'en') }

useSeoMeta({ title: () => `${view.value?.title ?? fallbackTitle.value} - Insights`, robots: 'noindex, nofollow' })
</script>
