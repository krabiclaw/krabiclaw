<template>
  <!--
    What the business is connected to. Each row is one product with its own
    connection; the two Google products may use the same linked Google
    account, which is not a row.
  -->
  <DashboardIndexPanel id="organization-integrations" title="Integrations" :auto-open="items[0]?.to ?? null">
    <UAlert v-if="error" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="error.message" />
    <EditorNavigationList v-else :groups="groups" :active-item="level.child.value" />
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
import EditorNavigationList, { type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'
import { INTEGRATIONS, INTEGRATION_GROUP_LABELS, type IntegrationKey } from '~/shared/integrations'

definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'menu' })
useSeoMeta({ title: 'Integrations | KrabiClaw Dashboard', robots: 'noindex, nofollow' })

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

// A row says what the connection is and how it is: the target it names, a dot
// for working or failing, and the plan it waits on when the plan lacks it.
const connection = (value: ConnectedIntegration | null, name = value?.target_name): Pick<EditorNavigationItem, 'summary' | 'status'> => {
  if (!value) return { summary: 'Not connected', status: 'neutral' }
  if (value.status === 'error') return { summary: `${name} · Needs attention`, status: 'error' }
  return { summary: name, status: 'success' }
}

const rows = computed<Record<IntegrationKey, Pick<EditorNavigationItem, 'summary' | 'status'>>>(() => {
  const s = summary.value
  const maps = s?.google_maps ?? []
  const connected = maps.filter(location => location.google_place_id).length
  const calendar = s?.google_calendar
  return {
    'google-maps': maps.length
      ? { summary: `${connected} of ${maps.length} ${maps.length === 1 ? 'location' : 'locations'} connected`, status: connected ? 'success' : 'neutral' }
      : { summary: 'No locations yet' },
    'google-analytics': connection(s?.google_analytics ?? null),
    'google-ads': connection(s?.google_ads ?? null),
    'google-search-console': connection(s?.google_search_console ?? null),
    'google-calendar': calendar
      ? { summary: calendar.status === 'error' ? `${calendar.calendar_name} · Needs attention` : calendar.calendar_name, status: calendar.status === 'active' ? 'success' : 'error' }
      : { summary: 'Not connected', status: 'neutral' },
    'facebook': connection(s?.facebook ?? null),
    'instagram': connection(s?.instagram ?? null, s?.instagram ? `@${s.instagram.target_name}` : undefined),
    'discord': connection(s?.discord ?? null, s?.discord ? `#${s.discord.target_name}` : undefined),
    'airbnb': (() => {
      const a = s?.airbnb
      if (!a || a.status === 'not_connected') return { summary: 'Not connected', status: 'neutral' as const }
      if (a.status === 'connected') return { summary: 'Connected', status: 'success' as const }
      if (a.status === 'needs_review') return { summary: 'Needs review', status: 'error' as const }
      return { summary: a.status, status: 'neutral' as const }
    })(),
  }
})

const items = computed<EditorNavigationItem[]>(() => INTEGRATIONS.map(definition => ({
  id: definition.key, label: definition.name, lead: { icon: definition.logo }, to: `${base.value}/${definition.key}`,
  ...rows.value[definition.key],
})))

// Grouped by the job the connection does, under its own heading (DESIGN.md: rows on the pane, no cards).
const groups = computed(() => (Object.keys(INTEGRATION_GROUP_LABELS) as Array<keyof typeof INTEGRATION_GROUP_LABELS>).map(group => ({
  id: group, label: INTEGRATION_GROUP_LABELS[group],
  items: items.value.filter(item => INTEGRATIONS.find(definition => definition.key === item.id)?.group === group),
})))

provide(integrationsKey, {
  organizationId,
  summary,
  failure: computed(() => error.value ? getErrorMessage(error.value, 'Could not load integrations.') : ''),
  refresh: async () => { await refresh() },
})
</script>
