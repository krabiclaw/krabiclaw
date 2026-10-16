<template>
  <!-- Airbnb's payout card: the day, the amount, "Sent · date", and the pictures of what it carried. -->
  <UCard :as="NuxtLink" :to="to" variant="subtle" class="transition-colors hover:bg-elevated" :ui="{ body: 'flex items-start justify-between gap-4' }">
    <span class="min-w-0">
      <span class="block text-sm font-medium text-highlighted">{{ payoutDate(payout.arrival_date) }}</span>
      <span class="mt-1 block text-2xl font-semibold text-highlighted">{{ paymentMoney(payout.amount, payout.currency.toUpperCase()) }}</span>
      <span class="mt-2 block text-sm text-muted">{{ payoutStatusLabel(payout.status) }} · {{ payoutDate(payout.arrival_date, { month: 'long', day: 'numeric', year: 'numeric' }) }}</span>
    </span>
    <span v-if="photos.length" class="flex shrink-0 items-center" aria-hidden="true">
      <img v-for="(photo, index) in photos.slice(0, 2)" :key="photo" :src="photo" alt="" class="size-12 rounded-full border-2 border-default object-cover" :class="index ? '-ml-4 rounded-xl' : ''">
    </span>
  </UCard>
</template>

<script setup lang="ts">
import { NuxtLink } from '#components'
import { paymentMoney } from '~/shared/payment-display'
import { payoutDate, payoutStatusLabel, type PayoutItem, type PayoutRow } from '~/shared/earnings-display'

const props = defineProps<{ payout: PayoutRow; items?: PayoutItem[]; to: string }>()
const photos = computed(() => [...new Set((props.items ?? []).map(item => item.imageUrl).filter((url): url is string => !!url))])
</script>
