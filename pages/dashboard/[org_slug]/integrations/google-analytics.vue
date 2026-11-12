<template>
  <DashboardLeafPanel
    id="integration-google-analytics"
    icon="i-logos-google-analytics"
    title="Google Analytics"
    :lead="integrationDefinition('google-analytics').purpose"
    :saving="saving"
    :disabled="!accountId || !selected"
    :error="error || data?.error || integrations.failure.value || loadFailure"
    :footer="!analytics && Boolean(accountId) && options.length > 0 && !data?.error"
    @save="select"
  >
    <IntegrationLeaf
      integration="google-analytics"
      :connection="analytics && { name: analytics.target_name, connectedAt: analytics.connected_at, through: analytics.connected_through, status: analytics.status, lastError: analytics.last_error }"
      :disconnecting="disconnecting"
      @disconnect="disconnect"
    >
      <UButton v-if="!accountId || loadFailure || data?.error || !options.length" icon="i-simple-icons-google" size="xl" block :loading="linking" @click="connect({ access_type: 'offline', prompt: 'consent select_account' })">Connect Google Analytics</UButton>

      <UFormField v-if="data?.account_id" label="Analytics property" :error="data.error ?? undefined">
        <USelectMenu v-model="selected" :items="options" value-key="value" placeholder="Choose a GA4 property" class="w-full" />
        <p v-if="!data.error && !options.length" class="mt-2 text-sm text-muted">This Google account has no GA4 properties.</p>
      </UFormField>
    </IntegrationLeaf>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { INTEGRATION_SCOPES } from '~/shared/organization-settings'
import IntegrationLeaf from '~/components/dashboard/IntegrationLeaf.vue'
import { integrationDefinition } from '~/shared/integrations'
import { integrationsKey, type ConnectedIntegration } from '../integrations.vue'

definePageMeta({ layout: 'dashboard' })

interface AnalyticsLeaf {
  account_id: string | null
  analytics: ConnectedIntegration | null
  properties: Array<{ accountName: string; propertyId: string; propertyName: string }>
  error: string | null
}

const integrations = inject(integrationsKey)!
const dashboardApi = useDashboardApi()
const api = `/api/organizations/${integrations.organizationId}/integrations/google-analytics`
const { accountId, error, linking, connect, clear } = useIntegrationConnection('google', INTEGRATION_SCOPES['google-analytics'])
const analytics = computed(() => integrations.summary.value?.google_analytics ?? null)

const isLeaf = (value: unknown): value is AnalyticsLeaf =>
  isRecord(value) && (value.account_id === null || typeof value.account_id === 'string') && Array.isArray(value.properties)
  && (value.analytics === null || isRecord(value.analytics))
const isSuccess = (value: unknown): value is { success: true } => isRecord(value) && value.success === true

const { data, refresh, error: loadError } = await useAsyncData(
  () => `integration-google-analytics:${integrations.organizationId}:${accountId.value ?? ''}`,
  () => dashboardApi(`${api}/properties`, { query: !analytics.value && accountId.value ? { account_id: accountId.value } : {}, validate: isLeaf }),
  { watch: [accountId] },
)
const selected = ref<string | undefined>()

const options = computed(() => (data.value?.properties ?? []).map(property => ({ label: `${property.propertyName} (${property.accountName})`, value: property.propertyId })))

const loadFailure = computed(() => loadError.value ? getErrorMessage(loadError.value, 'Could not load Google Analytics.') : '')
const saving = ref(false)
const disconnecting = ref(false)

async function select() {
  const property = data.value?.properties.find(candidate => candidate.propertyId === selected.value)
  if (!property || !accountId.value) return
  saving.value = true
  error.value = ''
  try {
    await dashboardApi(`${api}/select`, { method: 'POST', body: { account_id: accountId.value, property_id: property.propertyId, property_name: property.propertyName }, validate: isSuccess })
    await clear()
    selected.value = undefined
    await Promise.all([refresh(), integrations.refresh()])
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Could not choose that property.')
  } finally {
    saving.value = false
  }
}

async function disconnect() {
  disconnecting.value = true
  error.value = ''
  try {
    await dashboardApi(`${api}/disconnect`, { method: 'POST', validate: isSuccess })
    await clear()
    selected.value = undefined
    await Promise.all([refresh(), integrations.refresh()])
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Could not disconnect Google Analytics.')
  } finally {
    disconnecting.value = false
  }
}
</script>
