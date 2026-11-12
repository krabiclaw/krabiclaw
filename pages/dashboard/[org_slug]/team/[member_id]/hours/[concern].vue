<template><MemberAvailabilityLeaf :concern="String(route.params.concern)" /></template>
<script setup lang="ts">
import MemberAvailabilityLeaf from '~/components/dashboard/MemberAvailabilityLeaf.vue'
definePageMeta({layout:'dashboard'})
const route=useRoute()
</script>
