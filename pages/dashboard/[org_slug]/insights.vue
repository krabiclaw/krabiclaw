<template>
  <!--
    Airbnb's Performance: the list of pages on the left and the page beside it,
    one screen. The list never closes; on a narrow screen it opens from the
    page's ≡ button. It lists every page the business's offerings support,
    whatever the filters are.
  -->
  <UDashboardPanel id="organization-insights" :ui="{ body: 'p-0 sm:p-0 gap-0' }">
    <template #body>
      <DefineList>
        <UAlert v-if="error" color="error" variant="soft" title="Insights could not be loaded" :description="getErrorMessage(error, 'Insights request failed')" />
        <nav v-else aria-label="Insights pages" class="space-y-3" data-testid="insights-pages">
          <div v-for="section in sections" :key="section.id">
            <p class="px-3 py-2 font-medium text-highlighted">{{ section.title }}</p>
            <ul class="space-y-1">
              <li v-for="page in section.pages" :key="page.id">
                <NuxtLink
                  :to="pageLink(page.id)"
                  class="block rounded-full px-4 py-2 text-sm"
                  :class="current === page.id ? 'bg-inverted text-inverted' : 'text-muted hover:bg-elevated hover:text-highlighted'"
                  :aria-current="current === page.id ? 'page' : undefined"
                  :data-testid="`insights-page-${page.id.replace('/', '-')}`"
                  @click="listOpen = false"
                >
                  {{ page.title }}
                </NuxtLink>
              </li>
            </ul>
          </div>
        </nav>
      </DefineList>
      <div class="grid min-h-full md:grid-cols-[16rem_minmax(0,1fr)]">
        <aside class="hidden border-e border-default px-3 py-6 md:block">
          <h1 class="px-3 pb-4 text-2xl font-semibold text-highlighted">Insights</h1>
          <ReuseList />
        </aside>
        <div class="min-w-0">
          <NuxtPage />
        </div>
      </div>
      <USlideover v-model:open="listOpen" side="left" title="Insights" :ui="{ content: 'max-w-xs' }">
        <template #body>
          <ReuseList />
        </template>
      </USlideover>
    </template>
  </UDashboardPanel>
</template>

<script setup lang="ts">
import { createReusableTemplate } from '@vueuse/core'
import { insightsIndexSchema, type InsightsIndex, type InsightsPageId } from '~/shared/insights'
import { insightsListKey } from '~/composables/useInsightsRead'

definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'menu' })

const [DefineList, ReuseList] = createReusableTemplate()
const route = useRoute()
const dashboardApi = useDashboardApi()
const recentOrRead = useInsightsRead()
const isIndex = (value: unknown): value is InsightsIndex => insightsIndexSchema.safeParse(value).success

const { data, error } = await useLazyAsyncData(
  () => `insights-index:${String(route.params.org_slug)}`,
  () => recentOrRead(`index:${String(route.params.org_slug)}`, () => dashboardApi<InsightsIndex>('/api/dashboard/insights', { validate: isIndex }), isIndex),
)

const listOpen = ref(false)
provide(insightsListKey, () => { listOpen.value = true })

const current = computed(() => route.params.section && route.params.page ? `${String(route.params.section)}/${String(route.params.page)}` : null)
const sections = computed(() => data.value?.sections ?? [])

/** A page keeps the date range; the offering chosen and the number shown belong to the page left. */
function pageLink(id: InsightsPageId) {
  return { path: `/dashboard/${String(route.params.org_slug)}/insights/${id}`, query: { start_date: route.query.start_date, end_date: route.query.end_date } }
}

// Insights opens on its first page, as Airbnb's Performance does.
if (!current.value) await navigateTo(pageLink('quality/overall-rating'), { replace: true })
watch(current, (page) => { if (!page) void navigateTo(pageLink('quality/overall-rating'), { replace: true }) })

useSeoMeta({ title: 'Insights', robots: 'noindex, nofollow' })
</script>
