<template>
  <div class="space-y-8">
    <template v-if="!concern || concern === 'content'">
      <UFormField label="Name"><UInput v-model="editor.draft.value.title" :maxlength="100" autofocus class="w-full" :disabled="!editor.manage.value || editor.saving.value" /></UFormField>
      <UFormField label="Message"><UTextarea v-model="editor.draft.value.body" :maxlength="5000" :rows="8" class="w-full" :disabled="!editor.manage.value || editor.saving.value" /></UFormField>
    </template>
    <template v-if="!concern || concern === 'schedule'">
      <UFormField label="When to send"><USelect :model-value="trigger" :items="triggers" class="w-full" :disabled="!editor.manage.value || editor.saving.value" @update:model-value="setTrigger" /></UFormField>
        <UAlert v-if="editor.offeringsError.value" color="error" title="Offerings could not be loaded" :description="editor.offeringsError.value" />
        <UFormField :label="homesOnly ? 'Homes' : 'Offerings'"><USelectMenu v-model="selected" :items="offeringItems" value-key="value" multiple :placeholder="homesOnly ? 'Select homes' : 'Select offerings'" class="w-full" :disabled="!editor.manage.value || editor.saving.value || !!editor.offeringsError.value" /></UFormField>
        <template v-if="editor.draft.value.schedule.trigger !== 'booking_received'">
          <UFormField label="Day"><USelect :model-value="offset ?? undefined" :items="offsets" class="w-full" :disabled="!editor.manage.value || editor.saving.value" @update:model-value="setOffset" /></UFormField>
          <UFormField v-if="'localTime' in editor.draft.value.schedule" label="Local time"><UInput v-model="editor.draft.value.schedule.localTime" type="time" class="w-full" :disabled="!editor.manage.value || editor.saving.value" /></UFormField>
        </template>
        <p class="text-sm text-muted"><template v-if="homesOnly">New-reservation messages apply to new reservations, including Airbnb bookings received as they happen. Imported reservations do not trigger new-reservation messages. Every confirmed stay is also sent its home’s check-in instructions the day before arrival. </template>Failed messages remain visible for review.</p>
    </template>
  </div>
</template>
<script setup lang="ts">
import { automaticMessageEditorKey } from './AutomaticMessageEditorPage.vue'
import { scheduleVocabulary, type GuestMessageSchedule } from '~/lib/components/workspace/messages/guest-messaging-client'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import { EXPERIENCE_PRESENTATION } from '~/utils/product-presentation'
defineProps<{ concern?: 'content' | 'schedule' }>()
const editor = inject(automaticMessageEditorKey)!
const schedule = computed(() => editor.draft.value.schedule)
const trigger = computed(() => schedule.value.trigger)
const vocabulary = computed(() => scheduleVocabulary(editor.vertical.value))
// Every offering the workspace takes bookings for; a list of homes alone keeps the homes' words.
const homesOnly = computed(() => editor.offerings.value.length > 0 && editor.offerings.value.every(offering => offering.kind === 'stay'))
const kindLabel = (kind: 'stay' | 'experience' | 'service' | 'reservation') => kind === 'experience' ? EXPERIENCE_PRESENTATION.itemLabel
  : kind === 'service' ? resolveBookingPresentation('booking', 'service').label : kind === 'reservation' ? resolveBookingPresentation('reservation', editor.vertical.value).labelPlural : 'Home'
const offeringItems = computed(() => editor.offerings.value.map(offering => ({
  label: offering.name, value: offering.id,
  description: [homesOnly.value ? null : kindLabel(offering.kind), offering.timezone].filter(Boolean).join(' · '),
})))
// productIds names each offering: a product, or a location for its table reservations.
const selected = computed({
  get: () => schedule.value.productIds,
  set: (values: string[]) => {
    if (!editor.manage.value || editor.saving.value) return
    editor.draft.value.schedule = { ...schedule.value, productIds: values }
  },
})
const triggers = computed(() => [
  { label: `5 minutes after ${vocabulary.value.received}`, value: 'booking_received' },
  { label: vocabulary.value.aroundCheckIn, value: 'check_in' },
  { label: vocabulary.value.aroundCheckOut, value: 'check_out' },
])
// Days anchor to a local time on that day; hours count from the start or end itself.
const HOURS = [1, 2, 3, 4, 6, 12, 24, 48, 72]
const offset = computed(() => schedule.value.trigger === 'booking_received' ? null : 'offsetHours' in schedule.value ? `h:${schedule.value.offsetHours}` : `d:${schedule.value.offsetDays}`)
const offsets = computed(() => {
  const hours = [...new Set([...HOURS.map(value => -value), ...HOURS, ...(offset.value?.startsWith('h:') ? [Number(offset.value.slice(2))] : [])])].sort((a, b) => a - b)
  const hourItems = hours.map(value => ({ value: `h:${value}`, label: value === 0 ? 'At that time' : `${Math.abs(value)} ${Math.abs(value) === 1 ? 'hour' : 'hours'} ${value < 0 ? 'before' : 'after'}` }))
  const dayItems = Array.from({ length: 15 }, (_, index) => { const value = index - 7; return { value: `d:${value}`, label: value === 0 ? 'On the day' : `${Math.abs(value)} ${Math.abs(value) === 1 ? 'day' : 'days'} ${value < 0 ? 'before' : 'after'}` } })
  return [...dayItems.filter(item => item.value.startsWith('d:-')), ...hourItems.filter(item => item.value.startsWith('h:-')), ...hourItems.filter(item => !item.value.startsWith('h:-')), ...dayItems.filter(item => !item.value.startsWith('d:-'))]
})
function setOffset(value: string) {
  if (!editor.manage.value || editor.saving.value || schedule.value.trigger === 'booking_received') return
  const { productIds, trigger: event } = schedule.value
  const amount = Number(value.slice(2))
  editor.draft.value.schedule = value.startsWith('h:') ? { trigger: event, offsetHours: amount, productIds }
    : { trigger: event, offsetDays: amount, localTime: 'localTime' in schedule.value ? schedule.value.localTime : '09:00', productIds }
}
function setTrigger(value: string) {
  if (!editor.manage.value || editor.saving.value) return
  const current = schedule.value
  const { productIds } = current
  const next: GuestMessageSchedule = value === 'booking_received' ? { trigger: 'booking_received', delayMinutes: 5, productIds }
    : current.trigger === 'booking_received' ? { trigger: value as 'check_in' | 'check_out', offsetDays: 0, localTime: '09:00', productIds }
      : { ...current, trigger: value as 'check_in' | 'check_out' }
  editor.draft.value.schedule = next
}
</script>
