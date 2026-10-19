<template>
  <!--
    Airbnb's account "Payments": one page, tabs across the top — Payments,
    Payouts, Plan — reached from the Earnings cog. The tab is in the URL, as Messages'
    view is, so a reload and a deep link land on the same one. Each tab is rows,
    each row a leaf beside this column; the first row of the open tab is chosen
    on arrival where there is a pane, as Integrations and Account settings do.
  -->
  <DashboardIndexPanel id="organization-payments" title="Payments" :auto-open="firstRow">
    <div class="pb-10">
      <DashboardFilterPills
        id="payments-tab"
        v-model="tab"
        label="Payments section"
        :items="tabs"
        role="tablist"
        class="mb-8"
      />
      <UAlert v-if="billingError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(billingError, 'Failed to load billing')" />
      <UAlert v-if="tab === 'plan' && usageError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(usageError, 'Payments fees could not be loaded')" />
      <UAlert v-if="tab === 'plan' && servicesError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(servicesError, 'Services could not be loaded')" />
      <UAlert v-if="tab === 'payouts' && connectError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" title="Stripe Connect is unavailable" :description="getErrorMessage(connectError, 'Stripe Connect status could not be loaded')" />
      <UAlert v-if="tab === 'payments' && methodsError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(methodsError, 'Payment methods could not be loaded')" />
      <UAlert v-if="errorMessage" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="errorMessage" />
      <UAlert v-if="successMessage" class="mb-6" color="success" variant="soft" icon="i-lucide-circle-check" :description="successMessage" />
      <EditorNavigationList :groups="groups" :active-item="level.child.value" @act="onRowAction" />
    </div>

    <!-- An operator's one-off: a Stripe credit note verified against the pending credit Metronome reported. -->
    <DashboardListItemDialog v-model:open="creditOpen" title="Verify credit note" :saving="busy" :save-disabled="!creditNote.trim()" :error="sheetError" save-label="Verify credit" @save="settleCredit">
      <UFormField label="Issued Stripe credit note ID"><UInput v-model="creditNote" placeholder="cn_…" :disabled="busy" class="w-full" /></UFormField>
    </DashboardListItemDialog>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup, type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import { authClient } from '~/lib/auth-client'
import { additionalLocationPrice, additionalRentalUnitPrice, BUSINESS_PLAN_ID, INCLUDED_LOCATIONS, INCLUDED_RENTAL_UNITS, SERVICE_PRICES, STARTER_PLAN_ID, isNewSalePlan, SERVICES } from '~/shared/billing-model'
import { paymentMoney } from '~/shared/payment-display'
import { getPlanEntitlements } from '~/server/utils/billing-entitlements'
import { cardBrandLabel, connectStatusPresentation, useConnectAccount, useOrganizationBilling, useOrganizationServices, usePaymentMethods, usePaymentsUsage } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'dashboard-orgSlug-earnings' })
useSeoMeta({ title: 'Payments | KrabiClaw', robots: 'noindex, nofollow' })

const route = useRoute()
const router = useRouter()
const level = useRouteLevel()
const dashboardApi = useDashboardApi()
const dashboard = useDashboardOrganization()
const { trackSubscriptionCheckoutSuccess } = useAnalytics()
const { startOrganizationCheckout } = useOrganizationSubscription()
const { plans } = await usePlans()
const { formatExactDateTime } = useHumanTime()

type Tab = 'payments' | 'payouts' | 'plan'
const tabs: Array<{ label: string; value: Tab }> = [
  { label: 'Payments', value: 'payments' },
  { label: 'Payouts', value: 'payouts' },
  { label: 'Plan', value: 'plan' },
]
/** Which tab each leaf belongs to: an open leaf lights its tab whatever the query says. */
const LEAF_TABS: Record<string, Tab> = {
  'invoices': 'payments', 'payment-methods': 'payments',
  'payout-method': 'payouts', 'surcharge': 'payouts',
  'plan': 'plan', 'locations': 'plan', 'business': 'plan', 'cancel': 'plan', 'managed-ads': 'plan', 'strategy': 'plan',
}
const childTab = computed<Tab | null>(() => (level.child.value && LEAF_TABS[level.child.value]) || null)
const queryTab = computed<Tab | null>(() => route.query.tab === 'plan' || route.query.tab === 'payouts' || route.query.tab === 'payments' ? route.query.tab : null)
// A leaf's URL carries no tab. The column remembers which tab it opened from, and
// puts that tab back in the query when the leaf closes, so Back and a reload agree.
const remembered = ref<Tab | null>(null)
watch(childTab, (current, previous) => {
  if (current) { remembered.value = current; return }
  if (previous && remembered.value && remembered.value !== (queryTab.value ?? 'payments')) void router.replace({ path: level.path.value, query: { ...route.query, tab: remembered.value === 'payments' ? undefined : remembered.value } })
})
const tab = computed<string>({
  get: () => childTab.value ?? queryTab.value ?? remembered.value ?? 'payments',
  // Choosing a tab returns to this column's own URL; with a pane, the tab's first row opens from there.
  set: value => void router.replace({ path: level.path.value, query: { ...route.query, tab: value === 'payments' ? undefined : String(value) } }),
})

