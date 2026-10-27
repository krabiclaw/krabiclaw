<template>
 <DashboardLeafPanel :id="`member-${concern}`" :title="title" :lead="lead" :saving="editor.saving.value" :disabled="saveDisabled" :save-label="editor.recovery.value ? 'Retry' : 'Save'" :error="editor.error.value" @cancel="editor.revert" @save="save">
  <!-- Nothing to edit until the schedule has been read; a failed read is the error above. -->
  <template v-if="editor.loaded.value">
    <BookingTimezoneSelect v-if="concern === 'timezone'" v-model="editor.draft.value.timezone" :options="timezoneOptions" />
    <p v-else-if="day && !editor.record.value?.timezone" class="text-muted">Not set</p>
    <template v-else-if="day">
     <SettingRow :model-value="slots.length > 0" label="Available" @update:model-value="setAvailable" />
     <div v-for="(slot,index) in slots" :key="index" class="flex items-end gap-3 py-6">
      <UFormField label="Starts at" class="flex-1"><UInput v-model="slot.start" type="time" class="w-full" /></UFormField>
      <UFormField label="Ends at" class="flex-1"><UInput v-model="slot.end" type="time" class="w-full" /></UFormField>
      <UButton icon="i-lucide-trash-2" color="neutral" variant="ghost" aria-label="Remove hours" @click="remove(slot)" />
     </div>
     <UButton v-if="slots.length" color="neutral" variant="outline" icon="i-lucide-plus" @click="add">Add hours</UButton>
    </template>
    <template v-else-if="concern === 'name'"><p class="mb-2 text-sm text-muted">{{ 100 - editor.draft.value.public_name.length }}/100 available</p><UInput v-model="editor.draft.value.public_name" aria-label="Name" maxlength="100" variant="none" :ui="{ base: 'px-0 text-2xl md:text-2xl' }" class="w-full" /></template>
    <template v-else-if="concern === 'bio'"><p class="mb-2 text-sm text-muted">{{ 2000 - editor.draft.value.public_bio.length }}/2000 available</p><UTextarea ref="bioTextarea" v-model="editor.draft.value.public_bio" aria-label="About you" maxlength="2000" variant="none" :rows="1" :ui="{ base: 'p-0 resize-none text-base leading-relaxed' }" class="w-full" /></template>
    <template v-else-if="concern === 'photo' && editor.self">
     <UAvatar :src="editor.draft.value.public_photo_url ?? undefined" icon="i-lucide-user" size="3xl" class="mb-6" />
     <div class="flex gap-3"><UButton color="neutral" variant="outline" :disabled="!accountPhoto" @click="editor.draft.value.public_photo_url = accountPhoto">Use your account photo</UButton><UButton v-if="editor.draft.value.public_photo_url" color="neutral" variant="ghost" @click="editor.draft.value.public_photo_url = null">Remove photo</UButton></div>
    </template>
    <template v-else-if="concern === 'photo'">
     <MediaPicker :organization-id="editor.organizationId" accept="image" title="Select profile photo" :disabled="editor.saving.value" @change="photo">
      <span class="inline-flex items-center gap-4"><UAvatar :src="editor.draft.value.public_photo_url ?? undefined" icon="i-lucide-user" size="3xl" /><span class="text-sm font-medium text-highlighted">{{ editor.draft.value.public_photo_url ? 'Change photo' : 'Add a photo' }}</span></span>
     </MediaPicker>
     <UButton v-if="editor.draft.value.public_photo_url" class="mt-4" color="neutral" variant="ghost" :disabled="editor.saving.value" label="Remove photo" @click="photo(null)" />
    </template>
    <SettingRow v-else-if="concern === 'published'" v-model="editor.draft.value.public_approved" label="Publish profile" />
    <UButton v-if="editor.recovery.value?.status === 'conflict'" class="mt-6" color="neutral" variant="outline" :loading="editor.saving.value" @click="editor.load">Use saved values</UButton>
  </template>
 </DashboardLeafPanel>
</template>
<script setup lang="ts">
import {useTextareaAutosize} from '@vueuse/core'
import BookingTimezoneSelect from '~/components/booking/BookingTimezoneSelect.vue'
import MediaPicker,{type MediaSummary} from '~/lib/components/workspace/media/MediaPicker.vue'
import SettingRow from './SettingRow.vue'
import {accountEditorKey} from './AccountProfilePage.vue'
import {useMemberAvailabilityEditor} from '~/composables/useMemberAvailabilityEditor'
import {WEEK_ROWS} from '~/lib/components/workspace/location/hours'
import {TIMEZONE_OPTIONS} from '~/utils/timezone'
import type {WorkingHours} from '~/shared/member-scheduling'
const props=defineProps<{concern:string}>()
const editor=useMemberAvailabilityEditor()
const account=inject(accountEditorKey,null)
const day=computed(()=>WEEK_ROWS.find(d=>d.slug===props.concern))
const labels:Record<string,string>={timezone:'Timezone',name:'Name',photo:'Photo',bio:'About you',published:'Publish profile'}
const title=computed(()=>day.value?.label??labels[props.concern]??'')
const lead=computed(()=>{
 if(props.concern==='published')return 'Publish this name, photo and bio on the offerings you host. A public name is required. Working hours and existing booking assignments stay unchanged.'
 if(['name','photo','bio'].includes(props.concern))return 'Saving changes removes approval until an owner or admin publishes the profile again.'
 if(!editor.record.value?.timezone)return props.concern==='timezone'?'Choose a timezone before adding working hours and time off.':day.value?'Choose your timezone in Hours before adding working hours.':undefined
 return undefined
})
const saveDisabled=computed(()=>!editor.loaded.value || !editor.dirty.value || editor.recovery.value?.status==='conflict' || (props.concern==='timezone'?!editor.draft.value.timezone:Boolean(day.value)&&!editor.record.value?.timezone))
const accountPhoto=computed(()=>account?.photoPreview.value??account?.sessionData.value?.user?.image??null)
const bioTextarea=useTemplateRef('bioTextarea')
useTextareaAutosize({element:computed(()=>bioTextarea.value?.textareaRef),input:computed(()=>editor.draft.value.public_bio)})
watch(()=>props.concern,()=>editor.revert())
watchEffect(()=>{if(!title.value || (props.concern==='published'&&!editor.admin))showError(createError({statusCode:404,statusMessage:'Page not found'}))})
const timezoneOptions=computed(()=>[...new Set([...(editor.draft.value.timezone?[editor.draft.value.timezone]:[]),...TIMEZONE_OPTIONS])])
const slots=computed(()=>editor.draft.value.weekly?.filter(slot=>slot.weekday===day.value?.value)??[])
function remove(slot:WorkingHours){if(editor.draft.value.weekly)editor.draft.value.weekly=editor.draft.value.weekly.filter(w=>w!==slot)}
function add(){if(day.value&&editor.draft.value.weekly)editor.draft.value.weekly.push({weekday:day.value.value,start:'09:00',end:'17:00'})}
function setAvailable(value:boolean){if(value)add();else if(day.value&&editor.draft.value.weekly)editor.draft.value.weekly=editor.draft.value.weekly.filter(w=>w.weekday!==day.value!.value)}
async function save(){await editor.save(day.value?'weekly':props.concern)}
function photo(asset:MediaSummary|null){if(asset&&!asset.public_url){editor.error.value='This photo is not ready yet.';return}editor.draft.value.public_photo_url=asset?.public_url??null}
onBeforeUnmount(editor.revert)
</script>
