<template>
  <div data-testid="stay-night-inspector" class="space-y-4">
    <div class="flex items-center justify-between gap-3">
      <UButton color="neutral" class="rounded-full px-4 py-2" :label="dateLabel" aria-label="Select nights" :disabled="busy" @click="$emit('dates')" />
      <UButton icon="i-lucide-x" aria-label="Clear selected nights" color="neutral" variant="soft" square class="rounded-full" :disabled="busy" @click="$emit('clear')" />
    </div>
    <p class="text-xs text-muted">{{ home.timezone }} · {{ home.currency }}</p>
    <UAlert v-if="error" color="error" variant="soft" :description="error" />
    <UAlert v-if="notice" color="warning" variant="soft" :description="notice" />
    <template v-if="concern === 'summary'">
      <UCard class="rounded-3xl bg-inverted text-inverted" :ui="{ body: 'p-5' }">
        <div class="flex items-center justify-between gap-4">
          <p class="text-sm">{{ availabilityLabel }}</p>
          <USwitch v-if="closed !== 'mixed'" :model-value="!closed" aria-label="Open selected nights" color="neutral" :disabled="busy || !manage" @update:model-value="$emit('patch', { closed: !$event })" />
        </div>
        <div v-if="closed === 'mixed' && manage" class="mt-4 flex gap-2">
          <UButton label="Open selected nights" color="neutral" variant="outline" :disabled="busy" @click="$emit('patch', { closed: false })" />
          <UButton label="Block selected nights" color="neutral" variant="outline" :disabled="busy" @click="$emit('patch', { closed: true })" />
        </div>
        <p v-if="occupied" class="mt-3 text-sm">Opening nights keeps existing reservations and checkout holds.</p>
        <p v-for="expiry in holdExpiries" :key="expiry" class="mt-3 text-sm">Checkout hold expires {{ formatTimestamp(expiry, 'en', home.timezone) }} ({{ home.timezone }}).</p>
        <UButton v-for="id in stayIds" :key="id" :to="{ path: `/dashboard/${orgSlug}/calendar/stay/${encodeURIComponent(id)}`, query: route.query }" label="View stay" color="neutral" variant="outline" class="mt-3" />
      </UCard>
      <UButton label="Nightly price" color="neutral" class="w-full flex-col items-start rounded-3xl p-6 text-left" :disabled="busy || !manage" @click="$emit('edit', 'price')">
        <span class="block text-sm font-normal">Nightly price</span>
        <span class="mt-4 block text-3xl font-semibold">{{ priceLabel }}</span>
      </UButton>
      <UButton v-if="manage" label="Custom settings" trailing-icon="i-lucide-plus" color="neutral" class="w-full justify-between rounded-3xl p-6" :disabled="busy" @click="$emit('edit', 'custom')" />
      <p v-else class="text-sm text-muted">Only owners and admins can change these nights.</p>
    </template>
    <template v-else-if="concern === 'custom'">
      <h2 class="text-xl font-semibold text-highlighted">Custom settings</h2>
      <UButton v-for="item in settingItems" :key="item.concern" :label="item.label" trailing-icon="i-lucide-chevron-right" color="neutral" variant="outline" class="w-full justify-between py-4" :disabled="busy" @click="$emit('edit', item.concern)" />
      <UButton label="Reset all night settings" color="neutral" variant="link" class="px-0" :disabled="busy" @click="$emit('edit', 'reset')" />
      <UButton label="Done" color="neutral" class="w-full" @click="$emit('cancel')" />
    </template>
    <template v-else>
      <h2 class="text-xl font-semibold text-highlighted">{{ concernTitle }}</h2>
      <template v-if="concern === 'price'">
        <UFormField :label="`Nightly price (${home.currency})`">
          <UInput :model-value="draft.price_minor" :placeholder="price === 'mixed' ? 'Mixed prices' : 'Use base price'" inputmode="decimal" class="w-full" :ui="{ base: 'py-6 text-center text-3xl font-semibold' }" :disabled="busy" @update:model-value="$emit('field', 'price_minor', String($event))" />
        </UFormField>
        <p class="text-sm text-muted">Base nightly price: {{ home.base_price_minor === null ? 'Not set' : money(home.base_price_minor) }}.</p>
        <UButton label="Restore base nightly price" color="neutral" variant="link" class="px-0" :disabled="busy" @click="$emit('patch', { price_minor: null })" />
      </template>
      <template v-else-if="concern === 'minimum' || concern === 'maximum'">
        <p v-if="concern === 'minimum'" class="text-sm text-muted">The home’s default is {{ home.min_nights }} nights. Clear an override to use the default.</p>
        <p v-else class="text-sm text-muted">Clear this override to remove the night’s maximum.</p>
        <UFormField v-for="field in numericFields" :key="field.key" :label="field.label">
          <UInput :model-value="draft[field.key]" type="number" min="1" max="99" step="1" :placeholder="common(field.key) === 'mixed' ? 'Mixed settings' : 'Use default'" class="w-full" :disabled="busy" @update:model-value="$emit('field', field.key, $event == null ? '' : String($event))" />
        </UFormField>
      </template>
      <template v-else-if="concern === 'arrival'">
        <UFormField v-for="field in arrivalFields" :key="field.key" :label="field.label" :description="common(field.key) === 'mixed' ? 'Mixed across the selected nights.' : undefined">
          <USelect :model-value="draft[field.key]" :items="permissionItems" class="w-full" :disabled="busy" @update:model-value="$emit('field', field.key, String($event))" />
        </UFormField>
      </template>
      <p v-else-if="concern === 'reset'" class="text-sm text-muted">Remove all selected nights’ custom prices, closures and stay rules. Base price and default minimum nights apply again. Existing reservations and checkout holds remain.</p>
      <div class="flex items-center justify-between gap-4 border-t border-default pt-5">
        <UButton label="Cancel" color="neutral" variant="link" :disabled="busy" @click="$emit('cancel')" />
        <UButton :label="concern === 'reset' ? 'Reset all night settings' : 'Save'" color="neutral" :loading="busy" :disabled="concern !== 'reset' && !dirty" @click="$emit('save')" />
      </div>
    </template>
  </div>
