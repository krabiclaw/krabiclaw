<template>
  <DashboardLeafPanel
    id="integration-instagram"
    icon="i-skill-icons-instagram"
    title="Instagram"
    :lead="integrationDefinition('instagram').purpose"
    :saving="saving"
    :disabled="!accountId || !account"
    :error="error || integrations.failure.value || loadFailure || connectionProblem"
    :footer="!instagram && Boolean(account)"
    save-label="Connect this account"
    @save="select"
  >
    <IntegrationLeaf
      integration="instagram"
      :connection="instagram && { name: `@${instagram.target_name}`, connectedAt: instagram.connected_at, through: instagram.connected_through, status: instagram.status, lastError: instagram.last_error }"
      :disconnecting="disconnecting"
      @disconnect="disconnect"
    >
      <p v-if="account" class="font-semibold">@{{ account.name }}</p>
      <UButton v-else icon="i-lucide-instagram" size="xl" block :loading="linking" @click="connect()">Connect Instagram</UButton>
    </IntegrationLeaf>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import IntegrationLeaf from '~/components/dashboard/IntegrationLeaf.vue'
import { integrationDefinition } from '~/shared/integrations'
import { integrationsKey } from '../integrations.vue'

definePageMeta({ layout: 'dashboard' })

const integrations = inject(integrationsKey)!
const dashboardApi = useDashboardApi()
const api = `/api/organizations/${integrations.organizationId}/integrations/instagram`
const instagram = computed(() => integrations.summary.value?.instagram ?? null)
const { accountId, error, linking, connect, clear } = useIntegrationConnection('instagram')

// Read only the account this OAuth callback linked, never every historical credential.
const { data: account, error: accountError } = await useAsyncData(
  () => `integration-instagram-account:${integrations.organizationId}:${accountId.value ?? ''}`,
  async () => {
    if (!accountId.value || instagram.value) return null
    const { data, error: failure } = await authClient.accountInfo({ query: { accountId: accountId.value } })
    if (failure) throw new Error(failure.message || 'Could not read the Instagram account you authorized.')
    if (!data?.user.name) throw new Error('Instagram did not return the account name.')
    return data.user
  },
  { watch: [accountId] },
)

interface ConnectionHealth { channels: Array<{ channel: string; problems: Array<{ code: string; message: string }> }> }
const isHealth = (value: unknown): value is ConnectionHealth => isRecord(value) && Array.isArray(value.channels)
const { data: health, error: healthError, refresh: refreshHealth } = await useAsyncData(
  `integration-instagram-health:${integrations.organizationId}`,
  () => instagram.value
    ? dashboardApi('/api/integrations/social-connections', { query: { organizationId: integrations.organizationId }, validate: isHealth })
    : Promise.resolve(null),
  { watch: [instagram] },
)
const connectionProblem = computed(() => health.value?.channels.find(channel => channel.channel === 'instagram')?.problems
  .map(problem => `${problem.code}: ${problem.message}`).join(' ') ?? '')
const loadFailure = computed(() => accountError.value ? getErrorMessage(accountError.value, 'Could not load Instagram.')
  : healthError.value ? getErrorMessage(healthError.value, 'Could not check the Instagram connection.') : '')
const isSuccess = (value: unknown): value is { success: true } => isRecord(value) && value.success === true
const saving = ref(false)
const disconnecting = ref(false)

async function select() {
  if (!accountId.value) return
  saving.value = true
  error.value = ''
  try {
    await dashboardApi(`${api}/select`, { method: 'POST', body: { account_id: accountId.value }, validate: isSuccess })
    await clear()
    await integrations.refresh()
    await refreshHealth()
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Could not connect that Instagram account.')
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
    await integrations.refresh()
    await refreshHealth()
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Could not disconnect Instagram.')
  } finally {
    disconnecting.value = false
  }
}
</script>
