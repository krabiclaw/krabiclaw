<template>
  <!--
    The account's payments: every payment and refund, newest first, the current
    year headed Completed and past years by their number; each line carries the
    place's picture, what and when, and the amount, and opens its record.
  -->
  <DashboardLeafPanel id="account-payments" title="Payments" :footer="false">
    <UAlert v-if="error" color="error" title="Payments could not be loaded" :description="getErrorMessage(error, 'Payments request failed.')" />
    <template v-else-if="years.length">
      <section v-for="year in years" :key="year.label" class="mb-8">
        <h2 class="text-xl font-semibold text-highlighted">{{ year.label }}</h2>
        <div class="mt-4 space-y-6">
          <NuxtLink v-for="entry in year.entries" :key="entry.id" :to="entry.to" class="flex items-center gap-4" :data-testid="`account-payment-${entry.id}`">
            <span class="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-elevated">
              <img v-if="entry.imageUrl" :src="entry.imageUrl" alt="" class="size-full object-cover" loading="lazy">
              <UIcon v-else name="i-lucide-receipt" class="size-6 text-dimmed" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block text-base font-medium text-highlighted">{{ entry.kind === 'paid' ? 'Paid' : 'Refunded' }} {{ formatTimestamp(entry.occurredAt, 'en', 'UTC', { month: 'short', day: 'numeric' }) }}</span>
              <span class="block truncate text-sm text-muted">{{ entry.organizationName }}</span>
              <span class="block truncate text-sm text-muted">{{ whenLabel(entry) }}</span>
            </span>
            <span class="shrink-0 text-right">
              <span class="block text-base font-medium tabular-nums text-highlighted">{{ paymentMoney(entry.amount, entry.currency) }}</span>
              <span class="block text-sm text-muted">{{ entry.currency }}</span>
            </span>
            <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
          </NuxtLink>
        </div>
      </section>
      <UButton v-if="shown < entries.length" color="neutral" variant="soft" size="lg" class="w-full justify-center" label="Show more" @click="shown += PAGE" />
    </template>
    <UEmpty v-else-if="data" icon="i-lucide-receipt" title="No payments yet" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import { isBuyerPaymentEntry, type BuyerPaymentEntry } from '~/shared/account-activity'
import { paymentMoney } from '~/shared/payment-display'
import { formatTimestamp } from '~/utils/timezone'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Payments | KrabiClaw', robots: 'noindex, nofollow' })

const PAGE = 10
const shown = ref(PAGE)
const session = authClient.useSession()
const { data, error } = await useAsyncData(
  () => `account-payments:${session.value.data?.user.id}`,
  () => applicationFetch<{ entries: BuyerPaymentEntry[] }>('/api/account/payments', { validate: (value): value is { entries: BuyerPaymentEntry[] } => isRecord(value) && Array.isArray(value.entries) && value.entries.every(isBuyerPaymentEntry) }),
)
const entries = computed(() => data.value?.entries ?? [])
// Airbnb heads the current year "Completed" and each past year by its number.
const years = computed(() => {
  const current = String(new Date().getUTCFullYear())
  const groups = new Map<string, BuyerPaymentEntry[]>()
  for (const entry of entries.value.slice(0, shown.value)) {
    const year = entry.occurredAt.slice(0, 4)
    groups.set(year, [...(groups.get(year) ?? []), entry])
  }
  return [...groups].map(([year, list]) => ({ label: year === current ? 'Completed' : year, entries: list }))
})
// "Thủ Đức · Aug 11–Oct 11": what, and the dates of the visit it paid for.
function whenLabel(entry: BuyerPaymentEntry): string {
  if (!entry.visitStartsAt || !entry.visitEndsAt || !entry.timeZone) return entry.title
  const start = formatTimestamp(entry.visitStartsAt, 'en', entry.timeZone, { month: 'short', day: 'numeric' })
  const end = formatTimestamp(entry.visitEndsAt, 'en', entry.timeZone, { month: 'short', day: 'numeric' })
  return `${entry.title} · ${start === end ? start : `${start}–${end}`}`
}
</script>