</template>

<script lang="ts">
export type NightConcern = 'summary' | 'price' | 'custom' | 'minimum' | 'maximum' | 'arrival' | 'reset'
export type NightEditField = 'price_minor' | 'min_stay_arrival' | 'min_stay_through' | 'max_stay' | 'closed_to_arrival' | 'closed_to_departure'
export type NightDraft = Record<NightEditField, string>
</script>

<script setup lang="ts">
import type { StayHome, StayNight } from '~/server/domain/stays'
import { formatMinorAmount } from '~/shared/prices'
import { formatTimestamp } from '~/utils/timezone'

const props = defineProps<{
  orgSlug: string
  home: Pick<StayHome, 'timezone' | 'currency' | 'base_price_minor' | 'min_nights'>
  nights: StayNight[]
  dateLabel: string
  manage: boolean
  busy: boolean
  error: string
  notice: string
  concern: NightConcern
  draft: NightDraft
  dirty: boolean
}>()
const route = useRoute()
defineEmits<{
  clear: []
  dates: []
  edit: [concern: NightConcern]
  cancel: []
  save: []
  field: [field: NightEditField, value: string]
  patch: [patch: Record<string, boolean | number | null>]
}>()
function common<K extends keyof StayNight>(field: K): StayNight[K] | 'mixed' {
  const first = props.nights[0]?.[field]
  return props.nights.length && props.nights.every(night => night[field] === first) ? first as StayNight[K] : 'mixed'
}
const money = (value: number) => formatMinorAmount(value, props.home.currency)
const closed = computed(() => common('closed'))
const occupied = computed(() => props.nights.some(night => night.stay_id || night.held_until))
const stayIds = computed(() => [...new Set(props.nights.flatMap(night => night.stay_id ? [night.stay_id] : []))])
const holdExpiries = computed(() => [...new Set(props.nights.flatMap(night => night.held_until ? [night.held_until] : []))].sort())
const availabilityLabel = computed(() => {
  const states = new Set(props.nights.map(night => night.stay_id ? 'Reserved' : night.held_until ? 'Checkout hold' : night.closed ? 'Blocked by you' : 'Available'))
  return states.size === 1 ? [...states][0] : 'Mixed availability'
})
const price = computed(() => common('price_minor'))
const priceLabel = computed(() => price.value === 'mixed' ? 'Mixed prices' : price.value === null ? 'No price set' : money(price.value))
const concernTitle = computed(() => ({ summary: '', custom: 'Custom settings', price: 'Nightly price', minimum: 'Minimum nights', maximum: 'Maximum nights', arrival: 'Check-in and checkout', reset: 'Reset all night settings' })[props.concern])
const settingItems = [{ concern: 'minimum', label: 'Minimum nights' }, { concern: 'maximum', label: 'Maximum nights' }, { concern: 'arrival', label: 'Check-in and checkout' }] as const
const numericFields = computed(() => props.concern === 'minimum'
  ? [{ key: 'min_stay_arrival', label: 'Minimum nights on arrival' }, { key: 'min_stay_through', label: 'Minimum nights through stay' }] as const
  : [{ key: 'max_stay', label: 'Maximum nights' }] as const)
const arrivalFields = [{ key: 'closed_to_arrival', label: 'Allow check-in' }, { key: 'closed_to_departure', label: 'Allow checkout' }] as const
const permissionItems = [{ label: 'Keep each night’s setting', value: 'keep' }, { label: 'Allowed', value: 'allow' }, { label: 'Not allowed', value: 'block' }]
</script>
