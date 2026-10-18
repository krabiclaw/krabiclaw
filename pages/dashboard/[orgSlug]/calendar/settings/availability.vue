<template>
 <DashboardIndexPanel id="calendar-availability" title="Availability">
  <UAlert v-if="editor?.error.value" color="error" :description="editor?.error.value" />
  <EditorNavigationList :groups="groups" :active-item="level.child.value" />
 </DashboardIndexPanel>
</template>
<script setup lang="ts">
import EditorNavigationList, {type EditorNavigationGroup} from '~/components/dashboard/EditorNavigationList.vue'
import {useCalendarLocationEditor} from '~/composables/useCalendarLocationEditor'
import {hoursSummary,noticeSummary,seatsSummary} from '~/shared/availability-settings'
definePageMeta({layout:'dashboard',key:route=>String(route.query.locationId??'business')})
const level=useRouteLevel(),route=useRoute(),router=useRouter()
const organizationId=await useDashboardOrganizationId()
const editor=typeof route.query.locationId==='string'?await useCalendarLocationEditor(null):null
const to=(segment:string)=>router.resolve({path:`${level.path.value}/${segment}`,query:route.query}).fullPath
const groups=computed<EditorNavigationGroup[]>(()=>[
 ...(editor?.location.value?[{id:'hours',items:[
 { id: 'hours', icon: 'i-lucide-clock', label:'Hours',summary:hoursSummary(editor.hoursForm.value.hours),to:to('hours')},
 {id:'duration',label:'Reservation duration',summary:editor.reservationForm.value.duration_minutes ? `${editor.reservationForm.value.duration_minutes} minutes` : 'Not set',to:to('duration')},
 { id: 'notice', icon: 'i-lucide-alarm-clock', label:'Advance notice',summary:noticeSummary(editor.reservationForm.value.advance_notice_minutes),to:to('notice')},
 { id: 'seats', icon: 'i-lucide-armchair', label:'Seats per time slot',summary:seatsSummary(editor.reservationForm.value.slot_capacity),to:to('seats')},
 { id: 'deposit', icon: 'i-lucide-wallet', label:'Reservation deposit',summary:editor.reservationForm.value.deposit_required ? 'Required' : 'Not required',to:to('deposit')},
 ]}]:[]),
 {id:'personal',items:[{ id: 'your-availability', icon: 'i-lucide-calendar-clock', label:'Your availability',to:`/dashboard/account/profile/calendar/${encodeURIComponent(organizationId)}`}]},
 {id:'connect',label:'Connect calendars',items:[{id:'google-calendar',label:'Google Calendar',lead:{icon:'i-logos-google-calendar'},to:to('google-calendar')}]},
])
</script>
