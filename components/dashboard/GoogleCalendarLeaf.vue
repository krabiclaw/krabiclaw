<template>
  <DashboardLeafPanel id="google-calendar" icon="i-logos-google-calendar" title="Google Calendar sync" :lead="integrationDefinition('google-calendar').purpose" :footer="false" :error="failure || connection.error.value || calendar?.last_error || data?.sync?.last_error || ''">
    <!-- The sync is Business. A calendar connected under a lapsed plan can still be disconnected. -->
    <OfferCard v-if="!entitled && !connected" :offer="offer('calendar_sync')" />
    <template v-else>
      <IntegrationLeaf integration="google-calendar" :connection="connected ? { name: calendar!.calendar_name, connectedAt: calendar!.created_at, through: integrations?.summary.value?.google_calendar?.connected_through ?? null, status: calendar!.status, lastError: calendar!.last_error } : null" :disconnecting="saving" @disconnect="disconnect">
        <UButton icon="i-simple-icons-google" size="xl" block :loading="saving || connection.linking.value" @click="connect">Connect Google Calendar</UButton>
        <!-- How the sync works, before it is on: the three sections the connected leaf edits. -->
        <EditorNavigationList :groups="[{ id: 'how', items: howItWorks }]" />
        <template #connected>
          <EditorNavigationList :groups="[{ id: 'conflicts', label: 'Check for conflicts', items: conflictRows }, { id: 'bookings', label: 'Add bookings to', items: bookingRows }]" />
          <section class="space-y-0">
            <h2 class="text-sm font-semibold text-muted">Sync changes from Google</h2>
            <SettingRow v-model="reschedules" label="Reschedules" description="Drag a booking to a new time in Google Calendar and it moves here too, if that time is free. Your client gets the same email as any reschedule." :disabled="saving || !entitled" />
            <SettingRow :model-value="true" label="Deleted events" description="Deleting a booking's event never cancels it or refunds anyone. The event comes back, the booking shows on Today as needing your decision, and you're emailed, so you can cancel it properly here." disabled />
          </section>
        </template>
      </IntegrationLeaf>
    </template>
    <p v-if="data?.cleanup_pending" class="mt-6 text-sm text-muted">Disconnecting…</p>
    <UButton v-if="calendar?.status === 'error' || data?.cleanup_pending || failure" class="mt-6" color="neutral" variant="outline" :loading="saving" @click="retry">Retry</UButton>
  </DashboardLeafPanel>
