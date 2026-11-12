<template><MemberAvailabilityIndex :key="`${organizationId}:${memberId}`" :organization-id="organizationId" :member-id="memberId" admin /></template>
<script setup lang="ts">
import MemberAvailabilityIndex from '~/components/dashboard/MemberAvailabilityIndex.vue'
definePageMeta({layout:'dashboard'})
const route=useRoute(),memberId=String(route.params.member_id)
const organizationId=useDashboardOrganizationId()
</script>
