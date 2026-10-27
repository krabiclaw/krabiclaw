<template>
  <DashboardLeafPanel
    id="integration-airbnb"
    icon="i-simple-icons-airbnb"
    title="Airbnb"
    :lead="integrationDefinition('airbnb').purpose"
    :error="panelError"
    :footer="false"
  >
    <!-- The sync is Business. A connection made under a lapsed plan, in whatever state, can still be disconnected. -->
    <OfferCard v-if="!entitled && (!statusData || statusData.status === 'not_connected')" :offer="offer('airbnb_sync')" />
    <IntegrationLeaf
      v-else
      integration="airbnb"
      :connection="airbnbConnection"
      :disconnecting="disconnecting"
      :inert="Boolean(syncingProductId)"
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
          <p class="text-sm text-muted">Send a home's full calendar again to restore its availability, prices and stay rules.</p>
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
              <div class="ml-3 flex shrink-0 items-center gap-3">
                <UBadge
                  :color="listing.import.status === 'imported' ? 'primary' : 'neutral'"
                  variant="subtle"
                  size="sm"
                >
                  {{ listing.import.status === 'imported' ? 'Imported' : 'Not imported' }}
                </UBadge>
                <UButton
                  v-if="canFullSync && listing.import.status === 'imported' && listing.import.syncing && listing.import.stage === 'complete'"
                  color="neutral"
                  variant="outline"
                  :aria-label="`Full sync for ${listing.title}`"
                  :loading="syncingProductId === listing.import.product_id"
                  :disabled="disconnecting || Boolean(syncingProductId) || fullSyncResults[listing.import.product_id]?.push.state === 'pending'"
                  @click="fullSync(listing)"
                >Full sync</UButton>
              </div>
            </li>
          </ul>
          <UAlert
            v-for="(result, productId) in fullSyncResults"
            :key="productId"
            :color="result.push.state === 'pushed' ? 'success' : 'warning'"
            variant="soft"
            :title="result.push.state === 'pushed' ? `Calendar sent for ${result.title}` : `Full sync is waiting for ${result.title}`"
            :description="result.push.state === 'pending' ? result.push.detail : 'Availability, prices and stay rules were sent.'"
            role="status"
          />
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
import { isSuccessfulChannelPush, type SuccessfulChannelPush } from '~/shared/channel-push'
import { authClient } from '~/lib/auth-client'
import type { organizationRoles } from '~/utils/organization-access'
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
  import: { status: 'not_imported' } | { status: 'imported'; product_id: string; stage: string; syncing: boolean }
}

const integrations = inject(integrationsKey)!
const dashboardApi = useDashboardApi()
const dashboard = useDashboardOrganization()
const entitled = computed(() => dashboard.entitlements.value.channel_sync === true)
const canFullSync = computed(() => {
  const role = dashboard.organization.value?.role as keyof typeof organizationRoles | undefined
  return entitled.value && Boolean(role && authClient.organization.checkRolePermission({ role, permissions: { integrations: ['update'] } }))
})
const apiBase = `/api/organizations/${integrations.organizationId}/integrations/airbnb`

const starting = ref(false)
const disconnecting = ref(false)
const disconnectError = ref<string | null>(null)
const error = ref<string | null>(null)
const syncingProductId = ref<string | null>(null)
const fullSyncResults = ref<Record<string, { title: string; push: SuccessfulChannelPush }>>({})

const isStatus = (value: unknown): value is AirbnbStatusPayload =>
  isRecord(value) && typeof value.status === 'string'
  && ['not_connected', 'authorizing', 'connected', 'disconnecting', 'needs_review'].includes(value.status)
  && (value.connected_at === null || typeof value.connected_at === 'string')
  && (value.status !== 'connected' || typeof value.connected_at === 'string')
  && typeof value.listing_count === 'number'
  && typeof value.channel_active === 'boolean'

const isListings = (value: unknown): value is { listings: AirbnbListing[] } =>
  isRecord(value) && Array.isArray(value.listings)
  && value.listings.every(listing => isRecord(listing) && typeof listing.id === 'string' && Boolean(listing.id)
    && typeof listing.title === 'string' && typeof listing.city === 'string' && typeof listing.country_code === 'string'
    && isRecord(listing.import) && (listing.import.status === 'not_imported'
      || (listing.import.status === 'imported' && typeof listing.import.product_id === 'string' && Boolean(listing.import.product_id)
        && typeof listing.import.stage === 'string' && typeof listing.import.syncing === 'boolean')))

const isFullSync = (value: unknown): value is { product_id: string; channel_push: SuccessfulChannelPush } =>
  isRecord(value) && typeof value.product_id === 'string' && Boolean(value.product_id)
  && value.channel_push !== null && isSuccessfulChannelPush(value.channel_push)

const isStartResponse = (value: unknown): value is { authorization_url: string } =>
  isRecord(value) && typeof value.authorization_url === 'string'

const isDisconnectResponse = (value: unknown): value is { disconnected: boolean } =>
  isRecord(value) && typeof value.disconnected === 'boolean'

const panelError = computed(() =>
  error.value
  || (statusError.value ? getErrorMessage(statusError.value, 'Could not load Airbnb connection status.') : undefined)
  || (listingsError.value ? getErrorMessage(listingsError.value, 'Could not load Airbnb listings.') : undefined)
  || (statusData.value?.status === 'needs_review' ? 'The Airbnb connection needs review.' : undefined)
  || disconnectError.value
  || undefined,
)

const { data: statusData, error: statusError, refresh: refreshStatus } = await useAsyncData<AirbnbStatusPayload>(
  () => `integration-airbnb-status:${integrations.organizationId}`,
  () => dashboardApi(`${apiBase}/status`, { validate: isStatus }),
)

const isConnected = computed(() => statusData.value?.status === 'connected')

const { data: listingsData, error: listingsError, refresh: refreshListings } = await useAsyncData<{ listings: AirbnbListing[] }>(
  () => `integration-airbnb-listings:${integrations.organizationId}`,
  () => dashboardApi(`${apiBase}/listings`, { validate: isListings }),
  { immediate: isConnected.value },
)

const listings = computed(() => listingsData.value?.listings ?? [])

const airbnbConnection = computed<IntegrationLeafConnection | null>(() => {
  const s = statusData.value
  if (!s || s.status === 'not_connected' || s.connected_at === null) return null
  return {
    name: 'Airbnb Host Account',
    connectedAt: s.connected_at,
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

async function fullSync(listing: AirbnbListing) {
  if (syncingProductId.value || disconnecting.value || !canFullSync.value || listing.import.status !== 'imported' || !listing.import.syncing || listing.import.stage !== 'complete') return
  const productId = listing.import.product_id
  if (fullSyncResults.value[productId]?.push.state === 'pending') return
  syncingProductId.value = productId
  fullSyncResults.value = Object.fromEntries(Object.entries(fullSyncResults.value).filter(([id]) => id !== productId))
  error.value = null
  try {
    const result = await dashboardApi(`${apiBase}/imports/${encodeURIComponent(productId)}/calendar`, { method: 'POST', validate: isFullSync })
    if (result.product_id !== productId) throw new Error('The full sync returned a different home. Reload before trying again.')
    fullSyncResults.value[productId] = { title: listing.title, push: result.channel_push }
  } catch (cause) {
    error.value = `${listing.title}: ${getErrorMessage(cause, 'Could not send the full calendar.')}`
  } finally {
    syncingProductId.value = null
  }
}

async function disconnect() {
  if (syncingProductId.value) return
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
