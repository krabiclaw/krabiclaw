<template>
 <MemberAvailabilityIndex v-if="member" :key="`${organizationId}:${member.id}`" :organization-id="organizationId" :member-id="member.id" :admin="data?.canManage" self />
 <DashboardLeafPanel v-else id="availability-loading" title="Profile & availability" :footer="false" :error="error ? getErrorMessage(error,'Your profile and availability could not be loaded.') : ''" />
</template>
<script setup lang="ts">
import MemberAvailabilityIndex from '~/components/dashboard/MemberAvailabilityIndex.vue'
import { authClient } from '~/lib/auth-client'
definePageMeta({layout:'dashboard'})
const route=useRoute(),organizationId=String(route.params.organizationId)
const {data,error}=await useAsyncData(`my-scheduling-member:${organizationId}`,async()=>{
 const [members,permission]=await Promise.all([
  applicationFetch<{members:{id:string;self:boolean}[]}>(`/api/organizations/${organizationId}/members/scheduling`,{validate:(v):v is {members:{id:string;self:boolean}[]}=>isRecord(v)&&Array.isArray(v.members)&&v.members.every(m=>isRecord(m)&&typeof m.id==='string'&&typeof m.self==='boolean')}),
  authClient.organization.hasPermission({organizationId,permissions:{members:['update']}}),
 ])
 if(permission.error)throw new Error(permission.error.message||'Your profile publishing permission could not be checked.')
 return {...members,canManage:permission.data.success}
})
const member=computed(()=>data.value?.members.find(m=>m.self))
if(data.value&&!member.value)throw createError({statusCode:403,statusMessage:'You are not a member of this organization.'})
</script>
