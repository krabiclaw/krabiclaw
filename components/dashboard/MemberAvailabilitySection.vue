<template>
 <DashboardIndexPanel :id="`member-${section}`" :title="section === 'hours' ? 'Hours' : 'Public profile'" :auto-open="groups[0]?.items[0]?.to">
  <EditorNavigationList :groups="groups" :active-item="level.child.value" />
 </DashboardIndexPanel>
</template>
<script setup lang="ts">
import EditorNavigationList,{type EditorNavigationGroup} from './EditorNavigationList.vue'
import {useMemberAvailabilityEditor} from '~/composables/useMemberAvailabilityEditor'
import {timezoneLabel} from '~/utils/timezone'
import {WEEK_ROWS} from '~/lib/components/workspace/location/hours'
const props=defineProps<{section:'hours'|'profile'}>()
const editor=useMemberAvailabilityEditor(),level=useRouteLevel(),route=useRoute(),router=useRouter()
const to=(segment:string)=>router.resolve({path:`${level.path.value}/${segment}`,query:route.query}).fullPath
const groups=computed<EditorNavigationGroup[]>(()=>props.section==='hours'?[
 {id:'timezone',items:[{ id: 'timezone', icon: 'i-lucide-globe-2', label:'Timezone',summary:editor.record.value?.timezone?timezoneLabel(editor.record.value.timezone):'Not set',to:to('timezone')}]},
 {id:'week',items:WEEK_ROWS.map(day=>({id:day.slug,label:day.label,summary:editor.record.value?.weekly == null?'Not set':editor.record.value.weekly.filter(w=>w.weekday===day.value).map(w=>`${w.start}–${w.end}`).join(', ')||'Unavailable',to:to(day.slug)}))},
]:[{id:'profile',items:[{id:'name',label:'Name',summary:editor.record.value?.public_name??undefined,to:to('name')},{id:'photo',label:'Photo',to:to('photo')},{id:'bio',label:'About you',summary:editor.record.value?.public_bio??undefined,to:to('bio')},...(editor.admin?[{id:'published',label:'Publish profile',summary:editor.record.value?.public_approved?'Published':'Not published',to:to('published')}]:[])]}])
</script>
