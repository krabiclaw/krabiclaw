<template>
  <!-- Airbnb's "Canceled reservations" sheet, as a level of its own so it has a URL. -->
  <DashboardIndexPanel id="account-activity-cancelled" title="Cancelled" column="reading">
    <UAlert v-if="error" color="error" title="Cancelled visits could not be loaded" :description="getErrorMessage(error, 'Activity request failed.')" />
    <div v-else-if="cancelled.length" class="space-y-4 pb-6">
      <AccountActivityCard v-for="item in cancelled" :key="`${item.kind}:${item.id}`" :item="item" />
    </div>
    <UEmpty v-else-if="data" icon="i-lucide-calendar-x" title="No cancelled visits" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import AccountActivityCard from '~/components/dashboard/AccountActivityCard.vue'
definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Cancelled | KrabiClaw', robots: 'noindex, nofollow' })
const { data, error } = await useAccountActivity()
const cancelled = computed(() => (data.value?.activities ?? []).filter(item => (item.kind === 'booking' || item.kind === 'reservation' || item.kind === 'stay') && item.status === 'cancelled'))
</script>