const [{ billing, billingError, refreshBilling }, { services, servicesError }, { usage, usageError, refreshUsage }, { account, payout, connectError }, { methods, methodsError }] = await Promise.all([
  useOrganizationBilling(), useOrganizationServices(), usePaymentsUsage(), useConnectAccount(), usePaymentMethods(),
])

const errorMessage = ref('')
const successMessage = ref('')
const sheetError = ref('')
const busy = ref(false)
const to = (leaf: string) => `${level.path.value}/${leaf}`

const currentPlan = computed(() => billing.value?.subscriptionPrice ?? plans.value.find(plan => plan.id === billing.value?.plan) ?? null)
const onStarter = computed(() => billing.value?.plan === STARTER_PLAN_ID && !billing.value.stripeSubscriptionId)
const scheduledPlan = computed(() => {
  const scheduled = billing.value?.scheduledPlan
  return scheduled ? { name: plans.value.find(plan => plan.id === scheduled.plan)?.name ?? scheduled.plan, at: scheduled.at } : null
})
// The current contract's price comes from Stripe, including retired contracts;
// the public catalog describes only plans available for a new purchase.
const planSummary = computed(() => {
  const status = billing.value
  if (!status) return ''
  if (onStarter.value) return 'Free'
  const parts: string[] = []
  const price = status.subscriptionPrice
  if (price) parts.push(`${paymentMoney(price.amount, price.currency)}/${price.interval === 'year' ? 'yr' : 'mo'}`)
  if (status.subscriptionStatus === 'past_due') parts.push('Payment past due')
  else if (scheduledPlan.value) parts.push(`Changes to ${scheduledPlan.value.name} on ${formatExactDateTime(scheduledPlan.value.at)}`)
  else if (status.currentPeriodEnd) parts.push(`${status.cancelAtPeriodEnd ? 'Ends' : 'Renews'} ${formatExactDateTime(status.currentPeriodEnd)}`)
  return parts.join(' · ')
})
// Stripe's phrasing: the included allowance, then the charge per additional unit.
const locationsSummary = computed(() => {
  const locations = billing.value?.locations
  if (!locations) return ''
  if (onStarter.value) return `${locations.used} of ${INCLUDED_LOCATIONS} included. Growth and Business add more locations.`
  if (billing.value?.billsRentalUnits) return `${locations.used} in use, not counting locations with only rental units, ${locations.covered} on your plan · ${INCLUDED_LOCATIONS} included, then ${additionalLocationPrice()}`
  if (!isNewSalePlan(billing.value?.plan) || billing.value?.plan === BUSINESS_PLAN_ID) return `${locations.used} in use, ${locations.covered} on your existing plan. Stripe shows the price before you confirm a change.`
  return `${locations.used} in use, ${locations.covered} on your plan · ${INCLUDED_LOCATIONS} included, then ${additionalLocationPrice(billing.value?.billingInterval)}`
})
const rentalUnitsSummary = computed(() => {
  const units = billing.value?.rentalUnits
  return units ? `${units.used} in use, ${units.covered} on your plan · ${INCLUDED_RENTAL_UNITS} included, then ${additionalRentalUnitPrice()}` : ''
})
// Business bills its locations and rental units together, so both rows open its leaf.
const quantityLeaf = computed(() => billing.value?.plan === BUSINESS_PLAN_ID ? 'business' : 'locations')
const locationsChangeable = computed(() => !!billing.value && !onStarter.value && billing.value.subscriptionStatus === 'active' && !scheduledPlan.value && !billing.value.cancelAtPeriodEnd)

