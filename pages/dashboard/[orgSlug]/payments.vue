<template>
  <!--
    Airbnb's account "Payments": one page, tabs across the top — Payments,
    Payouts, Plan — reached from the Earnings cog. The tab is in the URL, as Messages'
    view is, so a reload and a deep link land on the same one.
  -->
  <DashboardIndexPanel id="organization-payments" title="Payments" column="reading">
    <div class="pb-10">
      <UTabs v-model="tab" :items="tabs" :content="false" color="neutral" aria-label="Payments section" class="mb-8" />
      <PaymentsAccountSettings v-if="tab === 'payments'" />
      <PayoutMethodSettings v-else-if="tab === 'payouts'" />
      <PlanSettings v-else />
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import PayoutMethodSettings from '~/components/dashboard/settings/PayoutMethodSettings.vue'
import PlanSettings from '~/components/dashboard/settings/PlanSettings.vue'
import PaymentsAccountSettings from '~/components/dashboard/settings/PaymentsAccountSettings.vue'

definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'dashboard-orgSlug-earnings' })
useSeoMeta({ title: 'Payments | KrabiClaw', robots: 'noindex, nofollow' })

const route = useRoute()
const router = useRouter()
type Tab = 'payments' | 'payouts' | 'plan'
const tabs: Array<{ label: string; value: Tab }> = [
  { label: 'Payments', value: 'payments' },
  { label: 'Payouts', value: 'payouts' },
  { label: 'Plan', value: 'plan' },
]
const tab = computed<string | number>({
  get: () => route.query.tab === 'plan' || route.query.tab === 'payouts' ? String(route.query.tab) : 'payments',
  set: value => void router.replace({ query: { ...route.query, tab: value === 'payments' ? undefined : String(value) } }),
})
</script>
