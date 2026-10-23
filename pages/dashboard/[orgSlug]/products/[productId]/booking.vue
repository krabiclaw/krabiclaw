<template>
  <DashboardIndexPanel id="product-booking" :title="p.sectionLabels.booking" :auto-open="groups[0]?.items[0]?.to ?? null">
    <UAlert v-if="p.loadError.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="p.loadError.value" />
    <EditorNavigationList v-else :groups="groups" :active-item="level.child.value" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup, type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const level = useRouteLevel()
const route = useRoute()
const router = useRouter()
const legal = computed(() => p.product.value?.kind === 'service')
const to = (name: string) => router.resolve({ path: `${level.path.value}/${name}`, query: route.query }).fullPath
const row = (id: string, label: string, summary: string, icon?: string) => ({ id, label, summary, icon, to: to(id) })
const availability = () => ({ id: 'availability', label: 'Availability', summary: `Add or change ${legal.value ? 'consultation' : 'bookable'} times in Calendar`, icon: 'i-lucide-calendar-days', to: router.resolve({ path: `/dashboard/${route.params.orgSlug}/calendar`, query: { product_id: p.product.value?.id, locationId: typeof route.query.location_id === 'string' ? route.query.location_id : undefined } }).fullPath })
const groups = computed<EditorNavigationGroup[]>(() => {
  const config = p.product.value?.booking
  const copy = p.bookingCopy.value
  const occurrence = legal.value ? 'consultation' : 'session'
  const items: EditorNavigationItem[] = config ? [] : [row('enabled', legal.value ? 'Consultation calendar' : 'Booking calendar', 'Not set up', 'i-lucide-calendar-check')]
  if (config) items.push(
    row('duration', 'Duration', config.duration_minutes ? `${config.duration_minutes} minutes` : 'Choose a duration'),
    p.product.value?.kind === 'experience' || legal.value
      ? row('location', 'Meeting format', config.held_online ? legal.value ? 'Online consultations available' : 'Online booking available' : p.product.value!.locations.length ? legal.value ? 'At assigned offices' : 'At physical locations' : legal.value ? 'No offices assigned' : 'No physical locations assigned')
      : p.locationId.value ? { id: 'location', label: 'Meeting location', summary: p.location.value?.title ?? '' } : row('location', 'Meeting location', config.held_online ? 'Online' : 'Not set'),
    row('capacity', legal.value ? 'Client limit' : 'Guest limit', config.default_capacity === null ? `No ${copy.guestLabel} limit` : config.default_capacity === 1 ? `One ${copy.guestLabel} per ${occurrence}` : config.default_capacity === 0 ? `Closed to new ${copy.guestsLabelPlural}` : `Up to ${config.default_capacity} ${copy.guestsLabelPlural} per ${occurrence}`),
    row('assignment', copy.assigneeLabel, p.assignmentSummary.value, 'i-lucide-user-round'),
    row('confirmation', 'Confirmation', config.confirmation_mode === 'instant' ? 'Confirm automatically' : 'Review each request'),
    ...((p.product.value?.kind === 'experience' || legal.value ? config.scheduling_mode === 'provider' : config.held_online)
      ? [{ id: 'hours', icon: 'i-lucide-clock', label: 'Bookable times', summary: config.assigned_team_id ? 'Each team member\'s working hours' : `The ${copy.assigneeNoun}'s working hours`, to: config.assigned_member_id ? `/dashboard/${route.params.orgSlug}/team/${config.assigned_member_id}/hours` : `/dashboard/${route.params.orgSlug}/team` }]
      : []),
    // Defaults above belong to the offering; weekly times belong to the chosen physical location.
    ...(route.query.location_id !== 'online' && (!config.held_online || p.product.value?.kind === 'experience' && (p.locationId.value || p.product.value.locations.length))
      ? p.product.value?.kind === 'experience' ? [
          availability(),
        ] : [
          row('schedule', 'Weekly schedule', !p.locationId.value ? legal.value ? 'Choose an office' : 'Choose a physical location' : p.scheduleError.value ?? `${p.location.value?.title ?? (legal.value ? 'Office unavailable' : 'Location unavailable')} · ${p.weekdays.filter(day => p.savedSlotsFor(day.value).length).map(day => day.label).join(', ') || 'No weekly times set'}`),
          availability(),
        ]
      : []),
  )
  // One flat list. Whether guests book on the website at all is the
  // organization's setting, under Website, not this product's.
  if (config) items.push(
    row('enabled', legal.value ? 'Consultation calendar' : 'Booking calendar', 'Set up', 'i-lucide-calendar-check'),
    row('payment', 'Payment', config.online_payment_required ? `Online payment required for paid ${occurrence}s` : 'No payment collected at booking', 'i-lucide-credit-card'),
  )
  return [{ id: 'booking', items }]
})
</script>
