<template>
  <!--
    Airbnb's Payouts: how the money the organization takes in reaches it. Its
    plan and what it pays KrabiClaw are Plan and billing, a Menu row of its
    own. Reached from the Earnings cog; each row is a leaf beside this column,
    and the first opens on arrival where there is a pane.
  -->
  <DashboardIndexPanel id="organization-payments" title="Payments" :auto-open="firstRow">
    <div class="pb-10">
      <UAlert v-if="connectError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" title="Stripe Connect is unavailable" :description="getErrorMessage(connectError, 'Stripe Connect status could not be loaded')" />
      <p v-else-if="connectPending" role="status" class="text-muted">Loading payment settings…</p>
      <EditorNavigationList v-else :groups="groups" :active-item="level.child.value" />
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup, type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'
import { connectStatusPresentation, useConnectAccount } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'dashboard-orgSlug-earnings' })
useSeoMeta({ title: 'Payments | KrabiClaw', robots: 'noindex, nofollow' })

const level = useRouteLevel()
const { account, payout, connectError, connectPending } = useConnectAccount()
const to = (leaf: string) => `${level.path.value}/${leaf}`

const rows = computed<EditorNavigationItem[]>(() => [
  { id: 'payout-method', label: 'How you get paid', to: to('payout-method'), ...(payout.value
    ? { summary: `${payout.value.bankName ?? 'Bank account'}, ••••${payout.value.last4} (${payout.value.currency})`, status: 'success' as const }
    : { summary: connectStatusPresentation(account.value?.status).description, status: account.value ? 'neutral' as const : undefined }) },
  ...(account.value?.status === 'ready' ? [{ id: 'surcharge', label: 'Card surcharge', to: to('surcharge'), summary: account.value.surchargeBasisPoints === null ? 'Off. Pass credit card fees on to the buyer.' : `On at ${account.value.surchargeBasisPoints / 100}%.` }] : []),
])
const groups = computed<EditorNavigationGroup[]>(() => [{ id: 'payouts', items: rows.value }])
const firstRow = computed(() => rows.value[0]?.to ?? null)
</script>
