<template><StayCreatePage /></template>

<script setup lang="ts">
import StayCreatePage from '~/components/dashboard/StayCreatePage.vue'
definePageMeta({ layout: 'dashboard', tab: 'today', back: 'dashboard-orgSlug', key: route => `stay-create:${String(route.params.orgSlug)}:${String(route.query.product_id ?? '')}:${String(route.query.check_in_date ?? '')}:${String(route.query.check_out_date ?? '')}` })
</script>
