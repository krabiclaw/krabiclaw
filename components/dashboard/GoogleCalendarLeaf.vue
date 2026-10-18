<template>
  <DashboardLeafPanel id="google-calendar" icon="i-logos-google-calendar" title="Google Calendar" :lead="integrationDefinition('google-calendar').purpose" :footer="false" :error="failure || connection.error.value || calendar?.last_error || ''">
    <IntegrationLeaf integration="google-calendar" :connection="connected ? { name: calendar!.calendar_name, connectedAt: calendar!.created_at, through: integrations?.summary.value?.google_calendar?.connected_through ?? null, status: calendar!.status, lastError: calendar!.last_error } : null" :disconnecting="saving" @disconnect="disconnect">
      <UButton icon="i-simple-icons-google" size="xl" block :loading="saving || connection.linking.value" @click="connect">Connect Google Calendar</UButton>
    </IntegrationLeaf>
    <p v-if="data?.cleanup_pending" class="mt-6 text-sm text-muted">Disconnecting…</p>
    <UButton v-if="calendar?.status === 'error' || data?.cleanup_pending || failure" class="mt-6" color="neutral" variant="outline" :loading="saving" @click="retry">Retry</UButton>
  </DashboardLeafPanel>
</template>
<script setup lang="ts">
import IntegrationLeaf from './IntegrationLeaf.vue'
import { integrationDefinition } from '~/shared/integrations'
import { integrationsKey } from '~/pages/dashboard/[orgSlug]/integrations.vue'
import { INTEGRATION_SCOPES, type GoogleCalendarIntegration } from '~/shared/organization-settings'
const route = useRoute()
// The Integrations summary names whose linked account the calendar acts through; the leaf's own read does not.
const integrations = inject(integrationsKey, null)
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
