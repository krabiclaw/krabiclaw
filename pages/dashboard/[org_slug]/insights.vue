<template>
  <!--
    Airbnb's Performance list: each section heading opens its first page, and
    the page opens beside the list, which stays. Which pages there are follows
    what the business books and the kind chosen on the page.
  -->
  <DashboardIndexPanel id="organization-insights" title="Insights" :auto-open="sections[0] ? pageLink(sections[0].pages[0]!.id) : null">
    <UAlert v-if="error" color="error" variant="soft" title="Insights could not be loaded" :description="getErrorMessage(error, 'Insights request failed')" />
    <nav v-else aria-label="Insights pages" class="space-y-4 pb-10" data-testid="insights-pages">
      <div v-for="section in sections" :key="section.id">
        <NuxtLink :to="pageLink(section.pages[0]!.id)" class="block px-3 py-2 text-base font-medium text-highlighted">{{ section.title }}</NuxtLink>
        <ul class="space-y-1">
          <li v-for="page in section.pages" :key="page.id">
            <NuxtLink
              :to="pageLink(page.id)"
              class="block rounded-full px-4 py-2 text-sm"
              :class="current === page.id ? 'bg-inverted text-inverted' : 'text-muted hover:bg-elevated hover:text-highlighted'"
              :aria-current="current === page.id ? 'page' : undefined"
              :data-testid="`insights-page-${page.id.replace('/', '-')}`"
            >
              {{ page.title }}
            </NuxtLink>
          </li>
        </ul>
      </div>
    </nav>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { INSIGHTS_KINDS, INSIGHTS_PAGES, insightsIndexSchema, pageShown, pageTitle, sectionTitle, type InsightsIndex, type InsightsKindFilter, type InsightsPageId } from '~/shared/insights'

definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'menu' })

const route = useRoute()
const dashboardApi = useDashboardApi()
const recentOrRead = useInsightsRead()
const isIndex = (value: unknown): value is InsightsIndex => insightsIndexSchema.safeParse(value).success

const { data, error } = await useAsyncData(
  () => `insights-index:${String(route.params.org_slug)}`,
  () => recentOrRead(`index:${String(route.params.org_slug)}`, () => dashboardApi<InsightsIndex>('/api/dashboard/insights', { validate: isIndex }), isIndex),
)

const kind = computed<InsightsKindFilter>(() => (INSIGHTS_KINDS as readonly string[]).includes(String(route.query.kind)) ? route.query.kind as InsightsKindFilter : 'all')
const current = computed(() => route.params.section && route.params.page ? `${String(route.params.section)}/${String(route.params.page)}` : null)
const sections = computed(() => {
  const index = data.value
  if (!index) return []
  const pages = INSIGHTS_PAGES.filter(page => index.pages.includes(page.id) && pageShown(page, index.kinds, kind.value))
  return [...new Set(pages.map(page => page.section))].map(section => ({
    id: section,
    title: sectionTitle(section, index.kinds, kind.value),
    pages: pages.filter(page => page.section === section).map(page => ({ id: page.id, title: pageTitle(page.id, index.kinds, kind.value) })),
  }))
})

/** A page keeps the filters chosen; the number shown is the new page's first. */
function pageLink(id: InsightsPageId) {
  const { metric: _metric, review: _review, ...filters } = route.query
  const page = INSIGHTS_PAGES.find(candidate => candidate.id === id)!
  const kept = page.filters === 'range' ? { start_date: filters.start_date, end_date: filters.end_date }
    : page.filters === 'kind' ? { kind: filters.kind, start_date: filters.start_date, end_date: filters.end_date } : filters
  return { path: `/dashboard/${String(route.params.org_slug)}/insights/${id}`, query: kept }
}

useSeoMeta({ title: 'Insights', robots: 'noindex, nofollow' })
</script>
