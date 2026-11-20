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
        <ChannelReservationSummary v-if="dashboard.hasFeature('stays')" :rows="performance.channel_reservations" :month="monthName" />
      </template>
      <section v-if="performance?.payouts_connected != null">
        <h2 class="text-xl font-semibold text-highlighted">Stripe payouts</h2>
        <UButton v-if="performance.payouts_connected" class="mt-4" label="View Stripe payouts and balance"
          color="neutral" variant="soft" :to="`${level.path.value}/payouts`" />
        <p v-else class="mt-4 text-sm text-muted">Connect Stripe in Payments &amp; payouts to receive online payments.</p>
      </section>
      <PaymentsHelp />
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import PaymentsHelp from '~/components/dashboard/PaymentsHelp.vue'
import ChannelReservationSummary from '~/components/dashboard/ChannelReservationSummary.vue'
import { paymentMoney } from '~/shared/payment-display'
import { isEarningsPerformance, type EarningsPerformance } from '~/shared/earnings-display'
import { formatCalendarDate } from '~/utils/timezone'

definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'menu' })
useSeoMeta({ title: 'Earnings | Blawby', robots: 'noindex, nofollow' })

const route = useRoute()
const dashboard = useDashboardOrganization()
const api = useDashboardApi()
const level = useRouteLevel()
const thisMonthKey = new Date().toISOString().slice(0, 7)
const thisYear = Number(thisMonthKey.slice(0, 4))
const monthName = formatCalendarDate(`${thisMonthKey}-01`, 'en', { month: 'long' })

// The year by month, in UTC as the money is recorded; this month is the card's total.
// The overview shows transfers. Their underlying payments are loaded in payout detail.
const { data: performance, error } = await useAsyncData(
    () => `earnings-performance:${route.params.org_slug}:${thisMonthKey}`,
    () => api<EarningsPerformance>('/api/dashboard/payments', { query: { view: 'performance', year: thisYear, month: thisMonthKey }, validate: isEarningsPerformance }),
)
const money = (amount: number) => paymentMoney(amount, performance.value!.currency)
const monthRow = (month: string) => performance.value?.months.find(row => row.month === month)
const paidAmount = computed(() => { const row = monthRow(thisMonthKey); if (!row) throw new Error('The selected payment month is missing'); return row.paid - row.refunded })
const total = computed(() => money(paidAmount.value))

// Airbnb's cog: "Settings and documents" — how payouts arrive, and the plan's own destination.
const settingsItems = computed(() => [[
  { label: 'Payout settings', icon: 'i-lucide-landmark', to: `/dashboard/${route.params.org_slug}/payments` },
  { label: 'Plan and billing', icon: 'i-lucide-receipt', to: `/dashboard/${route.params.org_slug}/billing` },
]])
</script>
