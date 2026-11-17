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
              <img v-if="entry.image_url" :src="entry.image_url" alt="" class="size-full object-cover" loading="lazy">
              <UIcon v-else name="i-lucide-receipt" class="size-6 text-dimmed" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block text-base font-medium text-highlighted">{{ paymentHeadline(entry) }}</span>
              <span class="block truncate text-sm text-muted">{{ entry.organization_name }}</span>
              <span class="block truncate text-sm text-muted">{{ paymentWhenLabel(entry) }}</span>
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
import { paymentHeadline, paymentWhenLabel, paymentYearLabel } from '~/shared/account-screen'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Payments | Blawby', robots: 'noindex, nofollow' })

const PAGE = 10
const shown = ref(PAGE)
const session = authClient.useSession()
const { data, error } = await useAsyncData(
  () => `account-payments:${session.value.data?.user.id}`,
  () => applicationFetch<{ entries: BuyerPaymentEntry[] }>('/api/account/payments', { validate: (value): value is { entries: BuyerPaymentEntry[] } => isRecord(value) && Array.isArray(value.entries) && value.entries.every(isBuyerPaymentEntry) }),
)
const entries = computed(() => data.value?.entries ?? [])
const years = computed(() => {
  const groups = new Map<string, BuyerPaymentEntry[]>()
  for (const entry of entries.value.slice(0, shown.value)) {
    const label = paymentYearLabel(entry)
    groups.set(label, [...(groups.get(label) ?? []), entry])
  }
  return [...groups].map(([label, list]) => ({ label, entries: list }))
})
</script>
