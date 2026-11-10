<template>
 <DashboardIndexPanel id="calendar-availability" title="Availability">
  <UAlert v-if="editor?.error.value" color="error" :description="editor?.error.value" />
  <EditorNavigationList :groups="groups" :active-item="level.child.value" />
 </DashboardIndexPanel>
</template>
<script setup lang="ts">
import EditorNavigationList, {type EditorNavigationGroup} from '~/components/dashboard/EditorNavigationList.vue'
import {useCalendarLocationEditor} from '~/composables/useCalendarLocationEditor'
import {hoursSummary} from '~/shared/availability-settings'
definePageMeta({layout:'dashboard',key:route=>String(route.query.locationId??'business')})
const level=useRouteLevel(),route=useRoute(),router=useRouter()
const organizationId=useDashboardOrganizationId()
const editor=typeof route.query.locationId==='string'?await useCalendarLocationEditor(null):null
const to=(segment:string)=>router.resolve({path:`${level.path.value}/${segment}`,query:route.query}).fullPath
const groups=computed<EditorNavigationGroup[]>(()=>[
 ...(editor?.location.value?[{id:'hours',items:[
 { id: 'hours', icon: 'i-lucide-clock', label:'Hours',summary:hoursSummary(editor.hoursForm.value.hours),to:to('hours')},
 ]}]:[]),
 {id:'personal',items:[{ id: 'your-availability', icon: 'i-lucide-calendar-clock', label:'Profile & availability',to:`/dashboard/account/profile/calendar/${encodeURIComponent(organizationId)}`}]},
 {id:'connect',items:[{id:'google-calendar',label:'Google Calendar',lead:{icon:'i-logos-google-calendar'},to:to('google-calendar')}]},
])
</script>
