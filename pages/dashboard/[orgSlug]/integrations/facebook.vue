<template>
  <DashboardLeafPanel
    id="integration-facebook"
    icon="i-logos-facebook"
    title="Facebook"
    :lead="integrationDefinition('facebook').purpose"
    :saving="saving"
    :disabled="!accountId || !chosenPage"
    :error="error || data?.error || integrations.failure.value || loadFailure"
    :footer="!facebook && Boolean(accountId) && choices.length > 0"
    save-label="Connect this Page"
    @save="choosePage"
  >
    <IntegrationLeaf
      integration="facebook"
      :connection="facebook && { name: facebook.target_name, connectedAt: facebook.connected_at, through: facebook.connected_through, status: facebook.status, lastError: facebook.last_error }"
      :disconnecting="disconnecting"
      @disconnect="disconnect"
    >
      <UButton v-if="!accountId || loadFailure || data?.error || !choices.length" icon="i-simple-icons-facebook" size="xl" block :loading="linking" @click="connect()">Connect Facebook</UButton>

      <URadioGroup v-if="choices.length" v-model="chosenPage" legend="Which Page is this business?" :items="choices" variant="card" />
    </IntegrationLeaf>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { INTEGRATION_SCOPES } from '~/shared/organization-settings'
import IntegrationLeaf from '~/components/dashboard/IntegrationLeaf.vue'
import { integrationDefinition } from '~/shared/integrations'
import { integrationsKey, type ConnectedIntegration } from '../integrations.vue'

definePageMeta({ layout: 'dashboard' })

interface FacebookLeaf {
  account_id: string | null
  connection: ConnectedIntegration | null
  choices: Array<{ id: string; name: string }>
  error: string | null
}

const integrations = inject(integrationsKey)!
const dashboardApi = useDashboardApi()
const api = `/api/organizations/${integrations.organizationId}/integrations/facebook`
const { accountId, error, linking, connect, clear } = useIntegrationConnection('facebook', INTEGRATION_SCOPES.facebook)
const facebook = computed(() => integrations.summary.value?.facebook ?? null)

const isLeaf = (value: unknown): value is FacebookLeaf =>
  isRecord(value) && (value.account_id === null || typeof value.account_id === 'string')
  && (value.connection === null || isRecord(value.connection)) && Array.isArray(value.choices)
const isSuccess = (value: unknown): value is { success: true } => isRecord(value) && value.success === true

const { data, refresh, error: loadError } = await useAsyncData(
  () => `integration-facebook:${integrations.organizationId}:${accountId.value ?? ''}`,
  () => dashboardApi(`${api}/pages`, { query: !facebook.value && accountId.value ? { account_id: accountId.value } : {}, validate: isLeaf }),
  { watch: [accountId] },
)
const choices = computed(() => (data.value?.choices ?? []).map(page => ({ value: page.id, label: page.name })))
const chosenPage = ref<string | undefined>()

const loadFailure = computed(() => loadError.value ? getErrorMessage(loadError.value, 'Could not load Facebook.') : '')
const saving = ref(false)
const disconnecting = ref(false)

async function choosePage() {
  if (!chosenPage.value || !accountId.value) return
  saving.value = true
  error.value = ''
  try {
    await dashboardApi(`${api}/select`, { method: 'POST', body: { account_id: accountId.value, page_id: chosenPage.value }, validate: isSuccess })
    await clear()
    chosenPage.value = undefined
    await Promise.all([refresh(), integrations.refresh()])
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Could not connect that Page.')
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
    chosenPage.value = undefined
    await Promise.all([refresh(), integrations.refresh()])
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Could not disconnect Facebook.')
  } finally {
    disconnecting.value = false
  }
}
</script>
