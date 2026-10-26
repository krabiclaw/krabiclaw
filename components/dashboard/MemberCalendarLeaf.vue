<template>
 <DashboardLeafPanel id="personal-google-calendar" icon="i-logos-google-calendar" title="Google Calendar sync" lead="Busy on your calendar? Booked out on your website. New bookings show up on your calendar." :footer="entitled && Boolean(editor.record.value?.calendar_account_id)" :disabled="enabled === Boolean(editor.record.value?.calendar_ids.length)" :saving="editor.saving.value" :error="editor.error.value || connection.error.value || editor.record.value?.busy_error || ''" @cancel="revert" @save="save">
  <!-- Nothing to edit until the schedule has been read; a failed read is the error above. -->
  <template v-if="editor.loaded.value">
    <!-- The sync is Business. A selection kept from a lapsed plan can still be turned off. -->
    <OfferCard v-if="!entitled && !editor.record.value?.calendar_ids.length" :offer="offer('calendar_sync')" />
    <template v-else-if="editor.record.value?.calendar_account_id">
     <div class="flex items-center gap-3 pb-6"><UIcon name="i-logos-google-calendar" class="size-8" /><span class="text-base font-medium text-highlighted">Google Calendar</span><UBadge class="ml-auto" color="success" variant="subtle">Connected</UBadge></div>
     <SettingRow v-model="enabled" label="Check my calendar for conflicts" description="Clients can't book you when Google Calendar shows you busy. Only busy times are read, never what an event is." :disabled="!entitled && !enabled" />
    </template>
    <template v-else>
     <p v-if="!editor.record.value?.timezone" class="mb-6 text-muted">Choose your timezone in Hours before connecting Google Calendar.</p>
     <UButton icon="i-simple-icons-google" size="xl" block :disabled="!editor.record.value?.timezone" :loading="editor.saving.value || connection.linking.value" @click="connect">Connect Google Calendar</UButton>
    </template>
    <UButton v-if="editor.record.value?.busy_error || (connection.accountId.value && editor.error.value)" class="mt-6" color="neutral" variant="outline" :loading="editor.saving.value" @click="save">Retry</UButton>
  </template>
 </DashboardLeafPanel>
</template>
<script setup lang="ts">
import SettingRow from './SettingRow.vue'
import OfferCard from './OfferCard.vue'
import { offer } from '~/shared/offers'
import {useMemberAvailabilityEditor} from '~/composables/useMemberAvailabilityEditor'
import {MEMBER_BUSY_SCOPES} from '~/shared/member-scheduling'
const editor=useMemberAvailabilityEditor()
const entitled=computed(()=>editor.calendarSync.value)
const connection=useIntegrationConnection('google',MEMBER_BUSY_SCOPES)
const enabled=ref(Boolean(editor.record.value?.calendar_ids.length))
function revert(){enabled.value=Boolean(editor.record.value?.calendar_ids.length)}
watch(()=>editor.record.value,revert,{immediate:true})
async function connect(){if(!editor.record.value?.timezone){editor.error.value='Choose your timezone in Hours first.';return}await connection.connect({access_type:'offline',prompt:'consent select_account'})}
async function save(){await editor.calendar(enabled.value || Boolean(connection.accountId.value),connection.accountId.value??editor.record.value?.calendar_account_id??undefined);if(!editor.error.value)await connection.clear()}
onMounted(async()=>{if(connection.accountId.value){enabled.value=true;await save()}})
</script>