const paymentRows = computed<EditorNavigationItem[]>(() => {
  const cards = methods.value?.payment_methods ?? []
  const main = cards.find(card => card.default) ?? cards[0]
  return [
    { id: 'invoices', label: 'Your payments', summary: 'Keep track of all your payments and refunds.', to: to('invoices') },
    { id: 'payment-methods', label: 'Payment methods', to: to('payment-methods'), ...(methods.value
      ? { summary: main ? `${cardBrandLabel(main.brand)} ${main.last4}${main.default ? ' · Default' : ''}${cards.length > 1 ? ` · ${cards.length} cards` : ''}` : 'No payment methods saved yet.' }
      : {}) },
  ]
})
const payoutRows = computed<EditorNavigationItem[]>(() => [
  { id: 'payout-method', label: 'How you get paid', to: to('payout-method'), ...(payout.value
    ? { summary: `${payout.value.bankName ?? 'Bank account'}, ••••${payout.value.last4} (${payout.value.currency})`, status: 'success' as const }
    : { summary: connectStatusPresentation(account.value?.status).description, status: account.value ? 'neutral' as const : undefined }) },
  ...(account.value?.status === 'ready' ? [{ id: 'surcharge', label: 'Card surcharge', to: to('surcharge'), summary: account.value.surchargeBasisPoints === null ? 'Off. Pass credit card fees on to the buyer.' : `On at ${account.value.surchargeBasisPoints / 100}%.` }] : []),
])
const planRows = computed<EditorNavigationItem[]>(() => [
  { id: 'plan', label: currentPlan.value?.name ?? 'Plan', summary: planSummary.value, to: to('plan') },
  ...(billing.value ? [{ id: 'locations', label: 'Locations', summary: locationsSummary.value, ...(locationsChangeable.value ? { to: to(quantityLeaf.value) } : {}) }] : []),
  ...(billing.value?.rentalUnits ? [{ id: 'rental-units', label: 'Rental units', summary: rentalUnitsSummary.value, ...(locationsChangeable.value ? { to: to('business') } : {}) }] : []),
  ...(usage.value?.pricing ? [{ id: 'fees', label: 'Payments fees', summary: `${usage.value.pricing.captured_volume_rate_percent}% of payment volume, plus Stripe fees.${usage.value.pricing.ad_spend_rate_percent === null ? '' : ` ${usage.value.pricing.ad_spend_rate_percent}% of monthly ad spend for campaigns we manage.`} Fees aren’t returned after a refund or dispute.` }] : []),
  ...(usage.value && usage.value.configured === false && billing.value && getPlanEntitlements(billing.value.plan).payments === true ? [{ id: 'usage:pending', label: 'Payments fees', summary: 'Getting ready. Fees for payments you take before then are billed once it’s done.' }] : []),
  ...(usage.value?.account && ['servicing', 'closing'].includes(usage.value.account.status) ? [{ id: 'usage:finalize', label: 'Previous Payments billing', summary: 'Charges from earlier payments still apply; end it once they are settled.', action: { label: 'End' } }] : []),
  ...(usage.value?.credits ?? []).map(credit => ({ id: `credit:${credit.id}`, label: `Pending credit ${paymentMoney(-credit.amount, credit.currency)}`, summary: 'Issue the credit in Stripe, then verify its credit note here.', action: { label: 'Verify' } })),
  ...(billing.value && (scheduledPlan.value || billing.value.cancelAtPeriodEnd) && currentPlan.value ? [{ id: 'restore', label: `Keep ${currentPlan.value.name}`, summary: scheduledPlan.value ? `Stay on ${currentPlan.value.name} instead of changing to ${scheduledPlan.value.name}.` : `Stay on ${currentPlan.value.name} after ${formatExactDateTime(billing.value.currentPeriodEnd!)}.`, action: { label: 'Keep plan' } }] : []),
  ...(!onStarter.value && billing.value && !billing.value.cancelAtPeriodEnd && !scheduledPlan.value ? [{ id: 'cancel', label: 'Cancel plan', summary: 'If you cancel, you keep full access to your plan features until the end of your billing period.', to: to('cancel') }] : []),
])
// What KrabiClaw's people do for the business, beside the plan that includes the software.
const serviceRows = computed<EditorNavigationItem[]>(() => services.value
  ? [
      { id: 'managed-ads', label: SERVICES.managed_ads.name, to: to('managed-ads'), summary: services.value.managed_ads
        ? `On since ${formatExactDateTime(services.value.managed_ads.agreed_at)} · ${SERVICES.managed_ads.price}, billed with your fees.`
        : `${SERVICES.managed_ads.description} · ${SERVICES.managed_ads.price}.`, status: services.value.managed_ads ? 'success' : undefined },
      { id: 'strategy', label: SERVICES.strategy.name, to: to('strategy'), summary: services.value.strategy
        ? `On since ${formatExactDateTime(services.value.strategy.since)} · ${paymentMoney(services.value.strategy.amount, services.value.strategy.currency)} per ${services.value.strategy.interval}, billed with your plan.`
        : `${SERVICES.strategy.description} · ${paymentMoney(SERVICE_PRICES.strategy.monthly, 'USD')} per month.`, status: services.value.strategy ? 'success' : undefined },
    ]
  : [])

