<template>
 <MemberAvailabilityIndex v-if="member" :key="`${organizationId}:${member.id}`" :organization-id="organizationId" :member-id="member.id" self />
 <DashboardLeafPanel v-else id="availability-loading" title="Profile & availability" :footer="false" :error="error ? getErrorMessage(error,'Your profile and availability could not be loaded.') : ''" />
</template>
<script setup lang="ts">
import MemberAvailabilityIndex from '~/components/dashboard/MemberAvailabilityIndex.vue'
definePageMeta({layout:'dashboard'})
const route=useRoute(),organizationId=String(route.params.organizationId)
const {data,error}=await useAsyncData(`my-scheduling-member:${organizationId}`,()=>applicationFetch<{members:{id:string;self:boolean}[]}>(`/api/organizations/${organizationId}/members/scheduling`,{validate:(v):v is {members:{id:string;self:boolean}[]}=>isRecord(v)&&Array.isArray(v.members)&&v.members.every(m=>isRecord(m)&&typeof m.id==='string'&&typeof m.self==='boolean')}))
const member=computed(()=>data.value?.members.find(m=>m.self))
if(data.value&&!member.value)throw createError({statusCode:403,statusMessage:'You are not a member of this organization.'})
</script>
