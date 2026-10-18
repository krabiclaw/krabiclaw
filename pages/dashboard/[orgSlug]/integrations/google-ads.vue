<template>
  <DashboardLeafPanel
    id="integration-google-ads"
    icon="i-logos-google-ads"
    title="Google Ads"
    :lead="integrationDefinition('google-ads').purpose"
    :saving="saving"
    :disabled="!accountId || !selected"
    :error="error || data?.error || integrations.failure.value || loadFailure"
    :footer="!ads && Boolean(accountId) && options.length > 0 && !data?.error"
    @save="select"
  >
    <IntegrationLeaf
      integration="google-ads"
      :connection="ads && { name: ads.target_name, connectedAt: ads.connected_at, through: ads.connected_through, status: ads.status, lastError: ads.last_error }"
      :service-on="integrations.summary.value?.services.managed_ads ?? false"
      :disconnecting="disconnecting"
      @disconnect="disconnect"
    >
      <UButton v-if="!accountId || loadFailure || data?.error || !options.length" icon="i-simple-icons-google" size="xl" block :loading="linking" @click="connect({ access_type: 'offline', prompt: 'consent select_account' })">Connect Google Ads</UButton>

      <UFormField v-if="data?.account_id" label="Google Ads account" :error="data.error ?? undefined">
        <USelectMenu v-model="selected" :items="options" value-key="value" placeholder="Choose a Google Ads account" class="w-full" />
        <p v-if="!data.error && !options.length" class="mt-2 text-sm text-muted">This Google account has no accessible Google Ads accounts.</p>
        <p v-for="line in accountErrors" :key="line" class="mt-2 text-sm text-error">{{ line }}</p>
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

interface AdsLeaf {
  account_id: string | null
  ads: ConnectedIntegration | null
  accounts: Array<{ customerId: string; formattedCustomerId: string; descriptiveName: string | null; isManager?: boolean; error?: string }>
  error: string | null
}

const integrations = inject(integrationsKey)!
const dashboardApi = useDashboardApi()
const api = `/api/organizations/${integrations.organizationId}/integrations/google-ads`
const { accountId, error, linking, connect, clear } = useIntegrationConnection('google', INTEGRATION_SCOPES['google-ads'])
const ads = computed(() => integrations.summary.value?.google_ads ?? null)

const isLeaf = (value: unknown): value is AdsLeaf =>
  isRecord(value) && (value.account_id === null || typeof value.account_id === 'string') && Array.isArray(value.accounts)
  && (value.ads === null || isRecord(value.ads))
const isSuccess = (value: unknown): value is { success: true } => isRecord(value) && value.success === true

const { data, refresh, error: loadError } = await useAsyncData(
  () => `integration-google-ads:${integrations.organizationId}:${accountId.value ?? ''}`,
  () => dashboardApi(`${api}/accounts`, { query: !ads.value && accountId.value ? { account_id: accountId.value } : {}, validate: isLeaf }),
  { watch: [accountId] },
)
const selected = ref<string | undefined>()

const options = computed(() => (data.value?.accounts ?? []).map(account => ({
  label: account.descriptiveName ? `${account.descriptiveName} (${account.formattedCustomerId})` : account.formattedCustomerId,
  value: account.customerId,
  disabled: Boolean(account.error),
})))
// Google's reason for each account it would not describe, shown under the picker.
const accountErrors = computed(() => (data.value?.accounts ?? []).filter(account => account.error).map(account => `${account.formattedCustomerId}: ${account.error}`))

const loadFailure = computed(() => loadError.value ? getErrorMessage(loadError.value, 'Could not load Google Ads.') : '')
const saving = ref(false)
const disconnecting = ref(false)

async function select() {
  const account = data.value?.accounts.find(candidate => candidate.customerId === selected.value)
  if (!account || !accountId.value) return
  saving.value = true
  error.value = ''
  try {
    await dashboardApi(`${api}/select`, {
      method: 'POST',
      body: { account_id: accountId.value, customer_id: account.customerId, customer_name: account.descriptiveName },
      validate: isSuccess,
    })
    await clear()
    selected.value = undefined
    await Promise.all([refresh(), integrations.refresh()])
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Could not choose that Google Ads account.')
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
    error.value = getErrorMessage(cause, 'Could not disconnect Google Ads.')
  } finally {
    disconnecting.value = false
  }
}
</script>