const groups = computed<EditorNavigationGroup[]>(() => {
  if (tab.value === 'payments') return [{ id: 'payments', items: paymentRows.value }]
  if (tab.value === 'payouts') return [{ id: 'payouts', items: payoutRows.value }]
  return [{ id: 'billing', label: 'Plan', items: planRows.value }, { id: 'services', label: 'Services', items: serviceRows.value }]
})
// The open tab's first leaf: Your payments, How you get paid, or the plan.
const firstRow = computed(() => groups.value[0]?.items.find(item => item.to)?.to ?? null)

const organizationId = () => {
  const id = dashboard.organization.value?.id
  if (!id) throw new Error('Organization context is unavailable')
  return id
}

async function onRowAction(id: string) {
  if (busy.value) return
  errorMessage.value = ''
  if (id.startsWith('credit:')) { creditId.value = id.slice('credit:'.length); creditNote.value = ''; sheetError.value = ''; return }
  busy.value = true
  try {
    if (id === 'restore') {
      // Better Auth's restore releases the schedule or the pending cancellation at Stripe.
      const restored = await authClient.subscription.restore({ referenceId: organizationId(), customerType: 'organization' })
      if (restored.error) throw new Error(restored.error.message ?? 'Your plan could not be kept')
      await refreshBilling()
    }
    else if (id === 'usage:finalize') { await dashboardApi('/api/dashboard/payments/billing', { method: 'POST', body: { action: 'finalize' }, validate: (value: unknown): value is Record<string, unknown> => isRecord(value) && value.closed === true }); await refreshUsage() }
    else if (id !== 'fees' && id !== 'usage:pending') throw new Error('Unknown billing action')
  } catch (error) {
    errorMessage.value = getErrorMessage(error, 'Billing is unavailable right now')
  } finally {
    busy.value = false
  }
}

const creditId = ref<string | null>(null)
const creditNote = ref('')
const creditOpen = computed({ get: () => creditId.value !== null, set: (open: boolean) => { if (!open) { creditId.value = null; creditNote.value = '' } } })
async function settleCredit() {
  if (busy.value || !creditId.value || !creditNote.value.trim()) return
  busy.value = true
  sheetError.value = ''
  try {
    await dashboardApi('/api/dashboard/payments/billing', { method: 'POST', body: { action: 'reconcile_credit', event_id: creditId.value, credit_note_id: creditNote.value.trim() }, validate: (value: unknown): value is Record<string, unknown> => isRecord(value) && value.settled === true })
    await refreshUsage()
    creditOpen.value = false
  } catch (error) {
    sheetError.value = getErrorMessage(error, 'The credit note could not be verified')
  } finally {
    busy.value = false
  }
}

// Stripe sends the tenant back here with success or canceled; /api/post-login?plan=… arrives with the plan still to buy.
onMounted(async () => {
  const { success, plan, canceled, ...restQuery } = route.query
  if (success === 'true') {
    const id = dashboard.organization.value?.id
    if (id) trackSubscriptionCheckoutSuccess(id, typeof plan === 'string' ? plan : undefined)
    successMessage.value = typeof plan === 'string' && billing.value?.plan === plan
      ? 'Payment confirmed. Your plan has been updated.'
      : 'Payment is processing. Your plan will activate after Stripe confirms the subscription.'
  }
  if (canceled === 'true') errorMessage.value = 'Payment was canceled. Your plan was not changed.'
  if (success || plan || canceled) await router.replace({ query: restQuery })
  if (success || canceled) return
  const planId = Array.isArray(plan) ? plan[0] : plan
  if (typeof planId === 'string' && isNewSalePlan(planId) && !busy.value) {
    busy.value = true
    try {
      await startOrganizationCheckout(organizationId(), planId)
    } catch (error) {
      errorMessage.value = getErrorMessage(error, 'The plan could not be changed')
    } finally {
      busy.value = false
    }
  }
})
</script>
