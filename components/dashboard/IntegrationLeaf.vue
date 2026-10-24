<template>
  <div class="space-y-6">
    <div v-if="!connection" class="space-y-4"><slot /></div>

    <div v-else class="flex flex-wrap items-center gap-4">
      <UAvatar :src="connection.image ?? undefined" :icon="definition.logo" alt="" size="lg" />
      <div class="min-w-0 flex-1">
        <p class="truncate font-semibold text-highlighted">{{ connection.name }}</p>
        <p class="mt-0.5 text-sm text-muted">
          <template v-if="connection.through">Linked by {{ connection.through.email || connection.through.name }}<template v-if="connection.through.name && connection.through.email"> ({{ connection.through.name }})</template> · </template>Connected {{ connectedOn }}
        </p>
      </div>
    </div>

    <!-- The connection's own word on its health, when it has one. -->
    <UAlert
      v-if="connection && connection.status === 'error'"
      color="error"
      variant="soft"
      icon="i-lucide-triangle-alert"
      title="Needs attention"
      :description="connection.lastError || 'The last sync failed.'"
    />

    <slot v-if="connection" name="connected" />

    <div v-if="connection" class="border-t border-default pt-6">
      <UButton icon="i-lucide-link-2-off" color="error" variant="outline" :loading="disconnecting" @click="emit('disconnect')">Disconnect</UButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { integrationDefinition, type IntegrationKey } from '~/shared/integrations'

export interface IntegrationLeafConnection {
  name: string
  image?: string | null
  connectedAt: string
  /** The KrabiClaw user who linked the account. */
  through?: { email: string | null; name: string | null } | null
  status?: 'active' | 'disabled' | 'error' | null
  lastError?: string | null
}

// Each organization has one connection per provider. Disconnect before connecting again.
const props = withDefaults(defineProps<{
  integration: IntegrationKey
  connection: IntegrationLeafConnection | null
  disconnecting?: boolean
}>(), { disconnecting: false })

const emit = defineEmits<{ disconnect: [] }>()

const definition = computed(() => integrationDefinition(props.integration))
const connectedOn = computed(() => props.connection
  ? new Date(props.connection.connectedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })
  : '')

</script>
