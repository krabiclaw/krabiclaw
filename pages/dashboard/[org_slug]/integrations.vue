<template>
  <!--
    What the business is connected to: the syncs that keep two sides in step
    on their own, then the accounts linked once and used from here. Each row
    is one product with its own connection; the two Google products may use
    the same linked Google account, which is not a row. A row the plan lacks
    says which plan includes it; its leaf makes the offer.
  -->
  <DashboardIndexPanel id="organization-integrations" title="Connections" :auto-open="items[0]?.to ?? null">
    <!-- A summary that could not be read says so; the rows stay, each with what it knows, so a connection can still be opened and repaired. -->
    <UAlert v-if="error" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="error.message" />
    <p v-else class="mb-6 text-base text-muted">Connect the accounts you already use. A sync keeps both sides in step for you.</p>
    <UTabs v-model="plan" :items="planTabs" :content="false" color="neutral" variant="pill" size="sm" class="mb-6" />
    <EditorNavigationList :groups="groups" :active-item="level.child.value" />
  </DashboardIndexPanel>
</template>
<script lang="ts">
import type { InjectionKey, Ref } from 'vue'
/** A connected Page, account, property, site or channel, as the settings payload names it. */
export interface ConnectedIntegration {
  account_id: string
  target_id: string
  target_name: string
  measurement_id: string | null
  verified: boolean | null
  status: 'active' | 'disabled' | 'error' | null
  last_error: string | null
  connected_at: string
  /** Whose linked account the connection acts through. */
  connected_through: { email: string | null; name: string | null } | null
}
export interface IntegrationsSummary {
  google_maps: Array<{
    id: string
    slug: string
    title: string
    address: string | null
    phone: string | null
    website_url: string | null
    image: string | null
    google_place_id: string | null
    rating: number | null
    review_count: number | null
    last_synced_at: string | null
  }>
  google_calendar: { account_id: string; calendar_name: string; status: 'active' | 'disabled' | 'error'; last_error: string | null; connected_at: string; connected_through: { email: string | null; name: string | null } | null } | null
  google_analytics: ConnectedIntegration | null
  google_ads: ConnectedIntegration | null
  meta_ads: ConnectedIntegration | null
  google_search_console: ConnectedIntegration | null
  facebook: ConnectedIntegration | null
  instagram: ConnectedIntegration | null
  discord: ConnectedIntegration | null
  airbnb: { status: string; connected_at: string | null } | null
}
/** The summary the list shows, and what a leaf refreshes after it changes a connection. */
export const integrationsKey = Symbol('integrations') as InjectionKey<{
  organizationId: string
  summary: Ref<IntegrationsSummary | undefined>
  /** Why the summary could not be read; a leaf shows it rather than waiting on it. */
  failure: Ref<string>
  refresh: () => Promise<void>
}>
</script>
<script setup lang="ts">
import EditorNavigationList from '~/components/dashboard/EditorNavigationList.vue'
import type { CatalogRow, CatalogScreen } from '~/shared/catalog-screen'
definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'menu' })
useSeoMeta({ title: 'Connections | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
const route = useRoute()
const level = useRouteLevel()
const dashboardApi = useDashboardApi()
const organizationId = useDashboardOrganizationId()
type ConnectionRow = CatalogRow & { group: 'sync' | 'connection'; plan: string | null; to: string }
const isSummaryResponse = (value: unknown): value is { settings: { integrations: IntegrationsSummary }; connections: ConnectionRow[]; connectionGroups: NonNullable<CatalogScreen['groups']>; connectionFilters: NonNullable<CatalogScreen['filters']> } =>
  isRecord(value) && isRecord(value.settings) && isRecord(value.settings.integrations)
  && Array.isArray(value.settings.integrations.google_maps) && Array.isArray(value.connections)
  && Array.isArray(value.connectionGroups) && Array.isArray(value.connectionFilters)
const { data, error, refresh } = await useAsyncData(
  () => `dashboard-integrations:${String(route.params.org_slug)}`,
  () => dashboardApi('/api/dashboard/settings', { query: { connections: '1' }, validate: isSummaryResponse }),
)
const summary = computed(() => data.value?.settings.integrations)
const plan = ref('all')
const planTabs = computed(() => data.value?.connectionFilters ?? [])
const items = computed(() => (data.value?.connections ?? [])
  .filter(item => item.plan === null || plan.value === 'all' || item.plan === plan.value)
  .map(({ icon, ...item }) => ({ ...item, lead: { icon } })))
const groups = computed(() => (data.value?.connectionGroups ?? [])
  .map(group => ({ ...group, items: items.value.filter(item => item.group === group.id) }))
  .filter(group => group.items.length))

provide(integrationsKey, {
  organizationId,
  summary,
  failure: computed(() => error.value ? getErrorMessage(error.value, 'Could not load connections.') : ''),
  refresh: async () => { await refresh() },
})
</script>
