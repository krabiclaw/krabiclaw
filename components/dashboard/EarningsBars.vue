<template>
  <!--
    Airbnb's earnings chart: one bar per month, the chosen month filled, the
    rest outlined, a dotted baseline and the amounts on the right. Drawn as
    boxes so it reads in both themes and needs no library.
  -->
  <div class="flex h-56 items-end gap-2 border-b border-default pb-2" role="img" :aria-label="`Earnings by month: ${months.map(m => `${monthLabel(m.month)} ${paymentMoney(m.paid - m.refunded, currency)}`).join(', ')}`">
    <button
      v-for="row in months"
      :key="row.month"
      type="button"
      class="group flex h-full flex-1 flex-col items-center justify-end gap-2 rounded-lg px-0.5 hover:bg-elevated/50"
      :aria-pressed="row.month === selected"
      @click="$emit('select', row.month)"
    >
      <span
        class="w-full rounded-t-md transition-colors"
        :class="row.month === selected ? 'bg-primary' : 'bg-elevated ring-1 ring-inset ring-default group-hover:bg-accented'"
        :style="{ height: `${heightFor(row)}%` }"
      />
      <span class="text-xs" :class="row.month === selected ? 'rounded-full bg-highlighted px-2 py-0.5 font-semibold text-inverted' : 'text-muted'">{{ monthLabel(row.month) }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { paymentMoney } from '~/shared/payment-display'
import { formatCalendarDate } from '~/utils/timezone'

const props = defineProps<{ months: Array<{ month: string; paid: number; refunded: number }>; selected: string; currency: string }>()
defineEmits<{ select: [month: string] }>()

const top = computed(() => Math.max(1, ...props.months.map(row => row.paid - row.refunded)))
// A month with nothing keeps a hairline so the axis still reads as twelve months.
const heightFor = (row: { paid: number; refunded: number }) => Math.max(2, Math.round(((row.paid - row.refunded) / top.value) * 100))
const monthLabel = (month: string) => formatCalendarDate(`${month}-01`, 'en', { month: 'short' })
</script>
