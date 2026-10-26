<template>
  <!--
    Airbnb's Paid list: every payout, "Sent · date" under the day, the amount
    on the right, a total and Export CSV at the foot. Upcoming payouts head the
    list. A payout opens as a leaf of this level.
  -->
  <DashboardIndexPanel id="earnings-payouts" title="Paid" column="reading">
    <div>
      <UAlert v-if="error" color="error" :description="error.message" />
      <template v-else-if="data">
        <template v-if="data.configured === false">
          <p class="text-base text-muted">Payouts start once your business is connected to Stripe.</p>
          <UButton class="mt-4" label="Add payout method" :to="`/dashboard/${route.params.orgSlug}/payments`" />
        </template>
        <template v-else>
          <section v-if="upcoming.length" class="mb-8">
            <h2 class="text-base font-semibold text-highlighted">Upcoming</h2>
            <div class="divide-y divide-default border-b border-default">
              <NuxtLink v-for="row in upcoming" :key="row.id" :to="`${level.path.value}/${encodeURIComponent(row.id)}`" class="flex items-center gap-4 py-5">
                <span class="min-w-0 flex-1"><span class="block text-base font-medium text-highlighted">{{ payoutDate(row.arrival_date) }}</span><span class="block text-sm text-muted">{{ payoutStatusLabel(row.status) }} · {{ payoutDate(row.arrival_date, { month: 'long', day: 'numeric', year: 'numeric' }) }}</span></span>
                <span class="text-base font-medium tabular-nums text-highlighted">{{ paymentMoney(row.amount, row.currency.toUpperCase()) }}</span>
                <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
              </NuxtLink>
            </div>
          </section>

          <div v-if="paid.length" class="divide-y divide-default border-y border-default">
            <NuxtLink v-for="row in paid" :key="row.id" :to="`${level.path.value}/${encodeURIComponent(row.id)}`" class="flex items-center gap-4 py-5" :data-testid="`payout-${row.id}`">
              <span class="min-w-0 flex-1"><span class="block text-base font-medium text-highlighted">{{ payoutDate(row.arrival_date) }}</span><span class="block text-sm text-muted">Sent · {{ payoutDate(row.arrival_date, { month: 'long', day: 'numeric', year: 'numeric' }) }}</span></span>
              <span class="text-base font-medium tabular-nums text-highlighted">{{ paymentMoney(row.amount, row.currency.toUpperCase()) }}</span>
              <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
            </NuxtLink>
          </div>
          <p v-else class="text-base text-muted">Nothing has been paid out yet.</p>
          <UButton v-if="data.next_cursor" class="mt-4" color="neutral" variant="soft" label="Show more" @click="after = data.next_cursor" />
        </template>
      </template>
      <PaymentsHelp class="mt-8" />
    </div>

    <template v-if="paid.length" #footer>
      <div class="flex items-center justify-between gap-4">
        <p class="text-lg font-semibold text-highlighted">{{ total }}</p>
        <UButton label="Export CSV" size="lg" @click="exportCsv" />
      </div>
    </template>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import PaymentsHelp from '~/components/dashboard/PaymentsHelp.vue'
import { paymentMoney } from '~/shared/payment-display'
import { downloadCsv, isPayoutsView, payoutDate, payoutStatusLabel, type PayoutRow, type PayoutsView } from '~/shared/earnings-display'
import { minorAmountToMajor } from '~/shared/prices'
import type { CurrencyCode } from '~/shared/currencies'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Paid | KrabiClaw', robots: 'noindex, nofollow' })

const route = useRoute()
const api = useDashboardApi()
const level = useRouteLevel()
const after = ref<string | null>(null)
const loaded = ref<PayoutRow[]>([])
const { data, error } = await useAsyncData(
  () => `earnings-paid:${route.params.orgSlug}:${after.value ?? ''}`,
  async () => {
    const page = await api<PayoutsView>('/api/dashboard/payments', { query: { view: 'payouts', ...(after.value ? { after: after.value } : {}) }, validate: isPayoutsView })
    return page
  },
  { watch: [after] },
)
// Pages accumulate, as Airbnb's "Show more" does. Watched rather than written in
// the handler, which does not run again when the server-rendered page hydrates.
watch(data, (page) => { if (page) loaded.value = after.value ? [...loaded.value, ...page.payouts] : page.payouts }, { immediate: true })
const upcoming = computed(() => loaded.value.filter(row => row.status === 'pending' || row.status === 'in_transit'))
const paid = computed(() => loaded.value.filter(row => row.status === 'paid'))
const total = computed(() => {
  const totals = new Map<string, number>()
  for (const row of paid.value) totals.set(row.currency.toUpperCase(), (totals.get(row.currency.toUpperCase()) ?? 0) + row.amount)
  return [...totals].map(([code, amount]) => paymentMoney(amount, code)).join(' · ')
})
function exportCsv() {
  downloadCsv(`payouts-${String(route.params.orgSlug)}.csv`, ['Date', 'Sent', 'Amount', 'Currency', 'Status', 'Payout ID'],
    paid.value.map(row => [payoutDate(row.arrival_date), payoutDate(row.arrival_date, { month: 'long', day: 'numeric', year: 'numeric' }), minorAmountToMajor(row.amount, row.currency.toUpperCase() as CurrencyCode), row.currency.toUpperCase(), payoutStatusLabel(row.status), row.id]))
}
</script>
