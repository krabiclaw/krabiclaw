<template>
  <DashboardLeafPanel id="google-calendar" icon="i-logos-google-calendar" title="Google Calendar" lead="See your bookings in Google Calendar." :footer="false" :error="failure || connection.error.value || calendar?.last_error || ''">
    <IntegrationConnection logo="i-logos-google-calendar" :connection="connected ? { name: 'Google Calendar', connectedAt: calendar!.created_at } : null" :disconnecting="saving" @disconnect="disconnect">
      <UButton icon="i-simple-icons-google" size="xl" block :loading="saving || connection.linking.value" @click="connect">Connect Google Calendar</UButton>
    </IntegrationConnection>
    <p v-if="data?.cleanup_pending" class="mt-6 text-sm text-muted">Disconnecting…</p>
    <dl v-if="connected" class="mt-8 border-b border-default pb-6"><dt class="text-sm text-muted">Booking calendar</dt><dd class="mt-1 text-base text-highlighted">{{ calendar?.calendar_name }}</dd></dl>
    <UButton v-if="calendar?.status === 'error' || data?.cleanup_pending || failure" class="mt-6" color="neutral" variant="outline" :loading="saving" @click="retry">Retry</UButton>
  </DashboardLeafPanel>
</template>
<script setup lang="ts">
import IntegrationConnection from './IntegrationConnection.vue'
import { INTEGRATION_SCOPES, type GoogleCalendarIntegration } from '~/shared/organization-settings'
const route = useRoute()
const organizationId = await useDashboardOrganizationId()
const api = `/api/organizations/${organizationId}/integrations/google-calendar`
const connection = useIntegrationConnection('google', INTEGRATION_SCOPES['google-calendar'])
const failure = ref(''), saving = ref(false)
const isCalendarResponse = (value: unknown): value is {calendar:GoogleCalendarIntegration|null;cleanup_pending:boolean} => {
 if (!isRecord(value) || typeof value.cleanup_pending !== 'boolean') return false
 const calendar = value.calendar
 return calendar === null || (isRecord(calendar) && ['revision','account_id','calendar_id','calendar_name','created_at','updated_at'].every(field => typeof calendar[field] === 'string')
  && ['active','disabled','error'].includes(String(calendar.status)) && (calendar.last_error === null || typeof calendar.last_error === 'string'))
}
const { data, error, refresh } = await useAsyncData(`google-calendar:${organizationId}`, () => applicationFetch(api, {validate:isCalendarResponse}))
const calendar = computed(() => data.value?.calendar ?? null)
const connected = computed(() => calendar.value && calendar.value.status !== 'disabled')
watch(error, value => { if(value) failure.value = getErrorMessage(value, 'Could not load Google Calendar.') }, {immediate:true})
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
