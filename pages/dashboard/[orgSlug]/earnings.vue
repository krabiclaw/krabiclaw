<template>
  <DashboardIndexPanel id="earnings" title="Earnings" :auto-open="`${level.path.value}/performance`">
    <template #right>
      <UDropdownMenu :items="settingsItems" :content="{ align: 'end' }">
        <UButton icon="i-lucide-settings" color="neutral" variant="soft" square aria-label="Settings and documents" />
      </UDropdownMenu>
    </template>
    <div class="space-y-10 pb-10">
      <UAlert v-if="error" color="error" variant="soft" title="Direct payments could not be loaded" :description="getErrorMessage(error, 'Earnings request failed')" />
      <template v-if="performance">
        <UCard as="section" variant="subtle">
          <h2 class="text-xl font-semibold text-highlighted">Direct payments</h2>
          <p class="mt-4 text-5xl font-semibold tracking-tight text-highlighted">{{ total }}</p>
          <p class="mt-3 text-sm text-muted">{{ monthName }} · Payments collected through Stripe, less refunds. This is not the amount transferred to your bank.</p>
          <UButton class="mt-6" color="neutral" variant="soft" label="View payment details" :to="`${level.path.value}/performance`" />
        </UCard>
        <ChannelReservationSummary v-if="dashboard.organization.value?.vertical === 'lodging'" :rows="performance.channelReservations" :month="monthName" />
      </template>
      <UAlert v-if="payoutsError" color="error" variant="soft" title="Stripe payouts could not be loaded" :description="getErrorMessage(payoutsError, 'Payouts request failed')" />
      <template v-if="payouts">
        <section>
          <h2 class="text-xl font-semibold text-highlighted">Stripe payouts</h2>
          <p class="mt-2 text-sm text-muted">Transfers from your connected Stripe account. Airbnb and other channels manage their own payouts.</p>
          <p v-if="!payouts.configured" class="mt-4 text-sm text-muted">Connect Stripe in Payments &amp; payouts to receive online payments.</p>
          <template v-else>
            <h3 class="mt-6 text-base font-semibold text-highlighted">Upcoming</h3>
            <div v-if="upcomingPayouts.length" class="mt-4 space-y-4">
              <PayoutCard v-for="row in upcomingPayouts" :key="row.id" :payout="row" :to="`${level.path.value}/payouts/${encodeURIComponent(row.id)}`" />
            </div>
            <p v-else class="mt-4 text-sm text-muted">No scheduled Stripe payouts.</p>
            <h3 class="mt-6 text-base font-semibold text-highlighted">Sent</h3>
            <div v-if="paidPayouts.length" class="mt-4 space-y-4">
              <PayoutCard v-for="row in paidPayouts" :key="row.id" :payout="row" :items="payouts.items?.[row.id]" :to="`${level.path.value}/payouts/${encodeURIComponent(row.id)}`" />
            </div>
            <p v-else class="mt-4 text-sm text-muted">Nothing sent by Stripe yet.</p>
            <UButton class="mt-6" label="View Stripe payout history" color="neutral" variant="link" :to="`${level.path.value}/payouts`" />
          </template>
        </section>
        <section v-if="clearing.length">
          <h2 class="text-xl font-semibold text-highlighted">Stripe balance</h2>
          <dl class="mt-4 space-y-3">
            <div v-for="row in clearing" :key="row.currency + row.label" class="flex items-center justify-between gap-4">
              <dt class="text-sm text-muted">{{ row.label }}</dt><dd class="font-medium">{{ paymentMoney(row.amount, row.currency) }}</dd>
            </div>
          </dl>
          <p class="mt-3 text-sm text-muted">Funds held by Stripe, shown separately from transfers already scheduled.</p>
        </section>
      </template>
      <PaymentsHelp />
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { getLocalTimeZone, today } from '@internationalized/date'
import PayoutCard from '~/components/dashboard/PayoutCard.vue'
import PaymentsHelp from '~/components/dashboard/PaymentsHelp.vue'
import ChannelReservationSummary from '~/components/dashboard/ChannelReservationSummary.vue'
import { paymentMoney } from '~/shared/payment-display'
import { isEarningsPerformance, isPayoutsView, type EarningsPerformance, type PayoutsView } from '~/shared/earnings-display'
import { formatCalendarDate } from '~/utils/timezone'

definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'menu' })
useSeoMeta({ title: 'Earnings | KrabiClaw', robots: 'noindex, nofollow' })

const route = useRoute()
const dashboard = useDashboardOrganization()
const api = useDashboardApi()
const level = useRouteLevel()
const thisMonth = today(getLocalTimeZone()).set({ day: 1 })
const thisMonthKey = `${thisMonth.year}-${String(thisMonth.month).padStart(2, '0')}`
const monthName = formatCalendarDate(thisMonth.toString(), 'en', { month: 'long' })

// The year by month, in UTC as the money is recorded; this month is the card's total.
// Upcoming is what Stripe still holds or has on its way; Paid is what it has sent, with what each payout carried.
// Both load together before the page shows.
const [{ data: performance, error }, { data: payouts, error: payoutsError }] = await Promise.all([
  useAsyncData(
    () => `earnings-performance:${route.params.orgSlug}:${thisMonthKey}`,
    () => api<EarningsPerformance>('/api/dashboard/payments', { query: { view: 'performance', year: thisMonth.year, month: thisMonthKey }, validate: isEarningsPerformance }),
  ),
  useAsyncData(() => `earnings-payouts:${route.params.orgSlug}`, () => api<PayoutsView>('/api/dashboard/payments', { query: { view: 'payouts', with_items: '1' }, validate: isPayoutsView })),
])
const money = (amount: number) => paymentMoney(amount, performance.value!.currency)
const monthRow = (month: string) => performance.value?.months.find(row => row.month === month)
const paidAmount = computed(() => { const row = monthRow(thisMonthKey); if (!row) throw new Error('The selected payment month is missing'); return row.paid - row.refunded })
const total = computed(() => money(paidAmount.value))

const upcomingPayouts = computed(() => (payouts.value?.payouts ?? []).filter(row => row.status === 'pending' || row.status === 'in_transit'))
const clearing = computed(() => [
  ...(payouts.value?.balance?.available ?? []).map(row => ({ amount: row.amount, currency: row.currency.toUpperCase(), label: 'Ready to send' })),
  ...(payouts.value?.balance?.pending ?? []).map(row => ({ amount: row.amount, currency: row.currency.toUpperCase(), label: 'Clearing' })),
].filter(row => row.amount !== 0))
const paidPayouts = computed(() => (payouts.value?.payouts ?? []).filter(row => row.status === 'paid').slice(0, 3))

// Airbnb's cog: "Settings and documents" — how payouts arrive, and the plan's own destination.
const settingsItems = computed(() => [[
  { label: 'Payout settings', icon: 'i-lucide-landmark', to: `/dashboard/${route.params.orgSlug}/payments` },
  { label: 'Plan and billing', icon: 'i-lucide-receipt', to: `/dashboard/${route.params.orgSlug}/billing` },
]])
</script>
