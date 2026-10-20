<template>
  <div />
</template>

<script setup lang="ts">
// Guest emails link to /account; the account itself is the dashboard's.
definePageMeta({ layout: 'standalone' })
const route = useRoute()
await navigateTo({ path: '/dashboard/account', query: route.query }, { redirectCode: 302, replace: true })
</script>
