<template>
  <!--
    One shape for every integration, as a connector's own page is: what is
    connected and who linked it, what it does here, prompts the
    KrabiClaw app answers with it, the plan it needs, and Disconnect last.
    The slot holds the one provider-specific control: connecting.
  -->
  <div class="space-y-10">
    <!-- Nothing connected: the product's mark and the one way to connect it. -->
    <div v-if="!connection" class="flex flex-col items-center gap-8">
      <UIcon :name="definition.logo" class="size-24" />
      <div class="w-full space-y-4 text-left">
        <slot />
      </div>
    </div>

    <div v-else class="flex flex-wrap items-center gap-4">
      <UAvatar :src="connection.image ?? undefined" :icon="definition.logo" alt="" size="3xl" />
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

    <!-- Gated: the plan row, as Airbnb names what a setting needs. -->
    <NuxtLink
      v-if="definition.entitlement && !entitled"
      :to="planTo"
      class="-mx-4 flex items-center gap-4 px-4 py-4 hover:bg-elevated"
    >
      <UIcon name="i-lucide-lock" class="size-5 shrink-0 text-dimmed" />
      <span class="min-w-0 flex-1">
        <span class="block font-medium text-highlighted">Requires Business</span>
        <span class="block text-sm text-muted">{{ definition.name }} is part of the Business plan.</span>
      </span>
      <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
    </NuxtLink>

    <section>
      <h2 class="text-base font-semibold text-highlighted">What it does here</h2>
      <ul class="mt-3 space-y-3">
        <li v-for="line in definition.does" :key="line" class="flex gap-3 text-base text-muted">
          <UIcon name="i-lucide-check" class="mt-1 size-4 shrink-0 text-highlighted" />
          <span>{{ line }}</span>
        </li>
      </ul>
    </section>

    <!-- Prompts the app answers with this connection; Copy puts one on the clipboard for ChatGPT. -->
    <section v-if="definition.prompts.length" data-testid="integration-prompts">
      <h2 class="text-base font-semibold text-highlighted">Try it in a chat</h2>
      <p class="mt-1 text-sm text-muted">Ask the KrabiClaw app in ChatGPT.</p>
      <div class="mt-4 space-y-3">
        <div v-for="prompt in definition.prompts" :key="prompt" class="flex items-center gap-3 rounded-2xl p-4 ring ring-default">
          <UIcon :name="definition.logo" class="size-6 shrink-0" />
          <p class="min-w-0 flex-1 text-base text-highlighted">{{ prompt }}</p>
          <UButton :label="copied === prompt ? 'Copied' : 'Copy'" color="neutral" variant="outline" size="sm" @click="copy(prompt)" />
        </div>
      </div>
    </section>

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
  /** Whether the organization's plan grants the integration; defaults to granted for ungated ones. */
  entitled?: boolean
}>(), { disconnecting: false, entitled: true })

const emit = defineEmits<{ disconnect: [] }>()

const route = useRoute()
const definition = computed(() => integrationDefinition(props.integration))
const planTo = computed(() => `/dashboard/${String(route.params.orgSlug)}/payments?tab=plan`)
const connectedOn = computed(() => props.connection
  ? new Date(props.connection.connectedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })
  : '')

const copied = ref('')
async function copy(prompt: string) {
  await navigator.clipboard.writeText(prompt)
  copied.value = prompt
}
</script>
