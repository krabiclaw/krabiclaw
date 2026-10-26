<template>
 <DashboardIndexPanel id="member-availability" title="Profile & availability" :auto-open="to('hours')">
  <UAlert v-if="editor.error.value" color="error" :description="editor.error.value" />
  <UButton v-if="!editor.loaded.value && editor.error.value" color="neutral" variant="outline" @click="editor.load">Retry</UButton>
  <EditorNavigationList v-if="editor.loaded.value" :groups="groups" :active-item="level.child.value" />
 </DashboardIndexPanel>
</template>
<script setup lang="ts">
import EditorNavigationList, {type EditorNavigationGroup} from './EditorNavigationList.vue'
import {createMemberAvailabilityEditor,memberAvailabilityKey} from '~/composables/useMemberAvailabilityEditor'
const props=defineProps<{organizationId:string;memberId:string;admin?:boolean;self?:boolean}>()
const level=useRouteLevel(),route=useRoute(),router=useRouter()
const editor=createMemberAvailabilityEditor(props.organizationId,props.memberId,Boolean(props.admin),Boolean(props.self))
provide(memberAvailabilityKey,editor)
const to=(segment:string)=>router.resolve({path:`${level.path.value}/${segment}`,query:route.query}).fullPath
const groups=computed<EditorNavigationGroup[]>(()=>[
 {id:'availability',items:[{ id: 'hours', icon: 'i-lucide-clock', label:'Hours',summary:editor.record.value?.timezone??'Not set',to:to('hours')},{ id: 'time-off', icon: 'i-lucide-calendar-off', label:'Time off',summary:editor.record.value?.time_off == null?'Not set':`${editor.record.value.time_off.length} dates`,to:to('time-off')}]},
 {id:'profile',items:[{ id: 'profile', icon: 'i-lucide-contact-round', label:'Public profile',summary:!editor.record.value?'Not set':editor.record.value.public_approved?'Published':'Not published',to:to('profile')}]},
 ...(props.self?[{id:'connect',items:[{id:'google-calendar',label:'Google Calendar sync',summary:editor.record.value?.calendar_account_id?'Connected':'Not connected',lead:{icon:'i-logos-google-calendar'},to:to('google-calendar')}]}]:[]),
])
await editor.load()
</script>
