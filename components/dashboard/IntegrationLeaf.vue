<template>
  <div class="space-y-8">
    <div v-if="!connection" class="space-y-4"><slot /></div>

    <template v-else>
      <!-- 1. Account: whose account this is, and who linked it. -->
      <section class="space-y-3">
        <h2 class="text-sm font-semibold text-muted">Account</h2>
        <div class="flex flex-wrap items-center gap-4">
          <UAvatar :src="connection.image ?? undefined" :icon="definition.logo" alt="" size="lg" />
          <div class="min-w-0 flex-1">
            <p class="truncate font-semibold text-highlighted">{{ connection.name }}</p>
            <p class="mt-0.5 text-sm text-muted">
              <template v-if="connection.through">Linked by {{ connection.through.email || connection.through.name }}<template v-if="connection.through.name && connection.through.email"> ({{ connection.through.name }})</template></template>
              <template v-if="connection.through && connectedOn"> · </template>
              <template v-if="connectedOn">Connected {{ connectedOn }}</template>
            </p>
          </div>
        </div>
      </section>

      <!-- 2. Health: the connection's own word on how it is, and the one way to try again. -->
      <section class="space-y-3">
        <h2 class="text-sm font-semibold text-muted">Health</h2>
        <div class="-mx-4 divide-y divide-default">
          <div class="flex min-h-14 items-center gap-4 px-4 py-3">
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-2 text-base text-highlighted">
                <span class="size-2 shrink-0 rounded-full" :class="healthDot" aria-hidden="true" />{{ healthLabel }}
              </span>
              <span v-if="connection.status === 'error'" class="mt-1 block text-sm text-error">{{ connection.lastError || 'The last sync failed.' }}</span>
            </span>
            <UButton v-if="connection.status === 'error' && canRetry" color="neutral" variant="outline" class="rounded-full" :loading="retrying" data-testid="integration-retry" @click="emit('retryConnection')">Retry</UButton>
          </div>
          <div v-if="connection.lastSyncAt" class="flex min-h-14 items-center gap-4 px-4 py-3">
            <span class="text-base text-highlighted">Last synced</span>
            <span class="ms-auto text-sm text-muted">{{ lastSynced }}</span>
          </div>
        </div>
      </section>

      <!-- 3. Linked items: the provider's items that map to ours, chosen here and changeable any time. -->
      <section v-if="definition.items && items" class="space-y-4">
        <div>
          <h2 class="text-sm font-semibold text-muted">{{ itemsTitle }}</h2>
          <p v-if="itemsLead" class="mt-1 text-sm text-muted">{{ itemsLead }}</p>
        </div>

        <p v-if="itemsLoading" class="text-sm text-muted">Finding your {{ definition.items.noun }}s…</p>
        <UAlert v-else-if="itemsError" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="itemsError" />
        <p v-else-if="!items.length" class="text-sm text-muted">{{ itemsEmpty }}</p>

        <template v-else-if="definition.items.selection === 'many'">
          <div class="flex items-center gap-4">
            <UButton color="neutral" variant="outline" class="rounded-full" :disabled="applying" data-testid="integration-select-all" @click="selectAll">{{ allSelected ? 'Select none' : 'Select all' }}</UButton>
            <span class="text-sm text-muted">{{ selected.length }} of {{ items.length }} selected</span>
          </div>
          <div class="-mx-4 divide-y divide-default">
            <div v-for="item in items" :key="item.id" class="flex items-start gap-3 px-4 py-4" :data-testid="`integration-item-${item.id}`">
              <UCheckbox
                :model-value="selected.includes(item.id)"
                :disabled="applying || item.status === 'pending'"
                class="min-w-0 flex-1"
                :ui="{ root: 'items-start', wrapper: 'min-w-0 flex-1', label: 'text-base font-medium text-highlighted', description: 'text-sm text-muted' }"
                @update:model-value="toggle(item.id, $event === true)"
              >
                <template #label>{{ item.title }}</template>
                <template #description>
                  <span v-if="item.subtitle" class="block">{{ item.subtitle }}</span>
                  <span class="mt-1 flex items-center gap-1.5"><span class="size-2 shrink-0 rounded-full" :class="statusDot(item.status)" aria-hidden="true" />{{ statusLabel(item.status) }}</span>
                  <span v-if="item.note" class="mt-0.5 block" :class="item.status === 'attention' ? 'text-error' : ''">{{ item.note }}</span>
                </template>
              </UCheckbox>
              <UButton v-if="item.action" color="neutral" variant="link" class="shrink-0 px-0" :disabled="applying" @click="emit('act', item.id)">{{ item.action }}</UButton>
              <NuxtLink v-if="item.to" :to="item.to" class="group -me-1 flex size-8 shrink-0 items-center justify-center rounded-full hover:bg-elevated" :aria-label="`Open ${item.title}`">
                <UIcon name="i-lucide-chevron-right" class="size-5 text-muted transition-transform group-hover:translate-x-0.5" />
              </NuxtLink>
            </div>
          </div>
        </template>

        <URadioGroup
          v-else
          :model-value="selected[0]"
          :items="items.map(item => ({ value: item.id, label: item.title, disabled: item.status === 'pending' }))"
          variant="list"
          :disabled="applying"
          @update:model-value="value => selected = [String(value)]"
        >
          <template #description="{ item: choice }">
            <span v-if="itemById(choice.value)?.subtitle" class="block">{{ itemById(choice.value)?.subtitle }}</span>
            <span class="mt-1 flex items-center gap-1.5"><span class="size-2 shrink-0 rounded-full" :class="statusDot(itemById(choice.value)!.status)" aria-hidden="true" />{{ statusLabel(itemById(choice.value)!.status) }}</span>
            <span v-if="itemById(choice.value)?.note" class="mt-0.5 block" :class="itemById(choice.value)?.status === 'attention' ? 'text-error' : ''">{{ itemById(choice.value)?.note }}</span>
            <NuxtLink v-if="itemById(choice.value)?.to" :to="itemById(choice.value)!.to" class="mt-1 inline-flex items-center gap-1 text-highlighted underline underline-offset-4">Open<UIcon name="i-lucide-chevron-right" class="size-4" /></NuxtLink>
          </template>
        </URadioGroup>
      </section>

      <slot name="connected" />

      <div class="border-t border-default pt-6">
        <UButton icon="i-lucide-link-2-off" color="error" variant="outline" :loading="disconnecting" :disabled="applying" @click="emit('disconnect')">Disconnect</UButton>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { integrationDefinition, type IntegrationKey } from '~/shared/integrations'

