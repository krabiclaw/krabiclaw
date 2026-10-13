<template>
  <!-- Airbnb's Account settings → Payments: Your payments, the same tab the business has; cards are saved with each business at its Checkout. -->
  <DashboardIndexPanel id="account-payments" title="Payments" column="reading">
    <div class="pb-10">
      <PaymentsAccountSettings personal-scope />
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import PaymentsAccountSettings from '~/components/dashboard/settings/PaymentsAccountSettings.vue'
definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Payments | Krabiclaw', robots: 'noindex, nofollow' })
</script>