</template>
<script setup lang="ts">
import IntegrationLeaf from './IntegrationLeaf.vue'
import OfferCard from './OfferCard.vue'
import SettingRow from './SettingRow.vue'
import EditorNavigationList, { type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'
import { integrationDefinition } from '~/shared/integrations'
import { offer } from '~/shared/offers'
import { integrationsKey } from '~/pages/dashboard/[orgSlug]/integrations.vue'
import { INTEGRATION_SCOPES, type GoogleCalendarIntegration } from '~/shared/organization-settings'
const route = useRoute()
// The Integrations summary names the KrabiClaw user who linked the account; the leaf's own read does not.
const integrations = inject(integrationsKey, null)
const organizationId = await useDashboardOrganizationId()
const dashboard = useDashboardOrganization()
const entitled = computed(() => dashboard.entitlements.value.calendar_sync === true)
const api = `/api/organizations/${organizationId}/integrations/google-calendar`
const connection = useIntegrationConnection('google', INTEGRATION_SCOPES['google-calendar'])
const failure = ref(''), saving = ref(false)
interface CalendarSync { reschedules: boolean; watch_expires_at: string | null; last_pulled_at: string | null; last_error: string | null }
const isCalendarResponse = (value: unknown): value is {calendar:GoogleCalendarIntegration|null;cleanup_pending:boolean;sync:CalendarSync|null} => {
 if (!isRecord(value) || typeof value.cleanup_pending !== 'boolean') return false
 const calendar = value.calendar
 const sync = value.sync
 return (calendar === null || (isRecord(calendar) && ['revision','account_id','calendar_id','calendar_name','created_at','updated_at'].every(field => typeof calendar[field] === 'string')
  && ['active','disabled','error'].includes(String(calendar.status)) && (calendar.last_error === null || typeof calendar.last_error === 'string')))
  && (sync === null || sync === undefined || (isRecord(sync) && typeof sync.reschedules === 'boolean'))
}
const { data, error, refresh } = await useAsyncData(`google-calendar:${organizationId}`, () => applicationFetch(api, {validate:isCalendarResponse}))
const calendar = computed(() => data.value?.calendar ?? null)
const connected = computed(() => calendar.value && calendar.value.status !== 'disabled')
watch(error, value => { if(value) failure.value = getErrorMessage(value, 'Could not load Google Calendar.') }, {immediate:true})
// Who checks their calendar for conflicts: each member turns it on for themselves under My account.
type MemberRow = { id: string; name: string; self: boolean; scheduling: { calendar_ids: string[]; calendar_status: string } | null }
const isMembers = (value: unknown): value is { members: MemberRow[] } => isRecord(value) && Array.isArray(value.members) && value.members.every(member => isRecord(member) && typeof member.name === 'string')
const { data: members, error: membersError } = await useAsyncData(`google-calendar-members:${organizationId}`, () => applicationFetch(`/api/organizations/${organizationId}/members/scheduling`, { validate: isMembers }))
const checking = computed(() => (members.value?.members ?? []).filter(member => member.scheduling?.calendar_ids.length))
// A count only when the read answered; a failed read says so rather than counting nobody.
const conflictRows = computed<EditorNavigationItem[]>(() => [{
  id: 'members', icon: 'i-lucide-users',
  label: members.value ? `${checking.value.length} of ${members.value.members.length} team members checking their calendar` : 'Team members checking their calendar',
  ...(membersError.value ? { status: 'error' as const, summary: getErrorMessage(membersError.value, 'The team could not be read.') } : {}),
  ...(membersError.value ? {} : { summary: 'Times someone is busy in Google Calendar can’t be booked with them. Only busy times are read, never what an event is. Each member turns this on under My account → Google Calendar sync.' }),
}])
const bookingRows = computed<EditorNavigationItem[]>(() => [{
  id: 'calendar', label: calendar.value?.calendar_name ?? 'KrabiClaw', icon: 'i-lucide-calendar-check',
  summary: 'Every booking appears here with the guest’s name. It updates when a booking moves and disappears when it’s cancelled.',
  to: calendar.value ? `https://calendar.google.com/calendar/u/0/r?cid=${btoa(calendar.value.calendar_id).replace(/=+$/, '')}` : undefined,
}])
const howItWorks: EditorNavigationItem[] = [
  { id: 'conflicts', label: 'Check for conflicts', icon: 'i-lucide-users', summary: 'Times a team member is busy in Google Calendar can’t be booked with them.' },
  { id: 'bookings', label: 'Add bookings to your calendar', icon: 'i-lucide-calendar-check', summary: 'Every booking appears on a KrabiClaw calendar in your Google account, and follows the booking.' },
  { id: 'changes', label: 'Sync changes from Google', icon: 'i-lucide-refresh-cw', summary: 'Move a booking there and it moves here, and your client is told. Deleting one never cancels it.' },
]
const reschedules = computed({
  get: () => data.value?.sync?.reschedules ?? true,
  set: value => { void run(async () => { await applicationFetch(`${api}/settings`, { method: 'POST', body: { reschedules: value }, validate: isCalendarMutation }) }) },
})
async function run(action:()=>Promise<void>) {
 saving.value=true; failure.value=''
 try { await action(); await refresh(); if(error.value)throw error.value; await refreshNuxtData(`dashboard-integrations:${String(route.params.orgSlug)}`) }
 catch(cause){failure.value=getErrorMessage(cause,'Google Calendar could not be updated.')}
 finally {saving.value=false}
}
async function finishConnection() {
 await run(async()=>{await applicationFetch(`${api}/connect`,{method:'POST',body:{account_id:connection.accountId.value},validate:isCalendarMutation}); await connection.clear()})
}
const isCalendarMutation = (value: unknown): value is {success:true} => isRecord(value) && value.success === true
async function connect(){await connection.connect({access_type:'offline',prompt:'consent select_account'})}
async function disconnect(){await run(async()=>{await applicationFetch(`${api}/disconnect`,{method:'POST',validate:isCalendarMutation})})}
async function retry(){if(connection.accountId.value)await finishConnection();else await run(async()=>{await applicationFetch(`${api}/sync`,{method:'POST',validate:isCalendarMutation})})}
onMounted(async()=>{if(connection.accountId.value)await finishConnection()})
</script>
