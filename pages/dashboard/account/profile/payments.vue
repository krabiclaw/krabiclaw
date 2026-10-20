<template>
  <!-- Airbnb's Account settings → Payments: Your payments, the same row the business has; a buyer's cards are saved with each business at its Checkout, so there is no Payment methods row here. -->
  <DashboardIndexPanel id="account-payments" title="Payments" :auto-open="`${level.path.value}/your-payments`">
    <EditorNavigationList :groups="[{ id: 'payments', items: [{ id: 'your-payments', label: 'Your payments', summary: 'Keep track of all your payments and refunds.', to: `${level.path.value}/your-payments` }] }]" :active-item="level.child.value" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList from '~/components/dashboard/EditorNavigationList.vue'
definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Payments | KrabiClaw', robots: 'noindex, nofollow' })
const level = useRouteLevel()
</script>
