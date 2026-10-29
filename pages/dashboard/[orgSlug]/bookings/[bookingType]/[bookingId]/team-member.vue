<template>
 <DashboardLeafPanel v-if="b.canReassignBooking.value" id="booking-team-member" :title="assigneeLabel" :lead="`The time stays the same. Your ${copy?.guestLabel} must accept before the assigned ${assigneeNoun} changes.`" save-label="Send request" :saving="saving" :disabled="!selected || selected === b.booking.value?.assignedMemberId" :error="error || (loadError ? getErrorMessage(loadError,`Available ${assigneeNoun}s could not be loaded.`) : '')" @cancel="reset" @save="save">
  <URadioGroup v-if="data?.members.length" v-model="selected" :items="items" variant="card" />
  <UAlert v-else-if="data" color="warning" :description="`Add working hours for an available ${assigneeNoun} before requesting this change.`" />
 </DashboardLeafPanel>
</template>
<script setup lang="ts">
import {bookingEditorKey} from '~/components/dashboard/BookingDetails.vue'
import { getVerticalCopy } from '~/utils/vertical-copy'
definePageMeta({layout:'dashboard'})
const b=inject(bookingEditorKey)!,api=useDashboardApi(),level=useRouteLevel()
const copy = computed(() => b.booking.value ? getVerticalCopy(b.booking.value.vertical) : null)
const assigneeNoun = computed(() => b.booking.value?.vertical === 'service' ? copy.value!.assigneeNoun : 'team member')
const assigneeLabel = computed(() => b.booking.value?.vertical === 'service' ? copy.value!.assigneeLabel : 'Team member')
watchEffect(() => { if (!b.canReassignBooking.value) showError(createError({ statusCode: 404, statusMessage: 'Page not found' })) })
const selected=ref(''),saving=ref(false),error=ref(''),key=ref<string|null>(null)
function reset(){selected.value=b.booking.value?.assignedMemberId??'';key.value=null}
watch(b.booking,reset,{immediate:true});watch(selected,()=>{key.value=null})
type Member={id:string;name:string;image:string|null;current:boolean;available:boolean}
// Available attorneys use the same offering and allocation checks as the proposal.
const {data,error:loadError}=await useAsyncData(()=>`booking-team:${b.booking.value?.operationalBookingId}`,async()=>{
 const booking=b.booking.value
 if(!b.canReassignBooking.value || !booking?.operationalBookingId)return null
 return await api(`/api/dashboard/bookings/booking/${booking.operationalBookingId}/provider`,{validate:(v):v is {members:Member[]}=>isRecord(v)&&Array.isArray(v.members)&&v.members.every(m=>isRecord(m)&&typeof m.id==='string'&&typeof m.name==='string'&&(m.image===null||typeof m.image==='string')&&typeof m.current==='boolean'&&typeof m.available==='boolean')})
},{watch:[b.booking]})
const items=computed(()=>(data.value?.members??[]).map(member=>({label:member.name,value:member.id,description:member.current?'Current':member.available?'Free at this time':'Not free at this time',disabled:!member.current&&!member.available})))
async function save(){const booking=b.booking.value;if(!booking)return;saving.value=true;error.value='';key.value??=crypto.randomUUID();try{await api(`/api/dashboard/bookings/booking/${booking.operationalBookingId}/provider`,{method:'POST',body:{member_id:selected.value,expected_updated_at:booking.operationalUpdatedAt,idempotency_key:key.value},validate:(v):v is {session_id:string;assigned_member_id:string|null;change_status:string;request_id:string}=>isRecord(v)&&typeof v.session_id==='string'&&(v.assigned_member_id===null||typeof v.assigned_member_id==='string')&&typeof v.request_id==='string'&&['awaiting_guest_acceptance','accepted','declined'].includes(String(v.change_status))});await b.refresh();await navigateTo(level.to.value??'/dashboard')}catch(cause){error.value=getErrorMessage(cause,'The change request could not be sent.')}finally{saving.value=false}}
</script>
