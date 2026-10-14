<template>
  <!--
    What the business is connected to. Each row is one product with its own
    connection; the two Google products may use the same linked Google
    account, which is not a row.
  -->
  <DashboardIndexPanel id="organization-integrations" title="Integrations" :auto-open="items[0]?.to ?? null">
    <UAlert v-if="error" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="error.message" />
    <EditorNavigationList v-else :groups="[{ id: 'integrations', items }]" :active-item="level.child.value" />
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
  connected_at: string
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
  google_calendar: { account_id: string; calendar_name: string; status: 'active' | 'disabled' | 'error'; connected_at: string } | null
  google_analytics: ConnectedIntegration | null
  google_search_console: ConnectedIntegration | null
  facebook: ConnectedIntegration | null
  instagram: ConnectedIntegration | null
  discord: ConnectedIntegration | null
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
import EditorNavigationList, { type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'

definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'menu' })
useSeoMeta({ title: 'Integrations | Krabiclaw Dashboard', robots: 'noindex, nofollow' })

const route = useRoute()
const level = useRouteLevel()
const dashboardApi = useDashboardApi()
const organizationId = await useDashboardOrganizationId()
const base = computed(() => `/dashboard/${String(route.params.orgSlug)}/integrations`)

const isSummaryResponse = (value: unknown): value is { settings: { integrations: IntegrationsSummary } } =>
  isRecord(value) && isRecord(value.settings) && isRecord(value.settings.integrations)
  && Array.isArray(value.settings.integrations.google_maps)

const { data: summary, error, refresh } = await useAsyncData(
  () => `dashboard-integrations:${String(route.params.orgSlug)}`,
  async () => (await dashboardApi('/api/dashboard/settings', { validate: isSummaryResponse })).settings.integrations,
)

// A connection that exists names what it is connected to.
const connection = (value: ConnectedIntegration | null, name = value?.target_name): Pick<EditorNavigationItem, 'summary' | 'status'> =>
  value ? { summary: name, status: 'success' } : { summary: 'Not connected', status: 'neutral' }

const items = computed<EditorNavigationItem[]>(() => {
  const s = summary.value
  const maps = s?.google_maps ?? []
  const connected = maps.filter(location => location.google_place_id).length
  return [
    { id: 'google-maps', label: 'Google Maps', lead: { icon: 'i-logos-google-maps' }, to: `${base.value}/google-maps`,
      ...(maps.length
        ? { summary: `${connected} of ${maps.length} ${maps.length === 1 ? 'location' : 'locations'} connected`, status: connected ? 'success' as const : 'neutral' as const }
        : { summary: 'No locations yet' }) },
    { id: 'google-analytics', label: 'Google Analytics', lead: { icon: 'i-logos-google-analytics' }, to: `${base.value}/google-analytics`,
      ...connection(s?.google_analytics ?? null) },
    { id: 'google-search-console', label: 'Google Search Console', lead: { icon: 'i-logos-google-search-console' }, to: `${base.value}/google-search-console`,
      ...connection(s?.google_search_console ?? null) },
    { id: 'google-calendar', label: 'Google Calendar', lead: { icon: 'i-logos-google-calendar' }, to: `${base.value}/google-calendar`,
      ...(s?.google_calendar ? { summary: s.google_calendar.calendar_name, status: s.google_calendar.status === 'active' ? 'success' as const : 'error' as const } : { summary: 'Not connected' }) },
    { id: 'facebook', label: 'Facebook', lead: { icon: 'i-logos-facebook' }, to: `${base.value}/facebook`,
      ...connection(s?.facebook ?? null) },
    { id: 'instagram', label: 'Instagram', lead: { icon: 'i-skill-icons-instagram' }, to: `${base.value}/instagram`,
      ...connection(s?.instagram ?? null, s?.instagram ? `@${s.instagram.target_name}` : undefined) },
    { id: 'discord', label: 'Discord', lead: { icon: 'i-logos-discord-icon' }, to: `${base.value}/discord`,
      ...connection(s?.discord ?? null, s?.discord ? `#${s.discord.target_name}` : undefined) },
  ]
})

provide(integrationsKey, {
  organizationId,
  summary,
  failure: computed(() => error.value ? getErrorMessage(error.value, 'Could not load integrations.') : ''),
  refresh: async () => { await refresh() },
})
</script>
