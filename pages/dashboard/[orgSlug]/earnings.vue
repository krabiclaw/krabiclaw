<template>
  <!--
    Airbnb's Earnings page: a Performance card with this month's total, the
    year's bars, Paid and Upcoming and a way into the details; then Upcoming
    and Paid payouts as cards, and monthly Reports. The cog opens Payments
    (payouts, plan, fees). A card on Menu, so Back returns there.
  -->
  <DashboardIndexPanel id="earnings" title="Earnings" column="reading">
    <template #right>
      <UDropdownMenu :items="settingsItems" :content="{ align: 'end' }" :ui="{ content: 'w-60' }">
        <UButton icon="i-lucide-settings" color="neutral" variant="ghost" size="sm" square aria-label="Settings and documents" />
      </UDropdownMenu>
    </template>

    <div class="space-y-10 pb-10">
      <UAlert v-if="error" color="error" variant="soft" title="Earnings could not be loaded" :description="getErrorMessage(error, 'Earnings request failed')" />
      <UAlert v-else-if="payoutsError" color="error" variant="soft" title="Payouts could not be loaded" :description="getErrorMessage(payoutsError, 'Payouts request failed')" />
      <p v-else-if="!performance || !payouts" role="status" class="text-muted">Loading earnings…</p>
      <template v-else>
      <section class="rounded-3xl bg-elevated/50 px-6 py-8 shadow-sm ring ring-default">
        <p class="text-center text-sm font-medium text-highlighted">Performance</p>
        <p class="mt-2 text-center text-5xl font-semibold tracking-tight text-highlighted">{{ total }}</p>
        <p class="mt-2 text-center text-sm text-muted">Total for {{ monthName }} ({{ performance.currency }})</p>
        <div class="mx-auto mt-8 flex h-48 w-40 items-end justify-center gap-3" role="img" :aria-label="`${monthName}: paid ${total}, upcoming ${upcoming}`">
          <span class="w-16 rounded-xl bg-primary transition-[height]" :style="{ height: `${barHeight(paidAmount)}%` }" />
          <span class="w-16 rounded-xl ring-2 ring-inset ring-primary transition-[height]" :style="{ height: `${barHeight(upcomingAmount)}%` }" />
        </div>
        <dl class="mt-8 space-y-3">
          <div class="flex items-center justify-between gap-4"><dt class="flex items-center gap-2 text-sm text-muted"><span class="size-2 rounded-full bg-primary" aria-hidden="true" />Paid</dt><dd class="text-sm font-medium text-highlighted">{{ total }}</dd></div>
          <div class="flex items-center justify-between gap-4"><dt class="flex items-center gap-2 text-sm text-muted"><span class="size-2 rounded-full ring-2 ring-inset ring-primary" aria-hidden="true" />Upcoming</dt><dd class="text-sm font-medium text-highlighted">{{ upcoming }}</dd></div>
        </dl>
        <UButton class="mt-8 w-full justify-center" color="neutral" variant="soft" size="lg" label="View more details" :to="`${level.path.value}/performance`" />
      </section>

      <section>
        <h2 class="text-xl font-semibold text-highlighted">Upcoming</h2>
        <div v-if="upcomingPayouts.length" class="mt-4 space-y-4">
          <PayoutCard v-for="row in upcomingPayouts" :key="row.id" :payout="row" :items="payouts?.items?.[row.id]" :to="`${level.path.value}/payouts/${encodeURIComponent(row.id)}`" />
        </div>
        <div v-else-if="clearing.length" class="mt-4 space-y-4">
          <div v-for="row in clearing" :key="row.currency + row.label" class="rounded-3xl px-6 py-5 ring ring-default">
            <p class="text-sm font-medium text-highlighted">{{ row.label }}</p>
            <p class="mt-1 text-2xl font-semibold text-highlighted">{{ paymentMoney(row.amount, row.currency) }}</p>
            <p class="mt-2 text-sm text-muted">Stripe sends it on your payout schedule.</p>
          </div>
        </div>
        <div v-else class="mt-4 rounded-3xl px-6 py-10 text-center ring ring-default">
          <UIcon name="i-lucide-calendar-days" class="mx-auto size-12 text-muted" />
          <p class="mt-4 text-lg font-semibold text-highlighted">No scheduled payouts</p>
          <p class="mt-1 text-sm text-muted">You don’t have any upcoming payouts to review right now.</p>
        </div>
      </section>

      <section>
        <h2 class="text-xl font-semibold text-highlighted">Paid</h2>
        <div v-if="paidPayouts.length" class="mt-4 space-y-4">
          <PayoutCard v-for="row in paidPayouts" :key="row.id" :payout="row" :items="payouts?.items?.[row.id]" :to="`${level.path.value}/payouts/${encodeURIComponent(row.id)}`" />
        </div>
        <div v-else class="mt-4 rounded-3xl px-6 py-10 text-center ring ring-default">
          <UIcon name="i-lucide-landmark" class="mx-auto size-12 text-muted" />
          <p class="mt-4 text-lg font-semibold text-highlighted">Nothing paid out yet</p>
          <p class="mt-1 text-sm text-muted">Payouts appear here once Stripe sends them.</p>
        </div>
        <UButton class="mt-4" color="neutral" variant="soft" label="View all paid" :to="`${level.path.value}/payouts`" />
      </section>

      <section>
        <h2 class="text-xl font-semibold text-highlighted">Reports</h2>
        <div class="mt-4 grid grid-cols-3 gap-4">
          <NuxtLink v-for="report in reports" :key="report.month" :to="{ path: `${level.path.value}/performance`, query: { month: report.month } }" class="flex flex-col items-center rounded-3xl px-4 py-6 text-center ring ring-default transition-colors hover:bg-elevated">
            <span class="text-base font-semibold text-highlighted">{{ report.name }}</span>
            <span class="text-base font-semibold text-highlighted">{{ report.year }}</span>
            <span class="mt-6 text-sm text-muted">{{ report.figure }}</span>
          </NuxtLink>
        </div>
        <UButton class="mt-4" color="neutral" variant="soft" label="View all reports" :to="`${level.path.value}/performance`" />
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
import { paymentMoney } from '~/shared/payment-display'
import { isEarningsPerformance, isPayoutsView, type EarningsPerformance, type PayoutsView } from '~/shared/earnings-display'
import { formatCalendarDate } from '~/utils/timezone'

definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'menu' })
useSeoMeta({ title: 'Earnings | KrabiClaw', robots: 'noindex, nofollow' })

const route = useRoute()
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
const paidAmount = computed(() => { const row = monthRow(thisMonthKey); return row ? row.paid - row.refunded : 0 })
const total = computed(() => money(paidAmount.value))

const upcomingPayouts = computed(() => (payouts.value?.payouts ?? []).filter(row => row.status === 'pending' || row.status === 'in_transit'))
const clearing = computed(() => [
  ...(payouts.value?.balance?.available ?? []).map(row => ({ amount: row.amount, currency: row.currency.toUpperCase(), label: 'Ready to send' })),
  ...(payouts.value?.balance?.pending ?? []).map(row => ({ amount: row.amount, currency: row.currency.toUpperCase(), label: 'Clearing' })),
].filter(row => row.amount !== 0))
// One currency on the card: the loaded performance currency.
const shownCurrency = computed(() => performance.value!.currency.toUpperCase())
const upcomingAmount = computed(() => clearing.value.filter(row => row.currency === shownCurrency.value).reduce((sum, row) => sum + row.amount, 0) + upcomingPayouts.value.filter(row => row.currency.toUpperCase() === shownCurrency.value).reduce((sum, row) => sum + row.amount, 0))
const upcoming = computed(() => money(upcomingAmount.value))
// Two bars share one scale; an empty month still draws a short stub, as Airbnb's does.
const barHeight = (amount: number) => Math.max(12, Math.round((amount / Math.max(1, paidAmount.value, upcomingAmount.value)) * 100))
const paidPayouts = computed(() => (payouts.value?.payouts ?? []).filter(row => row.status === 'paid').slice(0, 3))

// Reports: the three months before this one.
const reports = computed(() => [1, 2, 3].map((offset) => {
  const first = thisMonth.subtract({ months: offset })
  const month = `${first.year}-${String(first.month).padStart(2, '0')}`
  const row = monthRow(month)
  return { month, name: formatCalendarDate(first.toString(), 'en', { month: 'long' }), year: String(first.year), figure: money(row ? row.paid - row.refunded : 0) }
}))

// Airbnb's cog: "Settings and documents" — the Payments page's tabs.
const settingsItems = computed(() => [[
  { label: 'Payments', icon: 'i-lucide-credit-card', to: `/dashboard/${route.params.orgSlug}/payments` },
  { label: 'Payout settings', icon: 'i-lucide-landmark', to: `/dashboard/${route.params.orgSlug}/payments?tab=payouts` },
  { label: 'Plan', icon: 'i-lucide-badge-check', to: `/dashboard/${route.params.orgSlug}/payments?tab=plan` },
]])
</script>
