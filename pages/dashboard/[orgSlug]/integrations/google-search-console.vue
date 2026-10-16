<template>
  <DashboardLeafPanel
    id="integration-google-search-console"
    icon="i-logos-google-search-console"
    title="Google Search Console"
    :saving="saving"
    :disabled="!accountId || !selected"
    :error="error || data?.error || integrations.failure.value || loadFailure"
    :footer="!searchConsole && Boolean(accountId) && options.length > 0 && !data?.error"
    save-label="Connect property"
    @save="select"
  >
    <IntegrationConnection
      logo="i-logos-google-search-console"
      :connection="searchConsole && { name: searchConsole.target_name, connectedAt: searchConsole.connected_at }"
      :disconnecting="disconnecting"
      @disconnect="disconnect"
    >
      <UButton v-if="!accountId || loadFailure || data?.error || !options.length" icon="i-simple-icons-google" size="xl" block :loading="linking" @click="connect({ access_type: 'offline', prompt: 'consent select_account' })">Connect Google Search Console</UButton>

      <UFormField v-if="data?.account_id" label="Property" :error="data.error ?? undefined">
        <USelectMenu v-model="selected" :items="options" value-key="value" placeholder="Choose a property" class="w-full" />
      </UFormField>
    </IntegrationConnection>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { INTEGRATION_SCOPES } from '~/shared/organization-settings'
import IntegrationConnection from '~/components/dashboard/IntegrationConnection.vue'
import { integrationsKey, type ConnectedIntegration } from '../integrations.vue'

definePageMeta({ layout: 'dashboard' })

interface SearchConsoleLeaf {
  account_id: string | null
  searchConsole: ConnectedIntegration | null
  siteUrl: string | null
  properties: Array<{ siteUrl: string; permissionLevel: string }>
  error: string | null
}

const integrations = inject(integrationsKey)!
const dashboardApi = useDashboardApi()
const api = `/api/organizations/${integrations.organizationId}/integrations/google-search-console`
const { accountId, error, linking, connect, clear } = useIntegrationConnection('google', INTEGRATION_SCOPES['google-search-console'])
const searchConsole = computed(() => integrations.summary.value?.google_search_console ?? null)

const isLeaf = (value: unknown): value is SearchConsoleLeaf =>
  isRecord(value) && (value.account_id === null || typeof value.account_id === 'string') && Array.isArray(value.properties)
  && (value.searchConsole === null || isRecord(value.searchConsole))
  && (value.siteUrl === null || typeof value.siteUrl === 'string')
const isSuccess = (value: unknown): value is { success: true } => isRecord(value) && value.success === true

const { data, refresh, error: loadError } = await useAsyncData(
  () => `integration-google-search-console:${integrations.organizationId}:${accountId.value ?? ''}`,
  () => dashboardApi(`${api}/sites`, { query: !searchConsole.value && accountId.value ? { account_id: accountId.value } : {}, validate: isLeaf }),
  { watch: [accountId] },
)
const selected = ref<string | undefined>()

// This website's own URL is offered even before the account owns it: KrabiClaw verifies it by serving the tag.
const options = computed(() => {
  const owned = (data.value?.properties ?? []).map(property => ({ label: property.siteUrl, value: property.siteUrl }))
  const own = data.value?.siteUrl
  return own && !owned.some(option => option.value === own) ? [{ label: `${own} (verify for me)`, value: own }, ...owned] : owned
})

const loadFailure = computed(() => loadError.value ? getErrorMessage(loadError.value, 'Could not load Google Search Console.') : '')
const saving = ref(false)
const disconnecting = ref(false)

async function select() {
  if (!selected.value || !accountId.value) return
  saving.value = true
  error.value = ''
  try {
    await dashboardApi(`${api}/select`, { method: 'POST', body: { account_id: accountId.value, site_url: selected.value }, validate: isSuccess })
    await clear()
    selected.value = undefined
    await Promise.all([refresh(), integrations.refresh()])
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Could not connect that property.')
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
    error.value = getErrorMessage(cause, 'Could not disconnect Google Search Console.')
  } finally {
    disconnecting.value = false
  }
}
</script>
