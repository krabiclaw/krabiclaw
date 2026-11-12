<template>
  <!-- Money going the other way, in plain words, each row opening the record it belongs to. -->
  <!-- A level of Earnings: the approval sheet opens as its leaf. -->
  <DashboardIndexPanel id="earnings-refunds" title="Refunds and disputes">
    <UAlert v-if="error" color="error" :description="error.message" />
    <template v-else-if="refunds && disputes">
      <section>
        <h2 class="text-base font-semibold text-highlighted">Refunds</h2>
        <p v-if="!refunds.rows.length" class="mt-2 text-base text-muted">No refunds yet.</p>
        <EditorNavigationList v-else class="mt-2" :groups="[{ id: 'refunds', items: refunds.rows.map(row => item(row, 'refund')) }]" />
      </section>
      <section class="mt-8 border-t border-default pt-6">
        <h2 class="text-base font-semibold text-highlighted">Disputes</h2>
        <p v-if="!disputes.rows.length" class="mt-2 text-base text-muted">No disputes.</p>
        <EditorNavigationList v-else class="mt-2" :groups="[{ id: 'disputes', items: disputes.rows.map(row => item(row, 'dispute')) }]" />
      </section>
    </template>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList from '~/components/dashboard/EditorNavigationList.vue'
import { paymentMoney } from '~/shared/payment-display'
import { isCurrencyCode } from '~/shared/currencies'

definePageMeta({ layout: 'dashboard' })

type Row = { id: string; payment_id: string; amount: number; currency: string; status: string; reason?: string | null }
type Rows = { rows: Row[]; next_cursor: string | null }
const route = useRoute()
const api = useDashboardApi()
const isRows = (value: unknown): value is Rows => isRecord(value) && Array.isArray(value.rows) && value.rows.every(row => isRecord(row) && typeof row.id === 'string' && typeof row.payment_id === 'string' && Number.isSafeInteger(row.amount) && isCurrencyCode(row.currency) && typeof row.status === 'string')
const load = (view: 'refunds' | 'disputes') => api<Rows>('/api/dashboard/payments', { query: { view }, validate: isRows })
const { data, error } = await useAsyncData(() => `earnings-refunds:${route.params.org_slug}`, async () => {
  const [refunds, disputes] = await Promise.all([load('refunds'), load('disputes')])
  return { refunds, disputes }
})
const refunds = computed(() => data.value?.refunds)
const disputes = computed(() => data.value?.disputes)
const REFUND: Record<string, string> = { succeeded: 'Refunded', pending: 'On its way', queued: 'Requested', creating: 'Requested', requires_action: 'Needs attention', failed: 'Failed', canceled: 'Cancelled' }
const DISPUTE: Record<string, string> = { needs_response: 'Needs a response', under_review: 'Under review', won: 'Won', lost: 'Lost', warning_needs_response: 'Needs a response', warning_under_review: 'Under review', warning_closed: 'Closed', charge_refunded: 'Refunded' }
function item(row: Row, kind: 'refund' | 'dispute') {
  const words = kind === 'refund' ? REFUND : DISPUTE
  return { id: row.id, label: paymentMoney(row.amount, row.currency), summary: words[row.status] ?? row.status.replace(/_/g, ' '), to: `/dashboard/${route.params.org_slug}/earnings/transactions/${encodeURIComponent(row.payment_id)}` }
}
</script>