/*
  The one connection leaf: below the panel's title and lead, the account,
  then its health, then the provider's items the host maps to ours — a
  checklist for a `many` integration, a radio list for `one` — and
  Disconnect. The page owns the data and the apply action (the panel's Save
  bar, labelled by `itemsApplyLabel`); the leaf owns how it reads.
*/
export interface IntegrationLeafConnection {
  name: string
  image?: string | null
  /** Null while the provider has not finished connecting. */
  connectedAt: string | null
  /** The KrabiClaw user who linked the account. */
  through?: { email: string | null; name: string | null } | null
  status?: 'active' | 'disabled' | 'error' | null
  lastError?: string | null
  lastSyncAt?: string | null
  /** Where a connection with no status yet stands: "Finishing sign-in". */
  note?: string | null
}

export type IntegrationLeafItemStatus = 'syncing' | 'not_syncing' | 'attention' | 'pending'

export interface IntegrationLeafItem {
  id: string
  title: string
  subtitle?: string | null
  status: IntegrationLeafItemStatus
  /** One line under the status: what a pending item is doing, or why one needs attention. */
  note?: string | null
  /** Its detail here, when it has one: an imported listing's home. */
  to?: string
  /** A step the host takes on this row before it can be chosen, emitted through `act`. */
  action?: string
}

// Each organization has one connection per provider. Disconnect before connecting again.
const props = withDefaults(defineProps<{
  integration: IntegrationKey
  connection: IntegrationLeafConnection | null
  disconnecting?: boolean
  /** Shows Retry beside a failing connection; the page does the retry. */
  canRetry?: boolean
  retrying?: boolean
  items?: IntegrationLeafItem[] | null
  itemsTitle?: string
  itemsLead?: string
  itemsLoading?: boolean
  itemsError?: string | null
  itemsEmpty?: string
  /** While a change applies, the list is read-only. */
  applying?: boolean
}>(), { disconnecting: false, canRetry: false, retrying: false, items: null, itemsTitle: 'Linked items', itemsLead: '', itemsLoading: false, itemsError: null, itemsEmpty: 'Nothing to choose from yet.', applying: false })

/** The ids the host has chosen; the page compares them with what syncs today. */
const selected = defineModel<string[]>('selected', { default: () => [] })

const emit = defineEmits<{
  disconnect: []
  /** The page tries the failing connection again. */
  retryConnection: []
  /** A row's own step: the host presses its action and the page decides what it opens. */
  act: [id: string]
  /** A row is being checked; the page may need the item's details before it stays checked. */
  choose: [id: string, chosen: boolean]
}>()

const definition = computed(() => integrationDefinition(props.integration))
const connectedOn = computed(() => props.connection?.connectedAt
  ? new Date(props.connection.connectedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })
  : '')
const lastSynced = computed(() => props.connection?.lastSyncAt
  ? new Date(props.connection.lastSyncAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  : '')

const healthLabel = computed(() => {
  switch (props.connection?.status) {
    case 'active': return definition.value.group === 'sync' ? 'Syncing' : 'Connected'
    case 'disabled': return 'Paused'
    case 'error': return 'Needs attention'
    default: return props.connection?.note || 'Connected'
  }
})
const healthDot = computed(() => ({ active: 'bg-success', disabled: 'bg-(--ui-text-dimmed)', error: 'bg-error' })[props.connection?.status ?? 'disabled'] ?? 'bg-(--ui-text-dimmed)')

const statusLabel = (status: IntegrationLeafItemStatus) => ({ syncing: 'Syncing', not_syncing: 'Not syncing', attention: 'Needs attention', pending: 'Updating…' })[status]
const statusDot = (status: IntegrationLeafItemStatus) => ({ syncing: 'bg-success', not_syncing: 'bg-(--ui-text-dimmed)', attention: 'bg-error', pending: 'bg-warning' })[status]

const itemById = (id: unknown) => props.items?.find(item => item.id === id)
const allSelected = computed(() => Boolean(props.items?.length) && props.items!.every(item => selected.value.includes(item.id)))

function toggle(id: string, chosen: boolean) {
  selected.value = chosen ? [...new Set([...selected.value, id])] : selected.value.filter(value => value !== id)
  emit('choose', id, chosen)
}

function selectAll() {
  const ids = props.items?.map(item => item.id) ?? []
  if (allSelected.value) {
    selected.value = []
    for (const id of ids) emit('choose', id, false)
  } else {
    const missing = ids.filter(id => !selected.value.includes(id))
    selected.value = ids
    for (const id of missing) emit('choose', id, true)
  }
}
</script>
