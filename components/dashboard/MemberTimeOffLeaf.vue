<template>
 <DashboardLeafPanel id="member-time-off" title="Time off" :lead="editor.record.value?.timezone ? 'Block dates when you’re away.' : 'Choose your timezone in Hours before adding time off.'" :footer="false" :error="editor.error.value">
  <!-- Nothing to edit until the schedule has been read; a failed read is the error above. -->
  <template v-if="editor.loaded.value">
    <p v-if="editor.record.value?.time_off == null" class="text-muted">Not set</p>
    <div v-for="(interval,index) in editor.record.value?.time_off ?? []" :key="index" class="border-b border-default">
     <UButton class="w-full justify-between py-6" color="neutral" variant="ghost" trailing-icon="i-lucide-chevron-right" @click="edit(index)">{{ label(interval.start) }} – {{ label(interval.end) }}</UButton>
    </div>
    <UButton class="mt-6" color="neutral" variant="outline" icon="i-lucide-plus" :disabled="!editor.record.value?.timezone" @click="edit(null)">Add time off</UButton>
  </template>
 </DashboardLeafPanel>
 <DashboardListItemDialog v-model:open="open" title="Time off" :removable="selected !== null && !editor.recovery.value" :saving="editor.saving.value" :error="editor.error.value" :save-label="editor.recovery.value ? 'Retry' : 'Save'" :save-disabled="editor.recovery.value?.status === 'conflict' || (!editor.recovery.value && (!start || !end || (selected !== null && start === originalStart && end === originalEnd)))" @save="save" @remove="remove">
  <UFormField label="Starts"><UInput v-model="start" type="datetime-local" :disabled="Boolean(editor.recovery.value)" class="w-full" /></UFormField>
  <UFormField label="Ends"><UInput v-model="end" type="datetime-local" :disabled="Boolean(editor.recovery.value)" class="w-full" /></UFormField>
  <UButton v-if="editor.recovery.value?.status === 'conflict'" color="neutral" variant="outline" :loading="editor.saving.value" @click="useSaved">Use saved values</UButton>
 </DashboardListItemDialog>
</template>
<script setup lang="ts">
import DashboardListItemDialog from './DashboardListItemDialog.vue'
import {useMemberAvailabilityEditor} from '~/composables/useMemberAvailabilityEditor'
import {localPartsAt,localDateTimeToInstant} from '~/utils/timezone'
const editor=useMemberAvailabilityEditor()
const open=ref(false),selected=ref<number|null>(null),start=ref(''),end=ref(''),originalStart=ref(''),originalEnd=ref('')
function local(value:string){const zone=editor.record.value?.timezone;if(!zone)throw new Error('Choose your timezone in Hours first.');const p=localPartsAt(new Date(value),zone);const pad=(n:number)=>String(n).padStart(2,'0');return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`}
function label(value:string){const zone=editor.record.value?.timezone;if(!zone)throw new Error('Choose your timezone in Hours first.');return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short',timeZone:zone}).format(new Date(value))}
function edit(index:number|null){editor.revert();if(!editor.record.value?.timezone||editor.record.value.time_off===null){editor.error.value='Choose your timezone in Hours first.';return}selected.value=index;const interval=index===null?null:editor.record.value.time_off[index];start.value=interval?local(interval.start):'';end.value=interval?local(interval.end):'';originalStart.value=start.value;originalEnd.value=end.value;open.value=true}
async function save(){
 if(editor.recovery.value){await editor.save('time-off');if(!editor.error.value)open.value=false;return}
 editor.revert()
 try{
  const {timezone,time_off}=editor.draft.value
  if(!timezone||time_off===null)throw new Error('Choose your timezone in Hours first.')
  const instant=(value:string)=>{const [date,time]=value.split('T');return localDateTimeToInstant(date!,time!,timezone,'reject').toISOString()}
  const interval={start:instant(start.value),end:instant(end.value)}
  if(selected.value===null)time_off.push(interval);else time_off[selected.value]=interval
  await editor.save('time-off')
  if(!editor.error.value)open.value=false
 }catch(cause){editor.error.value=getErrorMessage(cause,'Choose valid dates for your time off.')}
}
async function useSaved(){await editor.load();if(!editor.error.value)open.value=false}
async function remove(){
 if(selected.value===null)return
 editor.revert()
 if(editor.draft.value.time_off===null){editor.error.value='Choose your timezone in Hours first.';return}
 editor.draft.value.time_off.splice(selected.value,1)
 await editor.save('time-off')
 if(!editor.error.value)open.value=false
}
watch(open,value=>{if(!value)editor.revert()})
onBeforeUnmount(editor.revert)
</script>
