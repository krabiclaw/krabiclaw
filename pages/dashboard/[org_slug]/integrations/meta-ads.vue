<template>
  <DashboardLeafPanel
    id="integration-meta-ads"
    icon="i-logos-meta-icon"
    title="Meta Ads"
    :lead="integrationDefinition('meta-ads').purpose"
    :saving="saving"
    :disabled="!account_id || !selected"
    :error="error || data?.error || integrations.failure.value || loadFailure"
    :footer="!ads && Boolean(account_id) && options.length > 0 && !data?.error"
    @save="select"
  >
    <IntegrationLeaf
      integration="meta-ads"
      :connection="ads && { name: ads.target_name, connectedAt: ads.connected_at, through: ads.connected_through, status: ads.status, lastError: ads.last_error }"
      :disconnecting="disconnecting"
      @disconnect="disconnect"
    >
      <UButton v-if="!account_id || loadFailure || data?.error || !options.length" icon="i-logos-meta-icon" size="xl" block :loading="linking" @click="connect()">Connect Meta Ads</UButton>

      <UFormField v-if="data?.account_id" label="Meta Ad Account" :error="data.error ?? undefined">
        <USelectMenu v-model="selected" :items="options" value-key="value" placeholder="Choose a Meta Ad Account" class="w-full" />
        <p v-if="!data.error && !options.length" class="mt-2 text-sm text-muted">This Meta account has no accessible Ad Accounts.</p>
        <p v-for="line in accountErrors" :key="line" class="mt-2 text-sm text-error">{{ line }}</p>
        <p v-if="notEnabledCount" class="mt-2 text-sm text-muted">{{ notEnabledCount === 1 ? '1 account is' : `${notEnabledCount} accounts are` }} disabled or not active in Meta Ads.</p>
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

interface MetaAdsLeaf {
  account_id: string | null
  ads: ConnectedIntegration | null
  accounts: Array<{ id: string; account_id: string; name: string; currency: string; timezone_name: string; account_status: number; not_enabled?: boolean; error?: string }>
  error: string | null
}

const integrations = inject(integrationsKey)!
const dashboardApi = useDashboardApi()
const api = `/api/organizations/${integrations.organizationId}/integrations/meta-ads`
const { accountId: account_id, error, linking, connect, clear } = useIntegrationConnection('facebook', INTEGRATION_SCOPES['meta-ads'])
const ads = computed(() => integrations.summary.value?.meta_ads ?? null)

const isLeaf = (value: unknown): value is MetaAdsLeaf =>
  isRecord(value) && (value.account_id === null || typeof value.account_id === 'string') && Array.isArray(value.accounts)
  && (value.ads === null || isRecord(value.ads))
const isSuccess = (value: unknown): value is { success: true } => isRecord(value) && value.success === true

const { data, refresh, error: loadError } = await useAsyncData(
  () => `integration-meta-ads:${integrations.organizationId}:${account_id.value ?? ''}`,
  () => dashboardApi(`${api}/accounts`, { query: !ads.value && account_id.value ? { account_id: account_id.value } : {}, validate: isLeaf }),
  { watch: [account_id] },
)
const selected = ref<string | undefined>()

const options = computed(() => (data.value?.accounts ?? []).filter(account => !account.not_enabled).map(account => ({
  label: `${account.name} (${account.account_id}) · ${account.currency}`,
  value: account.id,
  disabled: Boolean(account.error) || account.not_enabled === true,
})))

const accountErrors = computed(() => (data.value?.accounts ?? []).filter(account => account.error).map(account => `${account.account_id}: ${account.error}`))
const notEnabledCount = computed(() => (data.value?.accounts ?? []).filter(account => account.not_enabled).length)

const loadFailure = computed(() => loadError.value ? getErrorMessage(loadError.value, 'Could not load Meta Ads.') : '')
const saving = ref(false)
const disconnecting = ref(false)

async function select() {
  const account = data.value?.accounts.find(candidate => candidate.id === selected.value)
  if (!account || !account_id.value) return
  saving.value = true
  error.value = ''
  try {
    await dashboardApi(`${api}/select`, {
      method: 'POST',
      body: { account_id: account_id.value, ad_account_id: account.id, ad_account_name: account.name },
      validate: isSuccess,
    })
    await clear()
    selected.value = undefined
    await Promise.all([refresh(), integrations.refresh()])
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Could not choose that Meta Ad Account.')
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
    error.value = getErrorMessage(cause, 'Could not disconnect Meta Ads.')
  } finally {
    disconnecting.value = false
  }
}
</script>
