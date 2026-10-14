<template>
 <DashboardLeafPanel id="personal-google-calendar" icon="i-logos-google-calendar" title="Google Calendar" lead="Hide times when your personal calendar is busy." :footer="Boolean(editor.record.value?.calendar_account_id)" :disabled="enabled === Boolean(editor.record.value?.calendar_ids.length)" :saving="editor.saving.value" :error="editor.error.value || connection.error.value || editor.record.value?.busy_error || ''" @cancel="revert" @save="save">
  <!-- Nothing to edit until the schedule has been read; a failed read is the error above. -->
  <template v-if="editor.loaded.value">
    <template v-if="editor.record.value?.calendar_account_id">
     <div class="flex items-center gap-3 pb-6"><UIcon name="i-logos-google-calendar" class="size-8" /><span class="text-base font-medium text-highlighted">Google Calendar</span><UBadge class="ml-auto" color="success" variant="subtle">Connected</UBadge></div>
     <SettingRow v-model="enabled" label="Avoid double bookings" />
    </template>
    <UButton v-else icon="i-simple-icons-google" size="xl" block :loading="editor.saving.value || connection.linking.value" @click="connect">Connect Google Calendar</UButton>
    <UButton v-if="editor.record.value?.busy_error || (connection.accountId.value && editor.error.value)" class="mt-6" color="neutral" variant="outline" :loading="editor.saving.value" @click="save">Retry</UButton>
  </template>
 </DashboardLeafPanel>
</template>
<script setup lang="ts">
import SettingRow from './SettingRow.vue'
import {useMemberAvailabilityEditor} from '~/composables/useMemberAvailabilityEditor'
import {MEMBER_BUSY_SCOPES} from '~/shared/member-scheduling'
const editor=useMemberAvailabilityEditor()
const connection=useIntegrationConnection('google',MEMBER_BUSY_SCOPES)
const enabled=ref(Boolean(editor.record.value?.calendar_ids.length))
function revert(){enabled.value=Boolean(editor.record.value?.calendar_ids.length)}
watch(()=>editor.record.value,revert,{immediate:true})
async function connect(){if(!editor.record.value){editor.error.value='Choose your timezone in Hours first.';return}await connection.connect({access_type:'offline',prompt:'consent select_account'})}
async function save(){await editor.calendar(enabled.value || Boolean(connection.accountId.value),connection.accountId.value??editor.record.value?.calendar_account_id??undefined);if(!editor.error.value)await connection.clear()}
onMounted(async()=>{if(connection.accountId.value){enabled.value=true;await save()}})
</script>
