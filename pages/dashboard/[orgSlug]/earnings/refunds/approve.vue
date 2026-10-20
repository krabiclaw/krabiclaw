<template>
 <DashboardLeafPanel id="approve-refund" title="Approve refund" :footer="false">
  <UAlert v-if="error" color="error" :description="error.message" />
  <template v-else-if="data"><p class="font-semibold">{{ WORDING[data.action].question }} {{ paymentMoney(data.amount,data.currency) }}?</p><p v-if="data.note" class="mt-2 text-muted">“{{ data.note }}”</p><p class="mt-2">The refund comes from your Stripe balance. KrabiClaw Payments fees aren’t returned after a refund or dispute.</p><UButton class="mt-4" color="error" :loading="working" :disabled="done" @click="approve">{{ WORDING[data.action].button }}</UButton><p v-if="done" class="mt-3">Refund submitted to Stripe.</p></template>
  <UAlert v-if="failure" class="mt-4" color="error" :description="failure" />
 </DashboardLeafPanel>
</template>
<script setup lang="ts">
import {paymentMoney} from '~/shared/payment-display'
import {isCurrencyCode} from '~/shared/currencies'
definePageMeta({layout:'dashboard'})
const route=useRoute(),api=useDashboardApi(),working=ref(false),done=ref(false),failure=ref('')
type Action='refund'|'reject_booking'|'cancel_booking'|'cancel_reservation'
type Approval={id:string;action:Action;amount:number;note:string|null;currency:string;payment_id:string}
// Declining or cancelling a paid booking returns the whole payment with it, as Airbnb's host cancellation does.
const WORDING:Record<Action,{question:string;button:string}>={
 refund:{question:'Send a refund of',button:'Approve and send refund'},
 reject_booking:{question:'Decline the booking and refund',button:'Approve decline and full refund'},
 cancel_reservation:{question:'Cancel the reservation and refund',button:'Approve cancellation and full refund'},
 cancel_booking:{question:'Cancel the booking and refund',button:'Approve cancellation and full refund'},
}
const {data,error}=await useAsyncData(()=>`refund-approval:${route.params.orgSlug}:${route.query.id}`,()=>api<Approval>('/api/dashboard/payments/authorization',{query:{id:String(route.query.id)},validate:(v:unknown):v is Approval=>isRecord(v)&&typeof v.id==='string'&&(v.action==='refund'||v.action==='reject_booking'||v.action==='cancel_booking'||v.action==='cancel_reservation')&&Number.isSafeInteger(v.amount)&&Number(v.amount)>0&&(v.note===null||typeof v.note==='string')&&isCurrencyCode(v.currency)&&typeof v.payment_id==='string'}))
async function approve(){if(working.value||done.value)return;working.value=true;failure.value='';try{await api('/api/dashboard/payments/refund',{method:'POST',body:{action:'approve',authorization_id:String(route.query.id)},validate:(v:unknown):v is Record<string,unknown>=>isRecord(v)&&typeof v.stripe_refund_id==='string'});done.value=true}catch(error){failure.value=getErrorMessage(error,'Refund could not be completed')}finally{working.value=false}}
</script>
