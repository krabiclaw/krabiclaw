<template>
  <!-- Airbnb's payout card: the day, the amount, "Sent · date",. -->
  <UCard :as="NuxtLink" :to="to" variant="subtle" class="transition-colors hover:bg-elevated" :ui="{ body: 'flex items-start justify-between gap-4' }">
    <span class="min-w-0">
      <span class="block text-sm font-medium text-highlighted">{{ payoutDate(payout.arrival_date) }}</span>
      <span class="mt-1 block text-2xl font-semibold text-highlighted">{{ paymentMoney(payout.amount, payout.currency.toUpperCase()) }}</span>
      <span class="mt-2 block text-sm text-muted">{{ payoutStatusLabel(payout.status) }} · {{ payoutDate(payout.arrival_date, { month: 'long', day: 'numeric', year: 'numeric' }) }}</span>
    </span>
  </UCard>
</template>

<script setup lang="ts">
import { NuxtLink } from '#components'
import { paymentMoney } from '~/shared/payment-display'
import { payoutDate, payoutStatusLabel, type PayoutRow } from '~/shared/earnings-display'

defineProps<{ payout: PayoutRow; to: string }>()
</script>
