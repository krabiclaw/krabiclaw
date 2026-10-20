<template>
  <!--
    Airbnb's payout sheet: the amount under a coin, then Sent / Bank account /
    Payout ID, then a card per booking the payout carried — pictures, what,
    when, and its total — with Details opening the record.
  -->
  <DashboardLeafPanel id="earnings-payout" :title="detail ? paymentMoney(detail.amount, detail.currency) : 'Payout'" :lead="detail ? `${payoutStatusLabel(detail.status)} · ${payoutDate(detail.arrivalDate, { month: 'long', day: 'numeric', year: 'numeric' })}` : ''" :footer="false" :error="error ? getErrorMessage(error, 'Payout request failed') : ''">
    <template v-if="detail">
      <div class="flex flex-col items-center py-4">
        <span class="relative flex size-20 items-center justify-center rounded-full bg-elevated ring ring-default">
          <UIcon name="i-lucide-landmark" class="size-9 text-highlighted" />
          <UIcon v-if="detail.status === 'paid'" name="i-lucide-circle-check" class="absolute -bottom-1 -right-1 size-7 rounded-full bg-default text-success" />
        </span>
        <p class="mt-4 text-3xl font-semibold text-highlighted">{{ paymentMoney(detail.amount, detail.currency) }}</p>
      </div>

      <UCard as="section" variant="subtle">
        <dl class="divide-y divide-default">
          <div class="py-4 first:pt-0"><dt class="text-base font-semibold text-highlighted">{{ payoutStatusLabel(detail.status) }}</dt><dd class="mt-1 text-base text-muted">{{ payoutDate(detail.arrivalDate, { month: 'long', day: 'numeric', year: 'numeric' }) }}</dd></div>
          <div v-if="detail.bank" class="py-4"><dt class="text-base font-semibold text-highlighted">Bank account</dt><dd class="mt-1 text-base text-muted">{{ detail.bank.bankName ?? 'Bank account' }}, ••••{{ detail.bank.last4 }} ({{ detail.currency }})</dd></div>
          <div class="py-4 last:pb-0"><dt class="text-base font-semibold text-highlighted">Payout ID</dt><dd class="mt-1 break-all text-base text-muted">{{ detail.id }}</dd></div>
        </dl>
      </UCard>

      <UCard v-for="item in detail.items" :key="item.paymentId" as="section" variant="subtle" class="mt-6" :ui="{ body: 'text-center' }">
        <span class="mx-auto flex size-20 items-center justify-center overflow-hidden rounded-full bg-elevated">
          <img v-if="item.imageUrl" :src="item.imageUrl" alt="" class="size-full object-cover">
          <UIcon v-else name="i-lucide-package" class="size-8 text-dimmed" />
        </span>
        <h2 class="mt-5 text-2xl font-semibold text-highlighted">{{ item.title }}</h2>
        <p v-if="item.startsAt && item.timeZone" class="mt-1 text-base text-muted">{{ whenLabel(item) }}</p>
        <dl class="mt-6 divide-y divide-default text-left">
          <div class="flex items-center justify-between gap-4 py-4"><div><dt class="text-base font-semibold text-highlighted">Payment</dt><dd class="mt-1 break-all text-sm text-muted">{{ item.paymentId }}</dd></div><UButton label="Details" color="neutral" variant="soft" :to="`/dashboard/${route.params.orgSlug}/earnings/transactions/${encodeURIComponent(item.paymentId)}`" /></div>
          <div class="flex items-center justify-between gap-4 py-4"><dt class="text-base font-semibold text-highlighted">Total ({{ item.currency }})</dt><dd class="text-base font-semibold text-highlighted">{{ paymentMoney(item.amount, item.currency) }}</dd></div>
        </dl>
      </UCard>
      <p v-if="!detail.items.length" class="mt-6 text-center text-sm text-muted">Stripe did not list any payments in this payout.</p>
    </template>
    <PaymentsHelp class="mt-8" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import PaymentsHelp from '~/components/dashboard/PaymentsHelp.vue'
import { paymentMoney } from '~/shared/payment-display'
import { isPayoutDetail, payoutDate, payoutStatusLabel, type PayoutDetail, type PayoutItem } from '~/shared/earnings-display'
import { formatTimestamp } from '~/utils/timezone'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Payout | KrabiClaw', robots: 'noindex, nofollow' })

const route = useRoute()
const api = useDashboardApi()
const payoutId = String(route.params.payoutId || '')
const { data: detail, error } = await useAsyncData(
  () => `earnings-payout:${route.params.orgSlug}:${payoutId}`,
  () => api<PayoutDetail>('/api/dashboard/payments', { query: { view: 'payout', payout_id: payoutId }, validate: isPayoutDetail }),
)
function whenLabel(item: PayoutItem): string {
  const start = formatTimestamp(item.startsAt!, 'en', item.timeZone!, { month: 'short', day: 'numeric', year: 'numeric' })
  const end = item.endsAt ? formatTimestamp(item.endsAt, 'en', item.timeZone!, { month: 'short', day: 'numeric', year: 'numeric' }) : start
  return [item.subjectTitle, start === end ? start : `${start} – ${end}`].filter(Boolean).join(' · ')
}
</script>
