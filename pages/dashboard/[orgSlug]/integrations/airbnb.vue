<template>
  <DashboardLeafPanel
    id="integration-airbnb"
    icon="i-simple-icons-airbnb"
    title="Airbnb"
    :lead="integrationDefinition('airbnb').purpose"
    :error="panelError"
    :footer="false"
  >
    <!-- The sync is Business. A connection made under a lapsed plan can still be disconnected. -->
    <OfferCard v-if="!isConnected && !entitled" :offer="offer('airbnb_sync')" />
    <IntegrationLeaf
      v-else
      integration="airbnb"
      :connection="airbnbConnection"
      :disconnecting="disconnecting"
      @disconnect="disconnect"
    >
      <div v-if="!isConnected" class="space-y-4">
        <p class="text-sm text-muted">
          Connect your Airbnb host account to sync listings, availability, rates, and guest messages directly to your dashboard.
        </p>

        <UButton
          icon="i-simple-icons-airbnb"
          size="xl"
          block
          :loading="starting"
          @click="startConnection"
        >
          Connect Airbnb
        </UButton>

        <p class="text-xs text-dimmed text-center">
          You can also connect and sync directly within the KrabiClaw app on iOS.
        </p>
      </div>

      <template #connected>
        <div v-if="isConnected && listings.length" class="mt-6 space-y-3">
          <h3 class="text-sm font-semibold text-highlighted">Connected listings ({{ listings.length }})</h3>
          <ul class="divide-y divide-default rounded-xl border border-default bg-elevated">
            <li
              v-for="listing in listings"
              :key="listing.id"
              class="flex items-center justify-between p-3.5 text-sm"
            >
              <div class="min-w-0 flex-1">
                <p class="font-medium text-highlighted truncate">{{ listing.title }}</p>
                <p class="text-xs text-muted">{{ listing.city }}, {{ listing.country_code }}</p>
              </div>
              <UBadge
                :color="listing.import.status === 'imported' ? 'primary' : 'neutral'"
                variant="subtle"
                size="sm"
              >
                {{ listing.import.status === 'imported' ? 'Imported' : 'Not imported' }}
              </UBadge>
            </li>
          </ul>
        </div>
      </template>
    </IntegrationLeaf>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import IntegrationLeaf, { type IntegrationLeafConnection } from '~/components/dashboard/IntegrationLeaf.vue'
import OfferCard from '~/components/dashboard/OfferCard.vue'
import { integrationDefinition } from '~/shared/integrations'
import { offer } from '~/shared/offers'
import { getErrorMessage } from '~/utils/errors'
import { integrationsKey } from '../integrations.vue'

definePageMeta({ layout: 'dashboard' })

interface AirbnbStatusPayload {
  status: 'not_connected' | 'authorizing' | 'connected' | 'disconnecting' | 'needs_review'
  connected_at: string | null
  listing_count: number
  channel_active: boolean
}

interface AirbnbListing {
  id: string
  title: string
  city: string
  country_code: string
  import: { status: 'not_imported' } | { status: 'imported'; product_id: string; stage: string }
}

const integrations = inject(integrationsKey)!
const dashboardApi = useDashboardApi()
const dashboard = useDashboardOrganization()
const entitled = computed(() => dashboard.entitlements.value.channel_sync === true)
const apiBase = `/api/organizations/${integrations.organizationId}/integrations/airbnb`

const starting = ref(false)
const disconnecting = ref(false)
const disconnectError = ref<string | null>(null)
const error = ref<string | null>(null)

const isStatus = (value: unknown): value is AirbnbStatusPayload =>
  isRecord(value) && typeof value.status === 'string'
  && (value.connected_at === null || typeof value.connected_at === 'string')
  && typeof value.listing_count === 'number'

const isListings = (value: unknown): value is { listings: AirbnbListing[] } =>
  isRecord(value) && Array.isArray(value.listings)

const isStartResponse = (value: unknown): value is { authorization_url: string } =>
  isRecord(value) && typeof value.authorization_url === 'string'

const isDisconnectResponse = (value: unknown): value is { disconnected: boolean } =>
  isRecord(value) && typeof value.disconnected === 'boolean'

const panelError = computed(() =>
  error.value
  || (statusError.value ? getErrorMessage(statusError.value, 'Could not load Airbnb connection status.') : undefined)
  || disconnectError.value
  || undefined,
)

const { data: statusData, error: statusError, refresh: refreshStatus } = await useAsyncData<AirbnbStatusPayload>(
  () => `integration-airbnb-status:${integrations.organizationId}`,
  () => dashboardApi(`${apiBase}/status`, { validate: isStatus }),
)

const isConnected = computed(() => statusData.value?.status === 'connected')

const { data: listingsData, refresh: refreshListings } = await useAsyncData<{ listings: AirbnbListing[] }>(
  () => `integration-airbnb-listings:${integrations.organizationId}`,
  () => dashboardApi(`${apiBase}/listings`, { validate: isListings }),
  { immediate: isConnected.value },
)

const listings = computed(() => listingsData.value?.listings ?? [])

const airbnbConnection = computed<IntegrationLeafConnection | null>(() => {
  const s = statusData.value
  if (!s || s.status === 'not_connected') return null
  return {
    name: 'Airbnb Host Account',
    connectedAt: s.connected_at ?? new Date().toISOString(),
    status: s.status === 'connected' ? 'active' : s.status === 'needs_review' ? 'error' : null,
    lastError: s.status === 'needs_review' ? 'The Airbnb connection needs review.' : null,
  }
})

async function startConnection() {
  starting.value = true
  error.value = null
  try {
    const res = await dashboardApi<{ authorization_url: string }>(`${apiBase}/start`, { method: 'POST', validate: isStartResponse })
    if (res?.authorization_url) {
      window.location.href = res.authorization_url
    }
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Could not start Airbnb connection.')
  } finally {
    starting.value = false
  }
}

async function disconnect() {
  disconnecting.value = true
  disconnectError.value = null
  try {
    let done = false
    while (!done) {
      const res = await dashboardApi<{ disconnected: boolean }>(`${apiBase}/disconnect`, { method: 'POST', validate: isDisconnectResponse })
      done = Boolean(res?.disconnected)
    }
    await refreshStatus()
    await refreshListings()
    await integrations.refresh()
  } catch (cause) {
    disconnectError.value = getErrorMessage(cause, 'Could not disconnect Airbnb.')
  } finally {
    disconnecting.value = false
  }
}
</script>
