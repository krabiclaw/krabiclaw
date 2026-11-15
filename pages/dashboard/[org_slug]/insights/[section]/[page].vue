<template>
  <!--
    One Insights page, beside the list, as Airbnb's Performance page: its
    title, two chips (what is shown and when), two or three headline numbers
    that each switch the chart, the chart of the chosen number over time, and
    the list underneath. Every string comes composed in the page's one read.
    Filters and the chosen number are in the URL, so Back returns to the number
    and range that were shown.
  -->
  <div :id="`insights-${pageId.replace('/', '-')}`" class="space-y-8 px-4 pb-12 pt-6 sm:px-8">
    <div class="space-y-4">
      <div class="flex items-center gap-3">
        <UButton class="md:hidden" icon="i-lucide-menu" color="neutral" variant="ghost" aria-label="Insights pages" @click="openList()" />
        <h1 class="text-2xl font-semibold text-highlighted">{{ title }}</h1>
      </div>
      <p v-if="page?.subtitle" class="text-sm text-muted">{{ page.subtitle }}</p>
      <div class="flex flex-wrap items-center gap-2">
        <UPopover v-if="page?.filters.offering" :content="{ align: 'start', side: 'bottom', sideOffset: 8 }">
          <button type="button" class="inline-flex h-9 items-center rounded-full border border-default bg-default px-3.5 text-xs font-medium text-highlighted shadow-xs hover:border-accented" data-testid="insights-offering-pill">
            {{ page.filters.offering.label }}
          </button>
          <template #content>
            <div class="w-72 space-y-4 p-4 text-sm">
              <URadioGroup v-for="choice in page.filters.offering.choices" :key="choice.param" :model-value="choice.selected" :legend="choice.legend" :items="choice.options" @update:model-value="choose(choice.param, String($event))" />
            </div>
          </template>
        </UPopover>
        <DateRangeFilterPill :range="page?.filters.range ?? null" :default-days="30" @update:range="setRange" />
      </div>
      <p v-if="page?.note && !page.action" class="text-sm text-muted">{{ page.note }}</p>
    </div>

    <UAlert v-if="error" color="error" variant="soft" :title="`${title} could not be loaded`" :description="getErrorMessage(error, 'Insights request failed')" />
    <UAlert v-else-if="page?.action" color="neutral" variant="soft" :description="page.note ?? undefined" :actions="[page.action]" />
    <template v-else-if="page">
      <dl class="flex flex-wrap gap-x-10 gap-y-5" data-testid="insights-metrics">
        <div v-for="metric in page.metrics" :key="metric.key" class="flex min-w-32 flex-col-reverse">
          <dt class="text-sm">
            <NuxtLink v-if="metric.chartable" :to="{ query: { ...route.query, metric: metric.key } }" class="underline underline-offset-4" :class="metric.key === selected?.key ? 'font-semibold text-highlighted' : 'text-muted'" :aria-current="metric.key === selected?.key ? 'true' : undefined" :data-testid="`insights-metric-link-${metric.key}`">{{ metric.label }}</NuxtLink>
            <span v-else class="text-muted">{{ metric.label }}</span>
          </dt>
          <dd class="text-3xl font-semibold tabular-nums text-highlighted" :data-testid="`insights-metric-${metric.key}`">{{ metric.display }}</dd>
        </div>
      </dl>

      <section v-if="selected" class="space-y-5 rounded-2xl bg-muted p-6" data-testid="insights-chart">
        <h2 class="text-xl font-semibold text-highlighted">{{ selected.label }}</h2>
        <AnalyticsTrendChart :label="`${selected.label} over time`" :dates="page.series.dates" :chart="page.series.charts[selected.key]!" />
      </section>

      <section v-if="page.list?.kind === 'reviews'" class="divide-y divide-default" data-testid="insights-reviews">
        <article v-for="review in page.list.reviews" :id="`review-${review.id}`" :key="review.id" class="py-4" :class="focusedReview === review.id ? 'rounded-lg bg-elevated px-3' : ''" :data-testid="`insights-review-${review.id}`">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span class="font-medium text-highlighted">{{ review.author }}</span>
            <span class="text-sm text-highlighted" :aria-label="`${review.rating} out of 5`">{{ '★'.repeat(review.rating) }}</span>
            <UBadge v-if="review.status" color="neutral" variant="soft" size="xs" :label="review.status" />
            <span class="text-xs text-muted">{{ review.line }}</span>
          </div>
          <p v-if="review.categories" class="mt-1 text-xs text-muted">{{ review.categories }}</p>
          <p v-if="review.title" class="mt-2 font-medium text-highlighted">{{ review.title }}</p>
          <p v-if="review.content" class="mt-1 text-sm text-muted">{{ review.content }}</p>
          <div v-if="review.private_feedback" class="mt-2 rounded-md bg-muted px-3 py-2">
            <p class="text-xs font-medium text-highlighted">Private feedback</p>
            <p class="mt-1 whitespace-pre-line text-sm text-muted">{{ review.private_feedback }}</p>
          </div>
        </article>
        <p v-if="!page.list.reviews.length" class="py-4 text-sm text-muted">{{ page.list.empty }}</p>
      </section>
      <table v-else-if="page.list?.kind === 'rows'" class="w-full text-left text-sm" data-testid="insights-list">
        <thead class="border-b border-default text-xs text-muted">
          <tr>
            <th scope="col" class="pb-2.5 font-medium">{{ page.list.heading }}</th>
            <th v-for="column in page.list.columns" :key="column.label" scope="col" class="pb-2.5 pl-4 text-right font-medium">{{ column.label }}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr v-for="row in page.list.rows" :key="row.key">
            <td class="max-w-0 py-2.5 pr-4 break-words text-highlighted">{{ row.label }}</td>
            <td v-for="(cell, index) in row.cells" :key="index" class="py-2.5 pl-4 text-right tabular-nums">{{ cell }}</td>
          </tr>
          <tr v-if="!page.list.rows.length"><td :colspan="page.list.columns.length + 1" class="py-4 text-muted">{{ page.list.empty }}</td></tr>
        </tbody>
      </table>
    </template>
  </div>
