<template>
  <DashboardLeafPanel :id="`booking-${concern}`" :title="setting.title" :lead="setting.lead" :saving="p.saving.value" :disabled="!p.product.value || !valid || (!form?.dirty && !p.saveError.value)" :error="p.loadError.value ?? p.saveError.value ?? ''" @cancel="reset" @save="form?.submit()">
    <!-- Nuxt UI's form state says whether the owner changed anything; Save waits for it. -->
    <UForm v-if="p.product.value" :key="formKey" ref="form" :state="p.form" @submit="save">
      <UFormField v-if="concern === 'enabled'" name="bookable">
        <SettingRow v-model="p.form.bookable" :label="legal ? 'Use a consultation calendar' : 'Use a booking calendar'" />
      </UFormField>
      <UFormField v-else-if="concern === 'duration'" name="booking_duration" label="Duration in minutes" required>
        <UInput v-model="p.form.booking_duration" inputmode="numeric" pattern="[0-9]*" class="w-full" />
      </UFormField>
      <div v-else-if="concern === 'capacity'" class="space-y-6">
        <UFormField name="booking_capacity">
          <URadioGroup v-model="capacityChoice" :items="capacityOptions" variant="card" />
        </UFormField>
        <UFormField v-if="capacityChoice === 'group'" name="booking_capacity" :label="`Maximum ${p.bookingCopy.value.guestsLabelPlural} per ${occurrence}`" required>
          <UInput v-model="p.form.booking_capacity" inputmode="numeric" pattern="[0-9]*" class="w-full" />
        </UFormField>
      </div>
      <!-- Airbnb's Advance notice picker, the one the calendar's table settings use. -->
      <UFormField v-else-if="concern === 'notice'" name="advance_notice_minutes">
        <URadioGroup v-model="notice" :items="noticeOptions" variant="card" />
      </UFormField>
      <UFormField v-else-if="concern === 'confirmation'" name="confirmation_mode">
        <URadioGroup v-model="p.form.confirmation_mode" :items="[{ value: 'instant', label: 'Confirm automatically' }, { value: 'review', label: 'Review each request' }]" variant="card" />
      </UFormField>
      <!-- A table is seated from each opening of its location's hours, every interval, while its length still ends by closing. -->
      <div v-if="concern === 'seatings' || concern === 'enabled' && p.form.bookable && table" class="grid grid-cols-2 gap-4">
        <UFormField name="booking_duration" label="Table held for (minutes)" required>
          <UInput v-model="p.form.booking_duration" inputmode="numeric" pattern="[0-9]*" class="w-full" />
        </UFormField>
        <UFormField name="seating_interval" label="A seating every (minutes)" required>
          <UInput v-model="p.form.seating_interval" inputmode="numeric" pattern="[0-9]*" class="w-full" />
        </UFormField>
      </div>
      <div v-if="concern === 'assignment' || concern === 'enabled' && p.form.bookable" class="space-y-6">
        <UFormField name="assigned_member_id" :label="p.bookingCopy.value.assigneeLabel">
          <ResponsibilityPicker v-model:member-id="p.form.assigned_member_id" :organization-id="p.organizationId" :disabled="p.saving.value" :people-label="peopleLabel" required profiles />
          <UButton v-if="unpublishedHost" class="mt-4" color="neutral" variant="outline" :to="`/dashboard/${route.params.org_slug}/team/${unpublishedHost.id}/profile`">Edit {{ unpublishedHost.name }}'s profile</UButton>
        </UFormField>
        <SettingRow v-model="hostHours" :disabled="!p.form.assigned_member_id || p.form.held_online || legal && hostHours" :label="workingHoursLabel" :description="legal ? 'Each consultation is booked in the attorney’s working hours, and every consultation of this practice area is theirs.' : `${peopleLabel} choose from the ${p.bookingCopy.value.assigneeNoun}’s own hours instead of the weekly schedule.`" />
      </div>
      <div v-else-if="concern === 'payment'" class="space-y-6">
        <UFormField name="online_payment_required">
          <SettingRow v-model="p.form.online_payment_required" :disabled="!paymentEntitled && !p.form.online_payment_required" :label="`Require online payment for paid ${occurrence}s`" />
          <OfferCard v-if="!paymentEntitled" class="mt-4" :offer="offer('payments')" :summary="`Paid ${occurrence}s can be booked without online payment while this is off. Online payments come with Business.`" />
        </UFormField>
        <template v-if="p.form.online_payment_required">
          <!-- A seat's price is paid by each guest; a table's deposit once for the whole party. -->
          <UFormField name="payment_basis" label="The price is paid">
            <URadioGroup v-model="p.form.payment_basis" :items="[{ value: 'per_guest', label: `Per ${p.bookingCopy.value.guestLabel}` }, { value: 'per_booking', label: 'Once per booking', description: 'A deposit for the whole party' }]" variant="card" />
          </UFormField>
          <UFormField name="payment_min_party_size" label="Only for parties of at least" description="Leave empty to take payment from every party.">
            <UInput v-model="p.form.payment_min_party_size" inputmode="numeric" pattern="[0-9]*" class="w-full" />
          </UFormField>
        </template>
      </div>
      <div v-else-if="concern === 'party'" class="grid grid-cols-2 gap-4">
        <UFormField name="party_size_min" :label="`Fewest ${p.bookingCopy.value.guestsLabelPlural}`" description="Optional">
          <UInput v-model="p.form.party_size_min" inputmode="numeric" pattern="[0-9]*" class="w-full" />
        </UFormField>
        <UFormField name="party_size_max" :label="`Most ${p.bookingCopy.value.guestsLabelPlural}`" description="Optional">
          <UInput v-model="p.form.party_size_max" inputmode="numeric" pattern="[0-9]*" class="w-full" />
        </UFormField>
      </div>
      <div v-else-if="concern === 'guest-terms'" class="space-y-6">
        <UFormField name="minimum_guest_age" label="Minimum age" description="Leave empty for all ages.">
          <UInput v-model="p.form.minimum_guest_age" inputmode="numeric" pattern="[0-9]*" class="w-full" />
        </UFormField>
        <UFormField name="accessibility_contact_required">
          <SettingRow v-model="p.form.accessibility_contact_required" :label="`Ask ${p.bookingCopy.value.guestsLabelPlural} who need access support to contact you first`" />
        </UFormField>
      </div>
      <UFormField v-else-if="concern === 'location'" name="held_online">
        <SettingRow v-model="p.form.held_online" :disabled="p.form.scheduling_mode !== 'provider' && !p.form.held_online" label="Held online" />
        <UButton v-if="p.form.scheduling_mode !== 'provider'" class="mt-4" variant="outline" :to="p.sectionPath('booking/assignment')">{{ workingHoursLabel }}</UButton>
      </UFormField>
    </UForm>
    <UButton v-if="p.saveError.value" class="mt-6" color="neutral" variant="outline" @click="reset">Use saved values</UButton>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import SettingRow from '~/components/dashboard/SettingRow.vue'
