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
      <div v-else-if="concern === 'assignment'" class="space-y-6">
        <UFormField name="assigned_member_id" :label="p.bookingCopy.value.assigneeLabel">
          <p v-if="membersError" role="alert" class="mb-3 text-error">Team members could not be loaded.</p>
          <p v-else-if="membersStatus !== 'success'" class="mb-3 text-muted">Loading team members…</p>
          <URadioGroup v-else v-model="host" :items="hostOptions" variant="card" indicator="end" color="neutral" class="w-full" :ui="{ item: 'items-center', wrapper: 'flex items-center gap-4' }">
            <template #label="{ item }">
              <span class="flex items-center gap-4">
                <UAvatar :src="item.avatar ?? undefined" :alt="item.label" :icon="item.team ? 'i-lucide-users' : undefined" size="xl" />
                <span>
                  <span class="block font-medium text-highlighted">{{ item.label }}</span>
                  <span class="block text-sm font-normal" :class="item.published ? 'text-muted' : 'text-warning'">{{ item.state }}</span>
                </span>
              </span>
            </template>
          </URadioGroup>
          <UButton v-if="unpublishedHost" class="mt-4" color="neutral" variant="outline" :to="`/dashboard/${route.params.orgSlug}/team/${unpublishedHost.id}/profile`">Edit {{ unpublishedHost.name }}'s profile</UButton>
        </UFormField>
        <SettingRow v-model="hostHours" :disabled="!host || p.form.held_online" :label="workingHoursLabel" :description="`${peopleLabel} choose from ${p.form.assigned_team_id ? 'each team member’s' : `the ${p.bookingCopy.value.assigneeNoun}’s`} own hours instead of the weekly schedule.`" />
      </div>
      <UFormField v-else-if="concern === 'payment'" name="online_payment_required">
        <SettingRow v-model="p.form.online_payment_required" :disabled="!paymentEntitled && !p.form.online_payment_required" :label="`Require online payment for paid ${occurrence}s`" />
        <template v-if="!paymentEntitled">
          <p class="mt-4 text-sm text-muted">Online payments require Business. Paid {{ occurrence }}s can be booked without online payment when this setting is off.</p>
          <UButton class="mt-3" :to="`/dashboard/${route.params.orgSlug}/billing/upgrade`" variant="outline">Upgrade to Business</UButton>
        </template>
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
import { getPlanEntitlements } from '~/server/utils/billing-entitlements'

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
  assignment: { title: p.bookingCopy.value.assigneeLabel, lead: `${legal.value ? 'Who handles this consultation' : 'Who runs it'}. ${peopleLabel.value} see ${p.form.assigned_team_id ? 'each team member’s' : `the ${p.bookingCopy.value.assigneeNoun}’s`} published profile on the page.` },
  payment: { title: 'Payment', lead: `${peopleLabel.value} pay before their booking is made. Free ${occurrence.value}s remain bookable.` },
  location: { title: 'Meeting format', lead: `Enable online ${legal.value ? 'consultations' : 'booking'} in ${p.form.assigned_team_id ? 'each team member’s' : `the ${p.bookingCopy.value.assigneeNoun}’s`} working hours. Edit physical availability and repeating times at each saved ${legal.value ? 'office' : 'location'}.` },
}))
const dashboard = useDashboardOrganization()
const paymentEntitled = computed(() => {
  const plan = dashboard.organization.value?.effective_plan
  if (!plan) throw createError({ statusCode: 500, statusMessage: 'Organization billing status is unavailable', fatal: true })
  return getPlanEntitlements(plan).payments === true
})
const { data: members, error: membersError, status: membersStatus } = await useMemberSchedulingList(() => dashboard.organization.value?.id)
// The host is who runs it: one member or one team. Whose hours guests book is a separate choice.
const host = computed({
  get: () => p.form.assigned_team_id ? `team:${p.form.assigned_team_id}` : p.form.assigned_member_id ? `member:${p.form.assigned_member_id}` : undefined,
  set: (value: string | undefined) => {
    p.form.assigned_team_id = value?.startsWith('team:') ? value.slice(5) : null
    p.form.assigned_member_id = value?.startsWith('member:') ? value.slice(7) : null
  },
})
const hostHours = computed({
  get: () => p.form.scheduling_mode === 'provider',
  set: (value: boolean) => { p.form.scheduling_mode = value ? 'provider' : 'legacy' },
})
const profileState = (published: boolean) => published ? 'Profile published' : `Profile not published: ${p.bookingCopy.value.guestsLabelPlural} can't see it yet`
// Offered only once the list has loaded; see the template's loading and error states.
// A chosen member guests can't see yet: their profile is one step away.
const unpublishedHost = computed(() => members.value?.members.find(member => `member:${member.id}` === host.value && member.scheduling?.public_approved !== 1) ?? null)
// Each host as guests will see them: the published photo, else the account picture.
const hostOptions = computed(() => members.value ? [
  ...members.value.members.map(member => ({ label: member.name, avatar: member.scheduling?.public_photo_url || member.image, published: member.scheduling?.public_approved === 1, team: false, state: profileState(member.scheduling?.public_approved === 1), value: `member:${member.id}` })),
  ...members.value.teams.map(team => ({ label: team.name, avatar: null, published: true, team: true, state: `${team.members.length} ${team.members.length === 1 ? 'member' : 'members'}: ${p.bookingCopy.value.guestsLabelPlural} see each one with a published profile`, value: `team:${team.id}` })),
] : [])
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
  if (concern.value === 'assignment') return membersStatus.value === 'success' && Boolean(host.value)
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