</template>

<script setup lang="ts">
import AnalyticsTrendChart from '~/components/dashboard/AnalyticsTrendChart.vue'
import DateRangeFilterPill from '~/components/dashboard/insights/DateRangeFilterPill.vue'
import { insightsPageSchema, type InsightsIndex, type InsightsPage } from '~/shared/insights'
import { insightsListKey } from '~/composables/useInsightsRead'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const router = useRouter()
const dashboardApi = useDashboardApi()
const recentOrRead = useInsightsRead()
const orgSlug = computed(() => String(route.params.org_slug))
const pageId = computed(() => `${String(route.params.section)}/${String(route.params.page)}`)
const index = useNuxtData<InsightsIndex>(`insights-index:${orgSlug.value}`).data
const listed = computed(() => index.value?.sections.flatMap(section => section.pages).find(page => page.id === pageId.value) ?? null)
// A page the list does not offer is not one of this business's pages.
if (index.value && !listed.value) throw createError({ statusCode: 404, statusMessage: 'Insights page not found', fatal: true })
const openList = inject(insightsListKey, () => {})

const queryText = (name: string) => typeof route.query[name] === 'string' && route.query[name] ? route.query[name] as string : undefined
const filters = computed(() => ({ kind: queryText('kind'), location_id: queryText('location_id'), start_date: queryText('start_date'), end_date: queryText('end_date') }))
const readKey = computed(() => `${orgSlug.value}:${pageId.value}:${filters.value.kind ?? 'all'}:${filters.value.location_id ?? ''}:${filters.value.start_date ?? ''}:${filters.value.end_date ?? ''}`)
const isPage = (value: unknown): value is InsightsPage => insightsPageSchema.safeParse(value).success
const { data: page, error } = await useAsyncData(() => `insights:${readKey.value}`, () => recentOrRead(readKey.value,
  () => dashboardApi<InsightsPage>(`/api/dashboard/insights/${pageId.value}`, { query: filters.value, validate: isPage }), isPage))

const title = computed(() => page.value?.title ?? listed.value?.title ?? '')
const selected = computed(() => {
  const chartable = (page.value?.metrics ?? []).filter(metric => metric.chartable)
  return chartable.find(metric => metric.key === route.query.metric) ?? chartable[0] ?? null
})

// Each choice is a link in history; a kind reads its own numbers, so the chosen one is dropped.
function choose(param: 'kind' | 'location_id', value: string) {
  void router.push({ query: { ...route.query, [param]: value === 'all' ? undefined : value, ...(param === 'kind' ? { metric: undefined } : {}) } })
}
function setRange(range: { startDate: string; endDate: string }) {
  void router.push({ query: { ...route.query, start_date: range.startDate, end_date: range.endDate } })
}

const focusedReview = computed(() => typeof route.query.review === 'string' ? route.query.review : null)
watch([page, focusedReview], ([loaded, reviewId]) => {
  if (!import.meta.client || !loaded || !reviewId) return
  void nextTick(() => document.getElementById(`review-${reviewId}`)?.scrollIntoView({ block: 'center' }))
}, { immediate: true })

useSeoMeta({ title: () => `${title.value} - Insights`, robots: 'noindex, nofollow' })
</script>
