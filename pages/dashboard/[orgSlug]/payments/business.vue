<template>
  <!-- Business bills locations and rental units on one subscription. The business sets both, reads Stripe's own invoice for the change, and confirms it. -->
  <DashboardLeafPanel id="organization-business-plan" :title="switching ? 'Switch to Business' : 'Business plan'" :lead="lead" :saving="busy" :disabled="!changeable || !valid" :error="error" :save-label="saveLabel" @save="save">
    <UAlert v-if="success" class="mb-6" color="success" variant="soft" icon="i-lucide-circle-check" :description="success" />
    <div v-if="changeable && billing" class="grid gap-6">
      <UButton v-if="earlierPrice && !acceptOffer" label="Move to the current Business offer" color="neutral" variant="outline" :disabled="busy" @click="acceptCurrentOffer" />
      <UFormField label="Locations" :help="locationsHelp">
        <UInputNumber v-model="locations" :min="minimumLocations" :disabled="busy" class="w-full" />
      </UFormField>
      <UFormField v-if="billsUnits" label="Rental units" :help="unitsHelp">
        <UInputNumber v-model="rentalUnits" :min="minimumUnits" :disabled="busy" class="w-full" />
      </UFormField>
      <div v-if="preview" data-plan-change-preview class="grid gap-3 text-base">
        <p class="font-semibold text-highlighted">Stripe’s invoice for this change</p>
        <ul class="grid gap-2">
          <li v-for="(line, index) in preview.lines" :key="index" class="flex justify-between gap-4">
            <span class="text-muted">{{ line.description }}</span>
            <span class="tabular-nums">{{ paymentMoney(line.amount, preview.currency) }}</span>
          </li>
        </ul>
        <p class="flex justify-between gap-4"><span>{{ preview.total < 0 ? 'Credited to your balance' : 'Charged to your card now' }}</span><strong class="tabular-nums">{{ paymentMoney(preview.total < 0 ? -preview.total : preview.amountDue, preview.currency) }}</strong></p>
        <p class="flex justify-between gap-4"><span>Then every month</span><strong data-plan-change-recurring class="tabular-nums">{{ paymentMoney(preview.recurring, preview.currency) }}</strong></p>
      </div>
    </div>
    <p v-else class="text-base text-muted">Your plan changes once it is active with no change or cancellation scheduled.</p>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { additionalLocationPrice, additionalRentalUnitPrice, BUSINESS_PLAN_ID, INCLUDED_LOCATIONS, INCLUDED_RENTAL_UNITS, PAID_PLAN_PRICES } from '~/shared/billing-model'
import { paymentMoney } from '~/shared/payment-display'
import { useOrganizationBilling } from '~/composables/usePaymentsSettings'
import { recordBillingAnalyticsIntent } from '~/composables/useBillingAnalytics'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Business plan | KrabiClaw', robots: 'noindex, nofollow' })

type Preview = { locations: number; rentalUnits: number | null; currency: 'USD'; recurring: number; total: number; amountDue: number; lines: Array<{ description: string; amount: number }>; prorationDate: number }
const isPreview = (value: unknown): value is { success: true; preview: Preview } => isRecord(value) && value.success === true && isRecord(value.preview)
  && Number.isSafeInteger(value.preview.locations) && (value.preview.rentalUnits === null || Number.isSafeInteger(value.preview.rentalUnits))
  && value.preview.currency === 'USD' && Number.isSafeInteger(value.preview.recurring) && Number.isSafeInteger(value.preview.total) && Number.isSafeInteger(value.preview.amountDue)
  && Number.isSafeInteger(value.preview.prorationDate) && Array.isArray(value.preview.lines)
  && value.preview.lines.every(line => isRecord(line) && typeof line.description === 'string' && Number.isSafeInteger(line.amount))
const isConfirmed = (value: unknown): value is { success: true; plan: { locations: number; rentalUnits: number | null } } => isRecord(value) && value.success === true && isRecord(value.plan) && Number.isSafeInteger(value.plan.locations)

const dashboard = useDashboardOrganization()
const dashboardApi = useDashboardApi()
const { trackSubscriptionUpgrade, getBillingAnalyticsContext } = useAnalytics()
const { billing, refreshBilling } = await useOrganizationBilling()

