<template>
  <!--
    Airbnb's Performance: the year's bars with the chosen month lit, that
    month's Paid / Upcoming / Total, what it was earned on, and the monthly
    table underneath. One screen under Earnings.
  -->
  <DashboardLeafPanel id="earnings-performance" title="Performance" :footer="false">
    <UAlert v-if="error" color="error" variant="soft" title="Performance could not be loaded" :description="getErrorMessage(error, 'Performance request failed')" />
    <template v-else>
      <section>
        <div class="flex items-center justify-between gap-4">
          <div>
            <h2 class="text-xl font-semibold text-highlighted">Summary</h2>
            <p class="text-sm text-muted">Monthly view · {{ year }}</p>
          </div>
          <div class="flex items-center rounded-md ring ring-default">
            <UButton icon="i-lucide-chevron-left" color="neutral" variant="ghost" square aria-label="Previous year" @click="year -= 1" />
            <UButton icon="i-lucide-chevron-right" color="neutral" variant="ghost" square aria-label="Next year" :disabled="year >= thisYear" @click="year += 1" />
          </div>
        </div>
        <EarningsBars v-if="data" class="mt-6" :months="data.months" :selected="month" :currency="data.currency" @select="month = $event" />
      </section>

      <section v-if="data" class="mt-8 rounded-3xl ring ring-default">
        <div class="p-6">
          <h3 class="text-base font-semibold text-highlighted">{{ monthTitle }}</h3>
          <dl class="mt-4 space-y-3">
            <div class="flex items-center justify-between gap-4"><dt class="flex items-center gap-2 text-sm text-muted"><span class="size-2 rounded-full bg-primary" aria-hidden="true" />Paid</dt><dd class="text-sm font-medium text-highlighted">{{ money(selected.paid - selected.refunded) }}</dd></div>
            <div class="flex items-center justify-between gap-4"><dt class="flex items-center gap-2 text-sm text-muted"><span class="size-2 rounded-full ring-2 ring-inset ring-primary" aria-hidden="true" />Refunded</dt><dd class="text-sm font-medium text-highlighted">{{ money(selected.refunded) }}</dd></div>
          </dl>
          <div class="mt-4 flex items-center justify-between gap-4 border-t border-default pt-4"><p class="text-sm font-semibold text-highlighted">Total ({{ data.currency }})</p><p class="text-sm font-semibold text-highlighted">{{ money(selected.paid - selected.refunded) }}</p></div>
        </div>
        <NuxtLink :to="{ path: `/dashboard/${route.params.orgSlug}/earnings/transactions`, query: { from: `${month}-01`, through: lastDayOf(month) } }" class="flex items-center justify-between gap-4 border-t border-default px-6 py-4">
          <span class="text-sm font-semibold text-highlighted">Paid breakdown</span>
          <UIcon name="i-lucide-chevron-right" class="size-5 text-muted" />
        </NuxtLink>
      </section>

      <section v-if="data" class="mt-10">
        <h2 class="text-xl font-semibold text-highlighted">Earnings by offering</h2>
        <p class="text-sm text-muted">{{ monthTitle }}</p>
        <div v-if="data.items.length" class="mt-4 space-y-5">
          <div v-for="item in data.items" :key="item.title" class="flex items-center gap-4">
            <span class="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-elevated">
              <img v-if="item.imageUrl" :src="item.imageUrl" alt="" class="size-full object-cover">
              <UIcon v-else name="i-lucide-package" class="size-5 text-dimmed" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex items-center justify-between gap-4">
                <span class="truncate text-sm font-medium text-highlighted">{{ item.title }}</span>
                <span class="shrink-0 text-sm"><span class="text-muted">{{ share(item.paid) }}</span> <span class="ml-2 font-semibold text-highlighted">{{ money(item.paid) }}</span></span>
              </span>
              <span class="mt-2 block h-1 w-full rounded-full bg-elevated"><span class="block h-1 rounded-full bg-primary" :style="{ width: share(item.paid) }" /></span>
            </span>
          </div>
        </div>
        <p v-else class="mt-4 text-sm text-muted">Nothing was earned in {{ monthTitle }}.</p>
        <p class="mt-4 text-xs text-muted">Includes paid earnings for the selected period.</p>
      </section>

      <!-- Checkouts started, paid and refunded in the month, by offering and by team member: the same analytics query the MCP tool answers. -->
      <section class="mt-10">
        <h2 class="text-xl font-semibold text-highlighted">Checkouts</h2>
        <p class="text-sm text-muted">{{ monthTitle }}</p>
        <UAlert v-if="conversionError" class="mt-4" color="error" variant="soft" :description="getErrorMessage(conversionError, 'Checkouts could not be loaded')" />
        <template v-else-if="conversion">
          <p v-if="!conversion.byOffering.length" class="mt-4 text-sm text-muted">No checkouts in {{ monthTitle }}.</p>
          <div v-for="group in conversionGroups" v-else :key="group.title" class="mt-6">
            <h3 class="text-base font-semibold text-highlighted">{{ group.title }}</h3>
            <table class="mt-3 w-full text-left text-sm">
              <thead class="text-muted"><tr><th class="pb-3 font-medium">{{ group.label }}</th><th class="pb-3 text-right font-medium">Checkouts</th><th class="pb-3 text-right font-medium">Paid</th><th class="pb-3 text-right font-medium">Conversion</th><th class="pb-3 text-right font-medium">Refund rate</th></tr></thead>
              <tbody class="divide-y divide-default border-y border-default">
                <tr v-for="row in group.rows" :key="row.id ?? 'none'">
                  <td class="py-3 text-highlighted">{{ row.name }}</td>
                  <td class="py-3 text-right text-muted">{{ row.started }}</td>
                  <td class="py-3 text-right text-muted">{{ row.paid }}</td>
                  <td class="py-3 text-right font-semibold text-highlighted">{{ percent(row.conversion) }}</td>
                  <td class="py-3 text-right text-muted">{{ percent(row.refundRate) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </section>

      <section v-if="data" class="mt-10">
        <h2 class="text-xl font-semibold text-highlighted">Monthly earnings</h2>
        <table class="mt-4 w-full text-left text-sm">
          <thead class="text-muted"><tr><th class="pb-3 font-medium">Date</th><th class="pb-3 text-right font-medium">Paid</th><th class="pb-3 text-right font-medium">Refunded</th><th class="pb-3 text-right font-medium">Total ({{ data.currency }})</th></tr></thead>
          <tbody class="divide-y divide-default border-y border-default">
            <tr v-for="row in data.months" :key="row.month" :class="row.month === month ? 'bg-elevated/50' : ''">
              <td class="py-3 text-highlighted"><button type="button" class="hover:underline" @click="month = row.month">{{ formatCalendarDate(`${row.month}-01`, 'en', { month: 'long', year: 'numeric' }) }}</button></td>
              <td class="py-3 text-right text-muted">{{ money(row.paid) }}</td>
              <td class="py-3 text-right text-muted">{{ money(row.refunded) }}</td>
              <td class="py-3 text-right font-semibold text-highlighted">{{ money(row.paid - row.refunded) }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import EarningsBars from '~/components/dashboard/EarningsBars.vue'
import { paymentMoney } from '~/shared/payment-display'
import { isEarningsPerformance, type EarningsPerformance } from '~/shared/earnings-display'
import { formatCalendarDate } from '~/utils/timezone'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Performance | KrabiClaw', robots: 'noindex, nofollow' })

const route = useRoute()
const router = useRouter()
const api = useDashboardApi()
const now = new Date()
const thisYear = now.getUTCFullYear()
const initial = typeof route.query.month === 'string' && /^\d{4}-\d{2}$/.test(route.query.month) ? route.query.month : `${thisYear}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
const month = ref(initial)
const year = ref(Number(initial.slice(0, 4)))
// Choosing a year keeps the same month number; choosing a month follows its year. The month rides in the URL.
watch(year, (next) => { month.value = `${next}-${month.value.slice(5)}` })
watch(month, (next) => { year.value = Number(next.slice(0, 4)); void router.replace({ query: { ...route.query, month: next } }) })

type Breakdown = { rows: Array<{ dimensions: Record<string, string | null>; metrics: Record<string, number | null> }> }
const isBreakdown = (dimension: string) => (value: unknown): value is Breakdown => isRecord(value) && Array.isArray(value.rows)
  && value.rows.every(row => isRecord(row) && isRecord(row.dimensions) && (row.dimensions[dimension] === null || typeof row.dimensions[dimension] === 'string') && isRecord(row.metrics)
    && ['checkouts_started', 'payments_paid'].every(name => typeof (row.metrics as Record<string, unknown>)[name] === 'number')
    && ['checkout_conversion_rate', 'refund_rate'].every(name => { const metric = (row.metrics as Record<string, unknown>)[name]; return metric === null || typeof metric === 'number' }))
type Named = { id: string; name: string }
const dashboard = useDashboardOrganization()
// The month's earnings and its checkouts load together before the page shows.
const [{ data, error }, { data: conversion, error: conversionError }] = await Promise.all([useAsyncData(
  () => `earnings-performance:${route.params.orgSlug}:${year.value}:${month.value}`,
  () => api<EarningsPerformance>('/api/dashboard/payments', { query: { view: 'performance', year: year.value, month: month.value }, validate: isEarningsPerformance }),
  { watch: [month] },
), useAsyncData(
  () => `earnings-conversion:${route.params.orgSlug}:${month.value}`,
  async () => {
    const organizationId = dashboard.organization.value?.id
    if (!organizationId) throw new Error('Organization context is unavailable')
    const range = { start_date: `${month.value}-01`, end_date: lastDayOf(month.value) }
    const breakdown = (dimension: 'product_id' | 'member_id') => api('/api/dashboard/analytics-query', { method: 'POST', body: {
      mode: 'breakdown', ...range, filters: { conversion_type: 'booking' }, dimensions: [dimension],
      metrics: ['checkouts_started', 'payments_paid', 'checkout_conversion_rate', 'refund_rate'], sort: { metric: 'checkouts_started', direction: 'desc' }, limit: 50,
    }, validate: isBreakdown(dimension) })
    const [offerings, members, products, team] = await Promise.all([
      breakdown('product_id'), breakdown('member_id'),
      api(`/api/editor/organizations/${organizationId}/products`, { validate: (v: unknown): v is { products: Named[] } => isRecord(v) && Array.isArray(v.products) && v.products.every(row => isRecord(row) && typeof row.id === 'string' && typeof row.name === 'string') }),
      api(`/api/organizations/${organizationId}/members/scheduling`, { validate: (v: unknown): v is { members: Named[] } => isRecord(v) && Array.isArray(v.members) && v.members.every(row => isRecord(row) && typeof row.id === 'string' && typeof row.name === 'string') }),
    ])
    const rows = (result: Breakdown, dimension: string, names: Named[], none: string) => result.rows
      .filter(row => Number(row.metrics.checkouts_started) > 0 || Number(row.metrics.payments_paid) > 0)
      .map(row => {
        const id = row.dimensions[dimension] ?? null
        return { id, name: id ? names.find(named => named.id === id)?.name ?? 'Removed' : none, started: Number(row.metrics.checkouts_started), paid: Number(row.metrics.payments_paid), conversion: row.metrics.checkout_conversion_rate ?? null, refundRate: row.metrics.refund_rate ?? null }
      })
    return { byOffering: rows(offerings, 'product_id', products.products, 'Other'), byMember: rows(members, 'member_id', team.members, 'Not assigned') }
  },
  { watch: [month] },
)])
const money = (amount: number) => paymentMoney(amount, data.value!.currency)
const selected = computed(() => data.value?.months.find(row => row.month === month.value) ?? { month: month.value, paid: 0, refunded: 0 })
const monthTitle = computed(() => formatCalendarDate(`${month.value}-01`, 'en', { month: 'long', year: 'numeric' }))
const monthTotal = computed(() => data.value?.items.reduce((sum, item) => sum + item.paid, 0) ?? 0)
const share = (paid: number) => `${monthTotal.value ? Math.round((paid / monthTotal.value) * 1000) / 10 : 0}%`
const conversionGroups = computed(() => conversion.value ? [
  { title: 'By offering', label: 'Offering', rows: conversion.value.byOffering },
  { title: 'By team member', label: 'Team member', rows: conversion.value.byMember },
] : [])
const percent = (value: number | null) => value === null ? '—' : `${Math.round(value * 10) / 10}%`
function lastDayOf(key: string): string {
  const [y, m] = key.split('-').map(Number)
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10)
}
</script>