import { productEditorKey, seatingIntervalValid, type BookingConcern } from '~/components/dashboard/ProductEditorPage.vue'
import OfferCard from '~/components/dashboard/OfferCard.vue'
import { offer } from '~/shared/offers'
import ResponsibilityPicker from '~/components/dashboard/ResponsibilityPicker.vue'
import { NOTICE_OPTIONS, noticeSummary } from '~/shared/availability-settings'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
const concern = computed(() => String(route.params.concern))
const legal = computed(() => p.product.value?.kind === 'service')
const table = computed(() => p.product.value?.kind === 'table')
const occurrence = computed(() => legal.value ? 'consultation' : 'session')
const peopleLabel = computed(() => legal.value ? 'Clients' : 'Guests')
const workingHoursLabel = computed(() => `Book the ${p.bookingCopy.value.assigneeNoun}'s working hours`)
const settings = computed(() => ({
  enabled: { title: legal.value ? 'Consultation calendar' : 'Booking calendar', lead: `Set up times for ${p.bookingCopy.value.guestsLabelPlural} to book. Removing the calendar deletes its schedule and is only allowed before any bookings. To pause this offering and keep its schedule, use its Website settings.` },
  duration: { title: 'Duration', lead: `How long does each ${occurrence.value} last? Existing appointments keep their saved duration.` },
  seatings: { title: 'Seatings', lead: 'Tables are seated from each opening in this location’s hours, every interval, while the time a table is held still ends by closing. Unbooked seatings follow a change at once; booked tables keep their time.' },
  capacity: { title: legal.value ? 'Client limit' : 'Guest limit', lead: `How many ${p.bookingCopy.value.guestsLabelPlural} can book the same ${occurrence.value}? Existing appointments keep their saved ${p.bookingCopy.value.guestLabel} limit.` },
  notice: { title: 'Advance notice', lead: `How much notice do you need before a ${occurrence.value}? ${peopleLabel.value} can’t book or cancel online once it starts sooner than this, and you can’t move a booking into that time. Free cancellation closes at least 24 hours before either way.` },
  confirmation: { title: 'Confirmation', lead: `Confirm ${legal.value ? 'consultations' : 'bookings'} as soon as ${p.bookingCopy.value.guestsLabelPlural} ${legal.value ? 'request a time' : 'reserve'}, or review each request before confirming.` },
  assignment: { title: p.bookingCopy.value.assigneeLabel, lead: legal.value ? 'Choose an attorney for new consultations. Clients book the attorney’s working hours and see their published profile. Existing consultations keep their booked attorney.' : `Who runs it. ${peopleLabel.value} see the ${p.bookingCopy.value.assigneeNoun}’s published profile on the page. A published host profile is required before publishing this offering. Existing bookings keep their assigned host.` },
  payment: { title: 'Payment', lead: `${peopleLabel.value} pay before their booking is made. Free ${occurrence.value}s remain bookable.` },
  party: { title: 'Party size', lead: `The smallest and largest party one booking takes. Larger parties are asked to contact you. Existing bookings keep their party.` },
  'guest-terms': { title: 'Guest requirements', lead: `Shown to ${p.bookingCopy.value.guestsLabelPlural} before they book, and kept with each booking as they read them.` },
  location: { title: 'Meeting format', lead: `Enable online ${legal.value ? 'consultations' : 'booking'} in the ${p.bookingCopy.value.assigneeNoun}’s working hours. Edit physical availability and repeating times at each saved ${legal.value ? 'office' : 'location'}.` },
}))
const dashboard = useDashboardOrganization()
const paymentEntitled = computed(() => dashboard.entitlements.value.payments === true)
const { data: members, status: membersStatus } = await useMemberSchedulingList(() => dashboard.organization.value?.id)
watch(() => p.form.assigned_member_id, (memberId) => {
  if (legal.value && memberId) p.form.scheduling_mode = 'provider'
})
// A notice saved through MCP outside Airbnb's choices is still shown, selected, as its own card.
const noticeOptions = computed(() => {
  const saved = p.product.value?.booking?.advance_notice_minutes ?? 0
  const options = NOTICE_OPTIONS.map(option => ({ value: String(option.value), label: option.label, description: 'description' in option ? option.description : undefined }))
  return NOTICE_OPTIONS.some(option => option.value === saved) ? options : [...options, { value: String(saved), label: noticeSummary(saved), description: undefined }]
})
const notice = computed({
  get: () => String(p.form.advance_notice_minutes ?? 0),
  set: (value: string) => { p.form.advance_notice_minutes = Number(value) || null },
})
const hostHours = computed({
  get: () => p.form.scheduling_mode === 'provider',
  set: (value: boolean) => { p.form.scheduling_mode = value ? 'provider' : 'business' },
})
// A chosen member guests can't see yet: their profile is one step away.
const unpublishedHost = computed(() => members.value?.members.find(member => member.id === p.form.assigned_member_id && member.scheduling?.public_approved !== 1) ?? null)
const setting = computed(() => settings.value[concern.value as keyof typeof settings.value] ?? { title: '', lead: '' })
watchEffect(() => {
  if (level.mode.value === 'yield') return
  // A table's length is set with its seating interval; every other offering sets a duration alone.
  if ((concern.value === 'seatings' && p.product.value && !table.value) || (concern.value === 'duration' && table.value) || (concern.value === 'location' && p.locationId.value && !['experience', 'service'].includes(p.product.value?.kind ?? '')) || !(concern.value in settings.value) || (concern.value !== 'enabled' && p.product.value && !p.loadError.value && !p.product.value.booking)) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})
