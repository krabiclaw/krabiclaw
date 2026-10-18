<template>
  <DashboardLeafPanel
    id="integration-discord"
    icon="i-logos-discord-icon"
    title="Discord"
    :lead="integrationDefinition('discord').purpose"
    :saving="saving"
    :disabled="!accountId || !chosenChannel"
    :error="error || data?.error || integrations.failure.value || loadFailure"
    :footer="!discord && Boolean(accountId) && choices.length > 0"
    save-label="Connect this channel"
    @save="chooseChannel"
  >
    <IntegrationLeaf
      integration="discord"
      :connection="discord && { name: `#${discord.target_name}`, connectedAt: discord.connected_at, through: discord.connected_through, status: discord.status, lastError: discord.last_error }"
      :disconnecting="disconnecting"
      @disconnect="disconnect"
    >
      <UButton v-if="!accountId || loadFailure || data?.error || !choices.length" icon="i-logos-discord-icon" size="xl" block :loading="linking" @click="connect()">Connect Discord</UButton>

      <URadioGroup v-if="choices.length" v-model="chosenChannel" legend="Which channel should posts go to?" :items="choices" variant="card" />
    </IntegrationLeaf>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { INTEGRATION_SCOPES } from '~/shared/organization-settings'
import IntegrationLeaf from '~/components/dashboard/IntegrationLeaf.vue'
import { integrationDefinition } from '~/shared/integrations'
import { integrationsKey, type ConnectedIntegration } from '../integrations.vue'

definePageMeta({ layout: 'dashboard' })

interface DiscordLeaf {
  account_id: string | null
  connection: ConnectedIntegration | null
  choices: Array<{ id: string; name: string; server: string }>
  error: string | null
}

const integrations = inject(integrationsKey)!
const dashboardApi = useDashboardApi()
const api = `/api/organizations/${integrations.organizationId}/integrations/discord`
const { accountId, error, linking, connect, clear } = useIntegrationConnection('discord', INTEGRATION_SCOPES.discord)
const discord = computed(() => integrations.summary.value?.discord ?? null)

const isLeaf = (value: unknown): value is DiscordLeaf =>
  isRecord(value) && (value.account_id === null || typeof value.account_id === 'string')
  && (value.connection === null || isRecord(value.connection)) && Array.isArray(value.choices)
const isSuccess = (value: unknown): value is { success: true } => isRecord(value) && value.success === true

const { data, refresh, error: loadError } = await useAsyncData(
  () => `integration-discord:${integrations.organizationId}:${accountId.value ?? ''}`,
  () => dashboardApi(`${api}/channels`, { query: !discord.value && accountId.value ? { account_id: accountId.value } : {}, validate: isLeaf }),
  { watch: [accountId] },
)
const choices = computed(() => (data.value?.choices ?? []).map(channel => ({ value: channel.id, label: `#${channel.name}`, description: channel.server })))
const chosenChannel = ref<string | undefined>()

const loadFailure = computed(() => loadError.value ? getErrorMessage(loadError.value, 'Could not load Discord.') : '')
const saving = ref(false)
const disconnecting = ref(false)

async function chooseChannel() {
  if (!chosenChannel.value || !accountId.value) return
  saving.value = true
  error.value = ''
  try {
    await dashboardApi(`${api}/channels`, { method: 'POST', body: { account_id: accountId.value, channel_id: chosenChannel.value }, validate: isSuccess })
    await clear()
    chosenChannel.value = undefined
    await Promise.all([refresh(), integrations.refresh()])
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Could not connect that channel.')
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
    chosenChannel.value = undefined
    await Promise.all([refresh(), integrations.refresh()])
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Could not disconnect Discord.')
  } finally {
    disconnecting.value = false
  }
}
</script>
