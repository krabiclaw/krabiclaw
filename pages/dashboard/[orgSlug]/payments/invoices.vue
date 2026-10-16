<template>
  <!-- Airbnb's "Your payments" for the business: what it paid the platform — plan and Payments fees — newest first, each opening its Stripe invoice. -->
  <DashboardLeafPanel id="organization-payments-invoices" title="Your payments" :footer="false">
    <UAlert v-if="error" color="error" title="Payments could not be loaded" :description="getErrorMessage(error, 'Payments request failed.')" />
    <template v-else-if="years.length">
      <section v-for="year in years" :key="year.label" class="mb-8">
        <h2 class="text-xl font-semibold text-highlighted">{{ year.label }}</h2>
        <div class="mt-4 space-y-6">
          <component :is="row.url ? 'a' : 'div'" v-for="row in year.rows" :key="row.id" :href="row.url ?? undefined" :target="row.url ? '_blank' : undefined" rel="noopener noreferrer" class="flex items-center gap-4" :data-testid="`billing-invoice-${row.id}`">
            <span class="flex size-16 shrink-0 items-center justify-center rounded-lg bg-elevated"><UIcon name="i-lucide-receipt" class="size-6 text-dimmed" /></span>
            <span class="min-w-0 flex-1">
              <span class="block text-base font-medium text-highlighted">{{ statusLabel(row.status) }} {{ formatCalendarDate(row.created_at.slice(0, 10), 'en', { month: 'short', day: 'numeric' }) }}</span>
              <span class="block truncate text-sm text-muted">{{ row.description }}</span>
              <span v-if="row.number" class="block truncate text-sm text-muted">Invoice {{ row.number }}</span>
            </span>
            <span class="shrink-0 text-right">
              <span class="block text-base font-medium tabular-nums text-highlighted">{{ paymentMoney(row.total, row.currency) }}</span>
              <span class="block text-sm text-muted">{{ row.currency }}</span>
            </span>
            <UIcon v-if="row.url" name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
          </component>
        </div>
      </section>
    </template>
    <UEmpty v-else-if="data" icon="i-lucide-receipt" title="No payments yet" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import type { BillingInvoiceRow } from '~/server/api/billing/history.get'
import { paymentMoney } from '~/shared/payment-display'
import { isCurrencyCode } from '~/shared/currencies'
import { formatCalendarDate } from '~/utils/timezone'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Your payments | KrabiClaw', robots: 'noindex, nofollow' })

type History = { configured: boolean; invoices: BillingInvoiceRow[] }
const isHistory = (value: unknown): value is History => isRecord(value) && typeof value.configured === 'boolean'
  && Array.isArray(value.invoices) && value.invoices.every(row => isRecord(row) && typeof row.id === 'string' && (row.number === null || typeof row.number === 'string') && typeof row.created_at === 'string' && typeof row.status === 'string' && Number.isSafeInteger(row.total) && isCurrencyCode(row.currency) && typeof row.description === 'string' && (row.url === null || typeof row.url === 'string'))
const route = useRoute()
const api = useDashboardApi()
const { data, error } = await useAsyncData(() => `billing-history:${route.params.orgSlug}`, () => api<History>('/api/billing/history', { validate: isHistory }))
const statusLabel = (status: string) => status === 'paid' ? 'Paid' : status === 'open' ? 'Due' : status === 'uncollectible' ? 'Unpaid' : status
// Airbnb heads the current year "Completed" and each past year by its number.
const years = computed(() => {
  const current = String(new Date().getUTCFullYear())
  const groups = new Map<string, BillingInvoiceRow[]>()
  for (const row of data.value?.invoices ?? []) groups.set(row.created_at.slice(0, 4), [...(groups.get(row.created_at.slice(0, 4)) ?? []), row])
  return [...groups].map(([year, rows]) => ({ label: year === current ? 'Completed' : year, rows }))
})
</script>
