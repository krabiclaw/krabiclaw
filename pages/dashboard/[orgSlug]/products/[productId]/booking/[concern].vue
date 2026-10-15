<template>
  <DashboardLeafPanel :id="`booking-${concern}`" :title="setting.title" :lead="setting.lead" :saving="p.saving.value" :disabled="!p.product.value || !valid || (!form?.dirty && !p.saveError.value)" :error="p.loadError.value ?? p.saveError.value ?? ''" @cancel="reset" @save="form?.submit()">
    <!-- Nuxt UI's form state says whether the owner changed anything; Save waits for it. -->
    <UForm v-if="p.product.value" :key="formKey" ref="form" :state="p.form" @submit="save">
      <UFormField v-if="concern === 'enabled'" name="bookable">
        <SettingRow v-model="p.form.bookable" label="Use a booking calendar" />
      </UFormField>
      <UFormField v-else-if="concern === 'duration'" name="booking_duration" label="Duration in minutes" required>
        <UInput v-model="p.form.booking_duration" inputmode="numeric" pattern="[0-9]*" class="w-full" />
      </UFormField>
      <div v-else-if="concern === 'capacity'" class="space-y-6">
        <UFormField name="booking_capacity">
          <URadioGroup v-model="capacityChoice" :items="capacityOptions" variant="card" />
        </UFormField>
        <UFormField v-if="capacityChoice === 'group'" name="booking_capacity" label="Maximum guests per session" required>
          <UInput v-model="p.form.booking_capacity" inputmode="numeric" pattern="[0-9]*" class="w-full" />
        </UFormField>
      </div>
      <UFormField v-else-if="concern === 'confirmation'" name="confirmation_mode">
        <URadioGroup v-model="p.form.confirmation_mode" :items="[{ value: 'instant', label: 'Confirm automatically' }, { value: 'review', label: 'Review each request' }]" variant="card" />
      </UFormField>
      <UFormField v-else-if="concern === 'assignment'" name="scheduling_mode" label="Who guests meet">
        <p v-if="membersError" role="alert" class="mb-3 text-error">Team members could not be loaded.</p>
        <URadioGroup v-else v-model="assignedMember" :items="memberOptions" variant="card" class="w-full" />
      </UFormField>
      <UFormField v-else-if="concern === 'payment'" name="online_payment_required">
        <SettingRow v-model="p.form.online_payment_required" :disabled="!paymentEntitled && !p.form.online_payment_required" label="Require online payment for paid sessions" />
        <template v-if="!paymentEntitled">
          <p class="mt-4 text-sm text-muted">Online payments require Business. Paid sessions can be booked without online payment when this setting is off.</p>
          <UButton class="mt-3" :to="`/dashboard/${route.params.orgSlug}/payments?tab=plan`" variant="outline">View plans</UButton>
        </template>
      </UFormField>
      <UFormField v-else-if="concern === 'location'" name="held_online">
        <SettingRow v-model="p.form.held_online" :disabled="p.form.scheduling_mode !== 'provider' && !p.form.held_online" label="Held online" />
        <UButton v-if="p.form.scheduling_mode !== 'provider'" class="mt-4" variant="outline" :to="`${level.to.value}/assignment`">Choose who guests meet</UButton>
      </UFormField>
    </UForm>
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
const settings = {
  enabled: { title: 'Booking calendar', lead: 'Set up times for guests to book. Removing the calendar deletes its schedule and is only allowed before any bookings. To pause this offering and keep its schedule, use its Website settings.' },
  duration: { title: 'Duration', lead: 'How long does each session last? Existing appointments keep their saved duration.' },
  capacity: { title: 'Guest limit', lead: 'How many guests can book the same session? Existing appointments keep their saved guest limit.' },
  confirmation: { title: 'Confirmation', lead: 'Confirm bookings as soon as guests reserve, or review each request before confirming.' },
  assignment: { title: 'Who guests meet', lead: 'Choose whose availability guests can book.' },
  payment: { title: 'Payment', lead: 'Guests pay before their booking is made. Free sessions remain bookable.' },
  location: { title: 'Meeting location', lead: 'Online, guests book in the working hours of whoever provides it, shown in their own time zone.' },
}
const dashboard = useDashboardOrganization()
const paymentEntitled = computed(() => {
  const plan = dashboard.organization.value?.effective_plan
  if (!plan) throw createError({ statusCode: 500, statusMessage: 'Organization billing status is unavailable', fatal: true })
  return getPlanEntitlements(plan).payments === true
})
const { data: members, error: membersError, status: membersStatus } = await useMemberSchedulingList(() => dashboard.organization.value?.id)
const assignedMember = computed({
  get: () => p.form.assigned_team_id ? `team:${p.form.assigned_team_id}` : p.form.assigned_member_id ? `member:${p.form.assigned_member_id}` : '',
  set: (value: string | null) => {
    p.form.assigned_team_id = value?.startsWith('team:') ? value.slice(5) : ''
    p.form.assigned_member_id = value?.startsWith('member:') ? value.slice(7) : ''
    p.form.scheduling_mode = value ? 'provider' : 'legacy'
  },
})
const memberOptions = computed(() => [{ label: 'Use the business schedule', value: '' }, ...(members.value?.teams.map(team => ({ label: `Any available member of ${team.name}`, value: `team:${team.id}` })) ?? []), ...(members.value?.members.map(member => ({ label: member.name, value: `member:${member.id}` })) ?? [])])
const setting = computed(() => settings[concern.value as keyof typeof settings] ?? { title: '', lead: '' })
watchEffect(() => {
  if (level.mode.value === 'yield') return
  if ((concern.value === 'location' && p.locationId.value) || !(concern.value in settings) || (concern.value !== 'enabled' && p.product.value && !p.loadError.value && !p.product.value.booking)) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})
const capacityOptions = [{ value: 'one', label: 'One guest' }, { value: 'group', label: 'A group of guests' }, { value: 'unlimited', label: 'No guest limit' }, { value: 'closed', label: 'Closed to new guests' }]
const capacityChoice = ref('unlimited')
const formKey = ref(0)
function reset() {
  p.revert()
  formKey.value++
  capacityChoice.value = p.form.booking_capacity === '' ? 'unlimited' : p.form.booking_capacity === '1' ? 'one' : p.form.booking_capacity === '0' ? 'closed' : 'group'
}
watch([concern, p.product], reset, { immediate: true })
watch(capacityChoice, choice => {
  if (choice === 'one') p.form.booking_capacity = '1'
  else if (choice === 'unlimited') p.form.booking_capacity = ''
  else if (choice === 'closed') p.form.booking_capacity = '0'
  else if (Number(p.form.booking_capacity) < 2) p.form.booking_capacity = ''
})
const valid = computed(() => {
  if (concern.value === 'assignment') return membersStatus.value === 'success'
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
