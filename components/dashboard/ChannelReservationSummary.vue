<template>
  <section aria-label="Channel reservations">
    <h2 class="text-xl font-semibold text-highlighted">Channel reservations</h2>
    <p class="mt-2 text-sm text-muted">Arriving in {{ month }}</p>
    <dl v-if="rows.length" class="mt-4 space-y-4">
      <div v-for="row in rows" :key="row.channel + row.currency" class="flex items-center justify-between gap-4">
        <dt><span class="block font-medium text-highlighted">{{ labels[row.channel] }}</span><span class="text-sm text-muted">{{ row.count }} {{ row.count === 1 ? 'reservation' : 'reservations' }}</span></dt>
        <dd class="font-medium text-highlighted">{{ paymentMoney(row.amount, row.currency) }}</dd>
      </div>
    </dl>
    <p v-else class="mt-4 text-sm text-muted">No confirmed channel reservations arriving this month.</p>
    <p class="mt-4 text-sm text-muted">Reservation amounts reported by each channel, grouped by arrival month. They are not confirmed bank transfers and are not added to direct payment totals. Check the channel for its payout status and bank details.</p>
  </section>
</template>

<script setup lang="ts">
import type { EarningsPerformance } from '~/shared/earnings-display'
import { paymentMoney } from '~/shared/payment-display'
defineProps<{ rows: EarningsPerformance['channelReservations']; month: string }>()
const labels: Record<string, string> = { airbnb: 'Airbnb', booking_com: 'Booking.com', vrbo: 'Vrbo' }
</script>
