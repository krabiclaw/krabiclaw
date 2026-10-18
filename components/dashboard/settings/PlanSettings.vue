<template>
  <!--
    The Plan tab, in Airbnb's rows: the plan you are on with Manage, what
    Payments costs, and Cancel plan. Manage opens the plans as a sheet; the
    change itself is Better Auth's subscription flow, which Stripe confirms with
    its proration before anything is charged.
  -->
  <div class="space-y-6">
    <UAlert v-if="billingError" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(billingError, 'Failed to load billing')" />
    <UAlert v-if="usageError" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(usageError, 'Payments fees could not be loaded')" />
    <UAlert v-if="servicesError" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(servicesError, 'Services could not be loaded')" />
    <UAlert v-if="errorMessage" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="errorMessage" />
    <UAlert v-if="successMessage" color="success" variant="soft" icon="i-lucide-circle-check" :description="successMessage" />
    <EditorNavigationList :groups="groups" @act="onRowAction" />

    <!-- ChatGPT's picker in our cards: every plan for sale, the current one marked, each with what it includes. -->
    <DashboardListItemDialog v-model:open="choosing" title="Change plan" :show-actions="false" :error="sheetError">
      <div class="grid gap-4 md:grid-cols-2">
        <BillingPlanCard v-for="plan in salePlans" :key="plan.id" :plan="plan" :highlighted="plan.id === billing?.plan">
          <template #cta>
            <UButton v-if="plan.id === billing?.plan" label="Your current plan" color="neutral" variant="outline" size="xl" block disabled />
            <UButton v-else :label="`Switch to ${plan.name}`" size="xl" block :loading="busy" @click="choosePlan(`plan:${plan.id}`)" />
          </template>
        </BillingPlanCard>
      </div>
    </DashboardListItemDialog>
    <DashboardListItemDialog v-model:open="locationsOpen" title="Locations on your plan" :saving="busy" :save-disabled="!locationsChanged" :error="sheetError" save-label="Continue to Stripe" @save="saveLocations">
      <UFormField label="Locations" :description="locationsDialogNote">
        <UInputNumber v-model="locationsQuantity" :min="locationsMinimum" :disabled="busy" class="w-full" />
      </UFormField>
    </DashboardListItemDialog>
    <!-- Managed ads: the consent that starts the 10% fee, stated before it is agreed. -->
    <DashboardListItemDialog v-model:open="managedAdsOpen" :title="services?.managed_ads ? 'Turn off managed ads' : 'Managed ads'" :saving="busy" :error="sheetError" :save-label="services?.managed_ads ? 'Turn off' : 'Agree and turn on'" @save="toggleManagedAds">
      <div class="space-y-3 text-base text-muted">
        <template v-if="services?.managed_ads">
          <p>Chris stops managing your campaigns. Today's spend is excluded if you turn this off before the day closes in your Google Ads account's time zone. Earlier managed days are still billed.</p>
          <p>Keep Google Ads connected until your prior managed spend has been counted. We count each day after two days.</p>
        </template>
        <template v-else>
          <p>Chris hand-manages the campaigns in your connected Google Ads account — budgets, creative direction and conversion rate — and meets with you weekly. Results stay in Insights.</p>
          <p>The fee is <strong class="text-highlighted">10% of your Google Ads spend</strong>, read from Google each day and billed with your monthly KrabiClaw fees. Google bills the ad spend itself to your Google Ads account. You can turn it off here at any time.</p>
          <p>Reporting days follow your Google Ads account's time zone. A day's spend is included only if managed ads is on when that day closes.</p>
          <p>Before turning it on, connect a Google Ads account billed in USD and set up active Payments billing with a default payment method.</p>
          <div class="flex flex-wrap gap-3">
            <UButton v-if="billing && (!billing.stripeCustomerId || (usage?.configured === false && !getPlanEntitlements(billing.plan).payments))" label="Choose a plan with Payments" color="neutral" variant="outline" @click="managedAdsOpen = false; choosing = true" />
            <UButton v-if="billing?.stripeCustomerId" label="Payment methods" color="neutral" variant="outline" :to="`/dashboard/${route.params.orgSlug}/payments`" @click="managedAdsOpen = false" />
            <UButton label="Google Ads settings" color="neutral" variant="outline" :to="`/dashboard/${route.params.orgSlug}/integrations/google-ads`" @click="managedAdsOpen = false" />
            <UButton label="Billing setup help" color="neutral" variant="link" to="/help" />
          </div>
        </template>
      </div>
    </DashboardListItemDialog>
    <!-- Strategy: the consent that adds Julia's service to the plan subscription; Stripe prorates and bills it. -->
    <DashboardListItemDialog v-model:open="strategyOpen" :title="services?.strategy ? 'Turn off the strategy service' : 'SEO and marketing strategy'" :saving="busy" :error="sheetError" :save-label="services?.strategy ? 'Turn off' : 'Agree and turn on'" @save="toggleStrategy">
      <div class="space-y-3 text-base text-muted">
        <template v-if="services?.strategy">
          <p>Julia's service ends now. Stripe credits the unused part of this period to your next invoice.</p>
        </template>
        <template v-else>
          <p>Julia leads your SEO strategy, hand-writes blog posts written to rank, meets with you weekly and is on chat with you.</p>
          <p>It costs <strong class="text-highlighted">{{ paymentMoney(strategyOffer.amount, strategyOffer.currency) }} per {{ strategyOffer.interval }}</strong>, added to your plan's subscription and billed to the same card. Stripe charges today's share now and the full amount with each plan renewal. You can turn it off here at any time.</p>
        </template>
      </div>
    </DashboardListItemDialog>
    <DashboardListItemDialog v-model:open="creditOpen" title="Verify credit note" :saving="busy" :save-disabled="!creditNote.trim()" :error="sheetError" save-label="Verify credit" @save="settleCredit">
      <UFormField label="Issued Stripe credit note ID"><UInput v-model="creditNote" placeholder="cn_…" :disabled="busy" class="w-full" /></UFormField>
    </DashboardListItemDialog>
  </div>
