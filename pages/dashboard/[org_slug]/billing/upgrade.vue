<template>
  <DashboardLeafPanel
    id="organization-upgrade"
    :back-to="servicePath"
    :title="title"
    :footer="dashboard.canUpdateBilling.value"
    :saving="busy"
    :error="error || (billingError ? getErrorMessage(billingError, 'The plan could not be loaded') : '')"
    :disabled="!billing || (onStarter && !chosen)"
    :save-label="onStarter ? 'Continue to Stripe' : 'Agree and upgrade to Business'"
    @save="upgrade"
  >
    <p v-if="!dashboard.canUpdateBilling.value" class="mb-6 text-base text-muted">Owners change the plan.</p>
    <template v-if="onStarter && service !== 'managed-ads'">
      <URadioGroup
        v-model="chosen"
        aria-label="Plans"
        :items="choices"
        variant="card"
        indicator="start"
        color="neutral"
        :ui="{
          fieldset: 'gap-4',
          item: 'min-w-0 items-start rounded-3xl bg-elevated p-5 sm:p-6',
          wrapper: 'min-w-0 flex-1',
          label: 'w-full',
        }"
        :disabled="!dashboard.canUpdateBilling.value"
      >
        <template #label="{ item }">
          <span class="flex items-baseline justify-between gap-2">
            <span class="text-lg font-semibold tracking-tight text-highlighted sm:text-xl">{{ item.label }}</span>
            <span class="shrink-0 text-base font-semibold text-highlighted">{{ item.price }}</span>
          </span>
          <span class="mt-3 flex min-h-20 items-center justify-between gap-2">
            <span class="flex min-w-0 flex-col gap-1.5 text-sm font-normal text-toned">
              <span v-for="feature in item.features" :key="feature" class="flex items-start gap-2">
                <UIcon name="i-lucide-check" class="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                <span>{{ feature }}</span>
              </span>
            </span>
            <img :src="item.illustration" alt="" class="size-12 shrink-0 object-contain sm:size-24" />
          </span>
        </template>
      </URadioGroup>
      <p class="mt-5 text-sm text-muted">Stripe shows the total before you pay.</p>
    </template>
    <template v-else-if="billing">
      <UCard variant="record" class="mb-4 rounded-3xl">
        <div class="flex items-center justify-between gap-4">
          <h2 class="text-2xl font-semibold text-highlighted">{{ planName(BUSINESS_PLAN_ID) }}</h2>
          <span class="shrink-0 text-base font-semibold text-highlighted">{{ formatRecurring(PAID_PLAN_PRICES[BUSINESS_PLAN_ID].monthly, 'USD') }}</span>
        </div>
      </UCard>
      <EditorNavigationList :groups="[{ id: 'changes', items: changes }]" />
      <p class="mt-5 border-t border-default pt-4 text-sm text-muted">{{ onStarter ? 'Stripe shows the total before you pay.' : 'This upgrade applies immediately. Stripe calculates any prorated charge for the rest of your billing period.' }}</p>
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'
import { BUSINESS_PLAN_ID, GROWTH_PLAN_ID, BUSINESS_ADDITIONS, PAID_PLAN_PRICES, STARTER_PLAN_ID, type NewSalePlanId } from '~/shared/billing-model'
import { OFFERS, offer } from '~/shared/offers'
import { useOrganizationBilling } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard' })

const dashboard = useDashboardOrganization()
const { startOrganizationCheckout } = useOrganizationSubscription()
const { plans, formatRecurring } = await usePlans()
const { billing, billingError } = await useOrganizationBilling()
const route = useRoute()
const service = computed(() => route.query.service === 'managed-ads' || route.query.service === 'strategy' ? route.query.service : undefined)
const servicePath = computed(() => service.value ? `/dashboard/${encodeURIComponent(String(route.params.org_slug))}/billing/${service.value}` : undefined)
const onStarter = computed(() => billing.value?.plan === STARTER_PLAN_ID && !billing.value.stripeSubscriptionId)
const title = computed(() => onStarter.value && service.value !== 'managed-ads' ? 'Choose a plan' : 'Upgrade to Business')
useSeoMeta({ title: () => `${title.value} | KrabiClaw`, robots: 'noindex, nofollow' })

// Business has nothing above it, and a plan already changing has no second change to start.
watchEffect(() => {
  const status = billing.value
  if (status && (!status.actions.changes.some(change => change.timing === 'immediate'))) showError({ statusCode: 404, statusMessage: 'There is no upgrade for this plan' })
})

// Each addition leads with its offer's illustration, the same picture Menu and Today offered it with.
const changes: EditorNavigationItem[] = BUSINESS_ADDITIONS.map(row => {
  const illustration = OFFERS.find(item => item.id === row.id.replace('-', '_'))?.illustration
  return { ...row, ...(illustration ? { lead: { image: illustration, imageFit: 'contain' as const } } : {}) }
})

const planName = (id: string) => plans.value.find(plan => plan.id === id)?.name ?? id
const choices = computed(() => ([GROWTH_PLAN_ID, BUSINESS_PLAN_ID] as const).map(id => ({
  value: id,
  label: planName(id),
  price: formatRecurring(PAID_PLAN_PRICES[id].monthly, 'USD'),
  illustration: `/images/offers/${id}-plan.webp`,
  features: id === GROWTH_PLAN_ID
    ? [offer('custom_domain').name, 'Social publishing', 'WhatsApp booking alerts']
    : [`Everything in ${planName(GROWTH_PLAN_ID)}`, ...BUSINESS_ADDITIONS.map(feature => feature.id === 'payments' ? 'Payments and direct stays' : feature.label)],
})))
// The plan an offer named starts chosen; otherwise the one the catalog recommends, so Continue is live.
const offered = choices.value.find(choice => choice.value === route.query.plan)?.value
const chosen = ref<NewSalePlanId>(offered ?? choices.value.find(choice => plans.value.find(plan => plan.id === choice.value)?.highlighted)?.value ?? GROWTH_PLAN_ID)

const busy = ref(false)
const error = ref('')
async function upgrade() {
  if (busy.value) return
  const plan = onStarter.value && service.value !== 'managed-ads' ? chosen.value : BUSINESS_PLAN_ID
  if (!plan) return
  const organizationId = dashboard.organization.value?.id
  if (!organizationId) throw new Error('Organization context is unavailable')
  busy.value = true
  error.value = ''
  try {
    await startOrganizationCheckout(organizationId, plan, service.value)
  } catch (cause) {
    error.value = getErrorMessage(cause, 'The plan could not be changed')
  } finally {
    busy.value = false
  }
}
</script>
