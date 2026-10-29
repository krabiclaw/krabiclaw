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
      <UFormField v-else-if="concern === 'confirmation'" name="confirmation_mode">
        <URadioGroup v-model="p.form.confirmation_mode" :items="[{ value: 'instant', label: 'Confirm automatically' }, { value: 'review', label: 'Review each request' }]" variant="card" />
      </UFormField>
      <div v-if="concern === 'assignment' || concern === 'enabled' && legal && p.form.bookable" class="space-y-6">
        <UFormField name="assigned_member_id" :label="p.bookingCopy.value.assigneeLabel">
          <ResponsibilityPicker v-model:member-id="p.form.assigned_member_id" v-model:team-id="p.form.assigned_team_id" :organization-id="p.organizationId" :disabled="p.saving.value" :people-label="peopleLabel" required profiles />
          <UButton v-if="unpublishedHost" class="mt-4" color="neutral" variant="outline" :to="`/dashboard/${route.params.orgSlug}/team/${unpublishedHost.id}/profile`">Edit {{ unpublishedHost.name }}'s profile</UButton>
        </UFormField>
        <SettingRow v-model="hostHours" :disabled="!p.form.assigned_member_id && !p.form.assigned_team_id || p.form.held_online || legal && hostHours" :label="workingHoursLabel" :description="legal ? 'Each new consultation is booked with an available attorney from this selection. Existing consultations keep their booked attorney.' : `${peopleLabel} choose from ${p.form.assigned_team_id ? 'each team member’s' : `the ${p.bookingCopy.value.assigneeNoun}’s`} own hours instead of the weekly schedule.`" />
      </div>
      <UFormField v-else-if="concern === 'payment'" name="online_payment_required">
        <SettingRow v-model="p.form.online_payment_required" :disabled="!paymentEntitled && !p.form.online_payment_required" :label="`Require online payment for paid ${occurrence}s`" />
        <OfferCard v-if="!paymentEntitled" class="mt-4" :offer="offer('payments')" :summary="`Paid ${occurrence}s can be booked without online payment while this is off. Online payments come with Business.`" />
      </UFormField>
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
import { productEditorKey, type BookingConcern } from '~/components/dashboard/ProductEditorPage.vue'
import OfferCard from '~/components/dashboard/OfferCard.vue'
import { offer } from '~/shared/offers'
import ResponsibilityPicker from '~/components/dashboard/ResponsibilityPicker.vue'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
const concern = computed(() => String(route.params.concern))
const legal = computed(() => p.product.value?.kind === 'service')
const occurrence = computed(() => legal.value ? 'consultation' : 'session')
const peopleLabel = computed(() => legal.value ? 'Clients' : 'Guests')
const workingHoursLabel = computed(() => p.form.assigned_team_id ? 'Book each team member’s working hours' : `Book the ${p.bookingCopy.value.assigneeNoun}'s working hours`)
const settings = computed(() => ({
  enabled: { title: legal.value ? 'Consultation calendar' : 'Booking calendar', lead: `Set up times for ${p.bookingCopy.value.guestsLabelPlural} to book. Removing the calendar deletes its schedule and is only allowed before any bookings. To pause this offering and keep its schedule, use its Website settings.` },
  duration: { title: 'Duration', lead: `How long does each ${occurrence.value} last? Existing appointments keep their saved duration.` },
  capacity: { title: legal.value ? 'Client limit' : 'Guest limit', lead: `How many ${p.bookingCopy.value.guestsLabelPlural} can book the same ${occurrence.value}? Existing appointments keep their saved ${p.bookingCopy.value.guestLabel} limit.` },
  confirmation: { title: 'Confirmation', lead: `Confirm ${legal.value ? 'consultations' : 'bookings'} as soon as ${p.bookingCopy.value.guestsLabelPlural} ${legal.value ? 'request a time' : 'reserve'}, or review each request before confirming.` },
  assignment: { title: p.bookingCopy.value.assigneeLabel, lead: legal.value ? 'Choose an attorney or legal team for new consultations. Clients book an available attorney’s working hours and see their published profile. Existing consultations keep their booked attorney.' : `Who runs it. ${peopleLabel.value} see ${p.form.assigned_team_id ? 'each team member’s' : `the ${p.bookingCopy.value.assigneeNoun}’s`} published profile on the page. A published host profile is required before publishing this offering. Existing bookings keep their assigned host.` },
  payment: { title: 'Payment', lead: `${peopleLabel.value} pay before their booking is made. Free ${occurrence.value}s remain bookable.` },
  location: { title: 'Meeting format', lead: `Enable online ${legal.value ? 'consultations' : 'booking'} in ${p.form.assigned_team_id ? 'each team member’s' : `the ${p.bookingCopy.value.assigneeNoun}’s`} working hours. Edit physical availability and repeating times at each saved ${legal.value ? 'office' : 'location'}.` },
}))
const dashboard = useDashboardOrganization()
const paymentEntitled = computed(() => dashboard.entitlements.value.payments === true)
const { data: members, status: membersStatus } = await useMemberSchedulingList(() => dashboard.organization.value?.id)
watch(() => [p.form.assigned_member_id, p.form.assigned_team_id], ([memberId, teamId]) => {
  if (legal.value && (memberId || teamId)) p.form.scheduling_mode = 'provider'
})
const hostHours = computed({
  get: () => p.form.scheduling_mode === 'provider',
  set: (value: boolean) => { p.form.scheduling_mode = value ? 'provider' : 'legacy' },
})
// A chosen member guests can't see yet: their profile is one step away.
const unpublishedHost = computed(() => members.value?.members.find(member => member.id === p.form.assigned_member_id && member.scheduling?.public_approved !== 1) ?? null)
const setting = computed(() => settings.value[concern.value as keyof typeof settings.value] ?? { title: '', lead: '' })
watchEffect(() => {
  if (level.mode.value === 'yield') return
  if ((concern.value === 'location' && p.locationId.value && !['experience', 'service'].includes(p.product.value?.kind ?? '')) || !(concern.value in settings.value) || (concern.value !== 'enabled' && p.product.value && !p.loadError.value && !p.product.value.booking)) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
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
  if (concern.value === 'assignment' || concern.value === 'enabled' && legal.value && p.form.bookable) return membersStatus.value === 'success' && Boolean(p.form.assigned_member_id || p.form.assigned_team_id) && (!legal.value || p.form.scheduling_mode === 'provider')
  if (concern.value === 'duration') return Number.isSafeInteger(Number(p.form.booking_duration)) && Number(p.form.booking_duration) > 0
  if (concern.value === 'capacity') return capacityChoice.value !== 'group' || (Number.isSafeInteger(Number(p.form.booking_capacity)) && Number(p.form.booking_capacity) >= 2)
  if (concern.value === 'location') return !p.form.held_online || p.form.scheduling_mode === 'provider'
  if (concern.value === 'payment') return !p.form.online_payment_required || paymentEntitled.value
  return true
})
const form = useTemplateRef('form')
function save() { return p.save(level.to.value ?? undefined, concern.value as BookingConcern) }
onBeforeRouteLeave(() => { p.revert() })
</script>
