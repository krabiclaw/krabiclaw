<template>
  <DashboardIndexPanel id="product-booking" title="Bookings" :auto-open="groups[0]?.items[0]?.to ?? null">
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
const to = (name: string) => router.resolve({ path: `${level.path.value}/${name}`, query: route.query }).fullPath
const row = (id: string, label: string, summary: string, icon?: string) => ({ id, label, summary, icon, to: to(id) })
const groups = computed<EditorNavigationGroup[]>(() => {
  const config = p.product.value?.booking
  const items: EditorNavigationItem[] = config ? [] : [row('enabled', 'Booking calendar', 'Not set up', 'i-lucide-calendar-check')]
  if (config) items.push(
    row('duration', 'Duration', config.duration_minutes ? `${config.duration_minutes} minutes` : 'Choose a duration'),
    p.locationId.value ? { id: 'location', label: 'Meeting location', summary: p.location.value?.title ?? '' } : row('location', 'Meeting location', config.held_online ? 'Online' : 'Not set'),
    row('capacity', 'Guest limit', config.default_capacity === null ? 'No guest limit' : config.default_capacity === 1 ? 'One guest per session' : config.default_capacity === 0 ? 'Closed to new guests' : `Up to ${config.default_capacity} guests per session`),
    row('assignment', 'Who guests meet', config.assigned_team_id ? 'Any available member of the assigned team' : config.assigned_member_id ? 'Assigned team member' : 'The business schedule', 'i-lucide-users'),
    row('confirmation', 'Confirmation', config.confirmation_mode === 'instant' ? 'Confirm automatically' : 'Review each request'),
    // Online, the provider's working hours are the schedule; at a location, its weekly times are.
    ...(config.held_online
      ? [{ id: 'hours', icon: 'i-lucide-clock', label: 'Bookable times', summary: config.assigned_team_id ? 'Each team member\'s working hours' : 'Your provider\'s working hours', to: config.assigned_member_id ? `/dashboard/${route.params.orgSlug}/team/${config.assigned_member_id}/hours` : `/dashboard/${route.params.orgSlug}/team` }]
      : [
          row('schedule', 'Weekly schedule', p.scheduleError.value ? p.scheduleError.value : p.weekdays.filter(day => p.savedSlotsFor(day.value).length).map(day => day.label).join(', ') || 'No weekly times set'),
          row('sessions', 'Dated sessions', 'Add or edit individual dates', 'i-lucide-calendar-days'),
        ]),
  )
  // One flat list. Whether guests book on the website at all is the
  // organization's setting, under Website, not this product's.
  if (config) items.push(
    row('enabled', 'Booking calendar', 'Set up', 'i-lucide-calendar-check'),
    row('payment', 'Payment', config.online_payment_required ? 'Online payment required for paid sessions' : 'No payment collected at booking', 'i-lucide-credit-card'),
  )
  return [{ id: 'booking', items }]
})
</script>