const capacityOptions = computed(() => [{ value: 'one', label: `One ${p.bookingCopy.value.guestLabel}` }, { value: 'group', label: `A group of ${p.bookingCopy.value.guestsLabelPlural}` }, { value: 'unlimited', label: `No ${p.bookingCopy.value.guestLabel} limit` }, { value: 'closed', label: `Closed to new ${p.bookingCopy.value.guestsLabelPlural}` }])
const capacityChoice = ref('unlimited')
const formKey = ref(0)
function reset() {
  p.revert()
  formKey.value++
  capacityChoice.value = p.form.booking_capacity === '' ? 'unlimited' : p.form.booking_capacity === '1' ? 'one' : p.form.booking_capacity === '0' ? 'closed' : 'group'
}
watch([concern, p.product], ([nextConcern], [previousConcern]) => {
  if (nextConcern !== previousConcern || !p.saving.value && !p.saveError.value) reset()
}, { immediate: true })
watch(capacityChoice, choice => {
  if (choice === 'one') p.form.booking_capacity = '1'
  else if (choice === 'unlimited') p.form.booking_capacity = ''
  else if (choice === 'closed') p.form.booking_capacity = '0'
  else if (Number(p.form.booking_capacity) < 2) p.form.booking_capacity = ''
})
const valid = computed(() => {
  const seated = !table.value || (Number.isSafeInteger(Number(p.form.booking_duration)) && Number(p.form.booking_duration) > 0 && seatingIntervalValid(p.form.seating_interval))
  if (concern.value === 'seatings') return seated
  if (concern.value === 'assignment' || concern.value === 'enabled' && p.form.bookable) return membersStatus.value === 'success' && Boolean(p.form.assigned_member_id) && (!legal.value || p.form.scheduling_mode === 'provider') && (concern.value !== 'enabled' || seated)
  if (concern.value === 'duration') return Number.isSafeInteger(Number(p.form.booking_duration)) && Number(p.form.booking_duration) > 0
  if (concern.value === 'capacity') return capacityChoice.value !== 'group' || (Number.isSafeInteger(Number(p.form.booking_capacity)) && Number(p.form.booking_capacity) >= 2)
  if (concern.value === 'location') return !p.form.held_online || p.form.scheduling_mode === 'provider'
  if (concern.value === 'payment') return (!p.form.online_payment_required || paymentEntitled.value) && optionalCountValid(p.form.payment_min_party_size, 1)
  if (concern.value === 'party') return optionalCountValid(p.form.party_size_min, 1) && optionalCountValid(p.form.party_size_max, 1)
    && (!p.form.party_size_min.trim() || !p.form.party_size_max.trim() || Number(p.form.party_size_max) >= Number(p.form.party_size_min))
  if (concern.value === 'guest-terms') return optionalCountValid(p.form.minimum_guest_age, 0)
  return true
})
/** Empty, or a whole number no smaller than the least it may be. */
function optionalCountValid(value: string, least: number) {
  return !value.trim() || (Number.isSafeInteger(Number(value)) && Number(value) >= least)
}
const form = useTemplateRef('form')
function save() { return p.save(level.to.value ?? undefined, concern.value as BookingConcern) }
onBeforeRouteLeave(() => { p.revert() })
</script>