</template>

<script setup lang="ts">
import EditorNavigationList from '~/components/dashboard/EditorNavigationList.vue'
import type { EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import { authClient } from '~/lib/auth-client'
import { additionalLocationPrice, INCLUDED_LOCATIONS, SERVICE_PRICES, STARTER_PLAN_ID, isKnownBillingPlan, isNewSalePlan } from '~/shared/billing-model'
import { isLocationCount } from '~/composables/useOrganizationSubscription'
import { paymentMoney } from '~/shared/payment-display'
import { getPlanEntitlements } from '~/server/utils/billing-entitlements'
import { isCurrencyCode } from '~/shared/currencies'

const route = useRoute()
const router = useRouter()
const dashboardApi = useDashboardApi()
const dashboard = useDashboardOrganization()
const { trackSubscriptionCheckoutSuccess } = useAnalytics()
const { startOrganizationCheckout, setPlanLocations } = useOrganizationSubscription()
const { plans } = await usePlans()
const { formatExactDateTime } = useHumanTime()

const errorMessage = ref('')
const successMessage = ref('')
const sheetError = ref('')
const busy = ref(false)

// The services the business is on: a consent row each, read with the plan.
type Strategy = { item_id: string; amount: number; currency: string; interval: string; since: string }
type Services = { managed_ads: { id: string; agreed_at: string } | null; strategy: Strategy | null }
const isStrategy = (value: unknown): value is Strategy => isRecord(value) && typeof value.item_id === 'string' && Number.isSafeInteger(value.amount) && isCurrencyCode(value.currency) && typeof value.since === 'string'
const isServices = (value: unknown): value is { success: true; services: Services } => isRecord(value) && value.success === true && isRecord(value.services) && (value.services.managed_ads === null || (isRecord(value.services.managed_ads) && typeof value.services.managed_ads.agreed_at === 'string')) && (value.services.strategy === null || isStrategy(value.services.strategy))
const { data: servicesResource, error: servicesError, refresh: refreshServices } = await useAsyncData(`dashboard-services:${String(route.params.orgSlug)}`, () => dashboardApi('/api/dashboard/services', { validate: isServices }))
// Unknown until read: a failed read shows its error above and offers no service action.
const services = computed(() => servicesResource.value?.services)
// The offer's price is the catalog's, the same source the Stripe product was created from.
const strategyOffer = { amount: SERVICE_PRICES.strategy.monthly, currency: 'USD' as const, interval: 'month' }
const managedAdsOpen = ref(false)
const strategyOpen = ref(false)
// Stripe owns the strategy item: starting adds it to the plan subscription, ending removes it, both prorated by Stripe.
async function toggleStrategy() {
  if (!services.value) return
  busy.value = true
  sheetError.value = ''
  successMessage.value = ''
  try {
    const updated = await dashboardApi('/api/dashboard/services', { method: 'POST', body: { service: 'strategy', action: services.value.strategy ? 'end' : 'agree' }, validate: isServices })
    servicesResource.value = updated
    await refreshBilling()
    strategyOpen.value = false
    successMessage.value = updated.services.strategy ? 'The strategy service is on. Julia will be in touch to set up your weekly meeting and chat.' : 'The strategy service is off.'
  } catch (error) {
    sheetError.value = getErrorMessage(error, 'The strategy service could not be changed')
  } finally {
    busy.value = false
  }
}
async function toggleManagedAds() {
  if (!services.value) return
  busy.value = true
  sheetError.value = ''
  successMessage.value = ''
  try {
    const updated = await dashboardApi('/api/dashboard/services', { method: 'POST', body: { service: 'managed_ads', action: services.value.managed_ads ? 'end' : 'agree' }, validate: isServices })
    servicesResource.value = updated
    clearNuxtData(`dashboard-integrations:${String(route.params.orgSlug)}`)
    await refreshServices()
    if (servicesError.value) {
      // Nuxt records refresh errors instead of rejecting. Keep the actual write
      // result visible, and report the failed independent read before success.
      servicesResource.value = updated
      throw new Error(`Managed ads was turned ${updated.services.managed_ads ? 'on' : 'off'}, but its status could not be refreshed. ${getErrorMessage(servicesError.value, 'Reload to check its status.')}`)
    }
    managedAdsOpen.value = false
    successMessage.value = updated.services.managed_ads ? 'Managed ads is on. Chris will be in touch to set up your weekly meeting.' : 'Managed ads is off.'
  } catch (error) {
    sheetError.value = getErrorMessage(error, 'Managed ads could not be changed')
  } finally {
    busy.value = false
  }
}
const choosing = ref(false)

interface BillingStatus { organizationId: string; plan: string; stripeCustomerId?: string; stripeSubscriptionId?: string; subscriptionStatus?: string; currentPeriodEnd?: string; cancelAtPeriodEnd?: boolean; billingInterval?: 'month' | 'year'; subscriptionPrice?: { name: string; amount: number; currency: string; interval: 'month' | 'year' }; locations: { used: number; covered: number }; scheduledPlan?: { plan: string; at: string } | null }
const isBillingResponse = (value: unknown): value is { success: true; billing: BillingStatus } =>
  isRecord(value) && value.success === true && isRecord(value.billing) && typeof value.billing.organizationId === 'string' && isKnownBillingPlan(value.billing.plan)
  && isLocationCount(value.billing.locations)
  && (value.billing.subscriptionPrice === undefined || (isRecord(value.billing.subscriptionPrice) && typeof value.billing.subscriptionPrice.name === 'string' && Number.isSafeInteger(value.billing.subscriptionPrice.amount) && isCurrencyCode(value.billing.subscriptionPrice.currency) && ['month', 'year'].includes(String(value.billing.subscriptionPrice.interval))))
  && (value.billing.scheduledPlan === undefined || value.billing.scheduledPlan === null || (isRecord(value.billing.scheduledPlan) && isKnownBillingPlan(value.billing.scheduledPlan.plan) && typeof value.billing.scheduledPlan.at === 'string'))
const { data: billingResponse, error: billingError, refresh: refreshBilling } = await useAsyncData(
  computed(() => `dashboard-billing:${String(route.params.orgSlug || '')}`),
  () => dashboardApi('/api/billing/status', { query: { includePrice: 'true' }, validate: isBillingResponse }),
)
const billing = computed(() => billingResponse.value?.billing ?? null)

// What Payments costs, and the usage billing behind it, read from the same place the Earnings fees come from.
type Pricing = { captured_volume_rate_percent: string; ad_spend_rate_percent: string | null; livemode: boolean }
type Credit = { id: string; source_id: string; currency: string; amount: number }
type UsageBilling = { configured: boolean; account?: { status: string }; pricing: Pricing | null; credits: Credit[] }
const isUsageBilling = (value: unknown): value is UsageBilling => isRecord(value) && typeof value.configured === 'boolean'
  && (value.pricing === null || (isRecord(value.pricing) && (value.pricing.ad_spend_rate_percent === null || typeof value.pricing.ad_spend_rate_percent === 'string') && typeof value.pricing.captured_volume_rate_percent === 'string' && typeof value.pricing.livemode === 'boolean'))
  && (!value.configured || (isRecord(value.account) && typeof value.account.status === 'string'))
  && Array.isArray(value.credits) && value.credits.every(row => isRecord(row) && typeof row.id === 'string' && typeof row.source_id === 'string' && isCurrencyCode(row.currency) && Number.isSafeInteger(row.amount))
// Lazy on purpose: this reads Metronome's invoices and each one's Stripe collection
// invoice, and the plan rows above it do not wait on that provider round trip.
const { data: usage, error: usageError, refresh: refreshUsage } = await useAsyncData(() => `payments-billing:${route.params.orgSlug}`, () => dashboardApi<UsageBilling>('/api/dashboard/payments/billing', { validate: isUsageBilling }), { lazy: true })

const currentPlan = computed(() => billing.value?.subscriptionPrice ?? plans.value.find(plan => plan.id === billing.value?.plan) ?? null)
const onStarter = computed(() => billing.value?.plan === STARTER_PLAN_ID && !billing.value.stripeSubscriptionId)
const scheduledPlan = computed(() => {
  const scheduled = billing.value?.scheduledPlan
  return scheduled ? { name: plans.value.find(plan => plan.id === scheduled.plan)?.name ?? scheduled.plan, at: scheduled.at } : null
})
// The current contract's price comes from Stripe, including retired contracts;
// the public catalog describes only plans available for a new purchase.
const planCharge = computed(() => {
  const price = billing.value?.subscriptionPrice
  return price ? `${paymentMoney(price.amount, price.currency)}/${price.interval === 'year' ? 'yr' : 'mo'}` : null
})

const planSummary = computed(() => {
  const status = billing.value
  if (!status) return ''
  if (onStarter.value) return 'Free'
  const parts: string[] = []
  const charge = planCharge.value
  if (charge) parts.push(charge)
  if (status.subscriptionStatus === 'past_due') parts.push('Payment past due')
  else if (scheduledPlan.value) parts.push(`Changes to ${scheduledPlan.value.name} on ${formatExactDateTime(scheduledPlan.value.at)}`)
  else if (status.currentPeriodEnd) parts.push(`${status.cancelAtPeriodEnd ? 'Ends' : 'Renews'} ${formatExactDateTime(status.currentPeriodEnd)}`)
  return parts.join(' · ')
})

// Stripe's phrasing: the included allowance, then the charge per additional unit.
const locationPrice = computed(() => additionalLocationPrice(billing.value?.billingInterval))
const locationsSummary = computed(() => {
  const locations = billing.value?.locations
  if (!locations) return ''
  if (onStarter.value) return `${locations.used} of ${INCLUDED_LOCATIONS} included. Growth and Business add more locations.`
  if (!isNewSalePlan(billing.value?.plan)) return `${locations.used} in use, ${locations.covered} on your existing plan. Stripe shows the price before you confirm a change.`
  return `${locations.used} in use, ${locations.covered} on your plan · ${INCLUDED_LOCATIONS} included, then ${locationPrice.value}`
})
// Lowering below the locations in use would bill for fewer than the site has.
const locationsMinimum = computed(() => Math.max(INCLUDED_LOCATIONS, billing.value?.locations.used ?? INCLUDED_LOCATIONS))
const locationsQuantity = ref(INCLUDED_LOCATIONS)
const locationsOpen = ref(false)
const locationsChanged = computed(() => locationsQuantity.value !== billing.value?.locations.covered)
const locationsDialogNote = computed(() => billing.value && isNewSalePlan(billing.value.plan)
  ? `${INCLUDED_LOCATIONS} included, then ${locationPrice.value}. Stripe shows what changes on your bill before you confirm.`
  : 'Your existing plan and price continue. Stripe shows what changes on your bill before you confirm.')

const groups = computed<EditorNavigationGroup[]>(() => [{
  id: 'billing',
  label: 'Plan',
  items: [
    { id: 'plan', label: currentPlan.value?.name ?? 'Plan', summary: planSummary.value, action: { label: onStarter.value ? 'Choose a plan' : 'Manage' } },
    ...(billing.value ? [{ id: 'locations', label: 'Locations', summary: locationsSummary.value, ...(onStarter.value || billing.value.subscriptionStatus !== 'active' || scheduledPlan.value || billing.value.cancelAtPeriodEnd ? {} : { action: { label: 'Change' } }) }] : []),
    ...(usage.value?.pricing ? [{ id: 'fees', label: 'Payments fees', summary: `${usage.value.pricing.captured_volume_rate_percent}% of payment volume, plus Stripe fees.${usage.value.pricing.ad_spend_rate_percent === null ? '' : ` ${usage.value.pricing.ad_spend_rate_percent}% of monthly ad spend for campaigns we manage.`} Fees aren’t returned after a refund or dispute.` }] : []),
    ...(usage.value && usage.value.configured === false && billing.value && getPlanEntitlements(billing.value.plan).payments === true ? [{ id: 'usage:pending', label: 'Payments fees', summary: 'Getting ready. Fees for payments you take before then are billed once it’s done.' }] : []),
    ...(usage.value?.account && ['servicing', 'closing'].includes(usage.value.account.status) ? [{ id: 'usage:finalize', label: 'Previous Payments billing', summary: 'Charges from earlier payments still apply; end it once they are settled.', action: { label: 'End' } }] : []),
    ...(usage.value?.credits ?? []).map(credit => ({ id: `credit:${credit.id}`, label: `Pending credit ${paymentMoney(-credit.amount, credit.currency)}`, summary: 'Issue the credit in Stripe, then verify its credit note here.', action: { label: 'Verify' } })),
    ...(billing.value && (scheduledPlan.value || billing.value.cancelAtPeriodEnd) && currentPlan.value ? [{ id: 'restore', label: `Keep ${currentPlan.value.name}`, summary: scheduledPlan.value ? `Stay on ${currentPlan.value.name} instead of changing to ${scheduledPlan.value.name}.` : `Stay on ${currentPlan.value.name} after ${formatExactDateTime(billing.value.currentPeriodEnd!)}.`, action: { label: 'Keep plan' } }] : []),
    ...(!onStarter.value && billing.value && !billing.value.cancelAtPeriodEnd && !scheduledPlan.value ? [{ id: 'cancel', label: 'Cancel plan', summary: 'If you cancel, you keep full access to your plan features until the end of your billing period.', action: { label: 'Cancel' } }] : []),
  ],
}, {
  // What KrabiClaw's people do for the business, beside the plan that includes the software.
  id: 'services',
  label: 'Services',
  items: [
    ...(services.value ? [{ id: 'service:managed_ads', label: 'Managed ads', summary: services.value.managed_ads
      ? `On since ${formatExactDateTime(services.value.managed_ads.agreed_at)} · 10% of Google Ads spend, billed with your fees.`
      : 'Chris manages your Google Ads campaigns, creative and conversion rate, with a weekly meeting · 10% of ad spend.', action: { label: services.value.managed_ads ? 'Turn off' : 'Turn on' } }] : []),
    ...(services.value ? [{ id: 'service:strategy', label: 'SEO and marketing strategy', summary: services.value.strategy
      ? `On since ${formatExactDateTime(services.value.strategy.since)} · ${paymentMoney(services.value.strategy.amount, services.value.strategy.currency)} per ${services.value.strategy.interval}, billed with your plan.`
      : `Julia leads your SEO strategy, hand-writes ranking blog posts, meets with you weekly and is on chat with you · ${paymentMoney(strategyOffer.amount, strategyOffer.currency)} per ${strategyOffer.interval}.`, action: { label: services.value.strategy ? 'Turn off' : onStarter.value ? 'Choose a plan' : 'Turn on' } }] : []),
  ],
}])

const salePlans = computed(() => plans.value.filter(plan => isNewSalePlan(plan.id)))

const organizationId = () => {
  const id = dashboard.organization.value?.id
  if (!id) throw new Error('Organization context is unavailable')
  return id
}

async function onRowAction(id: string) {
  if (busy.value) return
  errorMessage.value = ''
  if (id === 'service:managed_ads') { sheetError.value = ''; managedAdsOpen.value = true; return }
  if (id === 'service:strategy') { sheetError.value = ''; if (onStarter.value && !services.value?.strategy) { choosing.value = true; return } strategyOpen.value = true; return }
  if (id === 'plan') { sheetError.value = ''; choosing.value = true; return }
  if (id === 'locations') {
    if (onStarter.value) return
    sheetError.value = ''
    locationsQuantity.value = Math.max(locationsMinimum.value, billing.value?.locations.covered ?? INCLUDED_LOCATIONS)
    locationsOpen.value = true
    return
  }
  if (id.startsWith('credit:')) { creditId.value = id.slice('credit:'.length); creditNote.value = ''; sheetError.value = ''; return }
  busy.value = true
  try {
    if (id === 'cancel') await startOrganizationCheckout(organizationId(), STARTER_PLAN_ID)
    else if (id === 'restore') {
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

async function choosePlan(id: string) {
  if (busy.value || !id.startsWith('plan:')) return
  const plan = id.slice('plan:'.length)
  if (!isNewSalePlan(plan)) return
  busy.value = true
  sheetError.value = ''
  try {
    await startOrganizationCheckout(organizationId(), plan)
  } catch (error) {
    sheetError.value = getErrorMessage(error, 'The plan could not be changed')
  } finally {
    busy.value = false
  }
}

async function saveLocations() {
  if (busy.value || !locationsChanged.value) return
  busy.value = true
  sheetError.value = ''
  try {
    await setPlanLocations(organizationId(), locationsQuantity.value)
  } catch (error) {
    sheetError.value = getErrorMessage(error, 'Your plan’s locations could not be changed')
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
  // Stripe sends the plan back with success or canceled: that checkout is over. Only /api/post-login?plan=... arrives with the plan still to buy.
  if (success || canceled) return
  const planId = Array.isArray(plan) ? plan[0] : plan
  if (typeof planId === 'string' && planId && isNewSalePlan(planId) && !busy.value) await choosePlan(`plan:${planId}`)
})
</script>