// Moving another plan to Business lands on the current offer; a Business subscription on an earlier price keeps it.
const switching = computed(() => !!billing.value && billing.value.plan !== BUSINESS_PLAN_ID)
// A Business subscription on an earlier price keeps it until the business accepts the current offer here.
const earlierPrice = computed(() => billing.value?.plan === BUSINESS_PLAN_ID && !billing.value.billsRentalUnits)
const acceptOffer = ref(false)
const billsUnits = computed(() => switching.value || acceptOffer.value || !!billing.value?.billsRentalUnits)
const changeable = computed(() => !!billing.value?.stripeSubscriptionId && billing.value.subscriptionStatus === 'active' && !billing.value.scheduledPlan && !billing.value.cancelAtPeriodEnd)
// What is in use is the least the plan can cover; a business pays for no fewer than are on its site.
const usedLocations = computed(() => billsUnits.value ? billing.value?.businessUsage.locations ?? 0 : billing.value?.locations.used ?? 0)
const minimumLocations = computed(() => Math.max(INCLUDED_LOCATIONS, usedLocations.value))
const minimumUnits = computed(() => Math.max(INCLUDED_RENTAL_UNITS, billing.value?.businessUsage.rentalUnits ?? 0))
const locations = ref(Math.max(minimumLocations.value, switching.value ? 0 : billing.value?.locations.covered ?? 0))
const rentalUnits = ref(Math.max(minimumUnits.value, billing.value?.rentalUnits?.covered ?? 0))
const valid = computed(() => locations.value >= minimumLocations.value && (!billsUnits.value || rentalUnits.value >= minimumUnits.value))

const lead = computed(() => !billsUnits.value
  ? 'Your existing Business price continues and covers every location, including those with homes. Stripe shows what changes on your bill before you confirm.'
  : `Business is ${paymentMoney(PAID_PLAN_PRICES[BUSINESS_PLAN_ID].monthly, 'USD')} per month: ${INCLUDED_LOCATIONS} locations and ${INCLUDED_RENTAL_UNITS} rental units included, then ${additionalLocationPrice()} and ${additionalRentalUnitPrice()}. A location with only rental units is billed by its units. Stripe shows what changes on your bill before you confirm.`)
const locationsHelp = computed(() => billsUnits.value
  ? `${usedLocations.value} in use, not counting locations with only rental units.`
  : `${usedLocations.value} in use.`)
const unitsHelp = computed(() => `${billing.value?.businessUsage.rentalUnits ?? 0} in use: each home on sale or connected to a channel.`)

function acceptCurrentOffer() {
  acceptOffer.value = true
  locations.value = minimumLocations.value
  rentalUnits.value = minimumUnits.value
}

const preview = ref<Preview | null>(null)
// A change to the numbers is a different invoice; the preview no longer describes it.
watch([locations, rentalUnits, acceptOffer], () => { preview.value = null })
const saveLabel = computed(() => preview.value
  ? preview.value.total < 0 ? 'Confirm change' : `Confirm and pay ${paymentMoney(preview.value.amountDue, preview.value.currency)}`
  : 'Review change')
const busy = ref(false)
const error = ref('')
const success = ref('')
// One attempt per previewed invoice: a retried confirmation of it deduplicates at Stripe, and a new preview is a new attempt.
let attempt = crypto.randomUUID()

async function save() {
  if (busy.value || !changeable.value || !valid.value) return
  busy.value = true
  error.value = ''
  success.value = ''
  const change = { locations: locations.value, rentalUnits: billsUnits.value ? rentalUnits.value : null, ...(acceptOffer.value ? { offer: 'current' } : {}) }
  try {
    if (!preview.value) {
      preview.value = (await dashboardApi('/api/dashboard/plan-change', { method: 'POST', body: { action: 'preview', ...change }, validate: isPreview })).preview
      attempt = crypto.randomUUID()
      return
    }
    const organizationId = dashboard.organization.value?.id
    if (!organizationId) throw new Error('Organization context is unavailable')
    if (switching.value) await recordBillingAnalyticsIntent(dashboardApi, { organizationId, subscriptionId: billing.value?.stripeSubscriptionId ?? null, action: 'upgrade', ...getBillingAnalyticsContext() })
    await dashboardApi('/api/dashboard/plan-change', { method: 'POST', body: { action: 'confirm', ...change, prorationDate: preview.value.prorationDate, attempt }, validate: isConfirmed })
    if (switching.value) trackSubscriptionUpgrade(BUSINESS_PLAN_ID, organizationId)
    preview.value = null
    await refreshBilling()
    success.value = 'Stripe confirmed the change. Your plan has been updated.'
  } catch (cause) {
    // Stripe keeps a declined confirmation under its attempt; after fixing the card the business reviews a fresh invoice.
    preview.value = null
    error.value = getErrorMessage(cause, 'Your plan could not be changed')
  } finally {
    busy.value = false
  }
}
</script>
