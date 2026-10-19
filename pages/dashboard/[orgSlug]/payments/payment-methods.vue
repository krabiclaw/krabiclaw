<template>
  <!-- Airbnb's "Payment methods": the cards on the Stripe customer Better Auth keeps for the business, each with Set default / Remove, and Add payment method opening Stripe's own card form in a sheet. -->
  <DashboardLeafPanel id="organization-payment-methods" title="Payment methods" lead="Add and manage your payment methods using our secure payment system. This card pays your KrabiClaw bills." :footer="false">
    <UAlert v-if="methodsError" color="error" variant="soft" :description="getErrorMessage(methodsError, 'Payment methods could not be loaded')" />
    <template v-else-if="methods">
      <div v-if="methods.payment_methods.length" class="divide-y divide-default border-y border-default">
        <div v-for="method in methods.payment_methods" :key="method.id" class="flex items-center gap-4 py-5" :data-testid="`payment-method-${method.id}`">
          <span class="flex h-9 w-14 shrink-0 items-center justify-center rounded-md bg-elevated text-xs font-semibold uppercase text-highlighted ring ring-default">{{ cardBrandLabel(method.brand) }}</span>
          <span class="min-w-0 flex-1">
            <span class="block text-base font-medium text-highlighted">{{ cardBrandLabel(method.brand) }} {{ method.last4 }}<UBadge v-if="method.default" label="Default" color="neutral" variant="soft" class="ml-2" /></span>
            <span class="block text-sm text-muted">Expiration: {{ String(method.exp_month).padStart(2, '0') }}/{{ method.exp_year }}</span>
          </span>
          <UDropdownMenu :items="methodItems(method)" :content="{ align: 'end' }">
            <UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" square :aria-label="`Options for ${cardBrandLabel(method.brand)} ${method.last4}`" />
          </UDropdownMenu>
        </div>
      </div>
      <p v-else class="text-base text-muted">No payment methods saved yet.</p>
      <UButton class="mt-6" size="lg" label="Add payment method" :loading="opening" @click="openCardForm" />
    </template>
    <UAlert v-if="failure" class="mt-4" color="error" variant="soft" :description="failure" />

    <!-- Airbnb's "Add card details": Stripe's card form, Cancel and Done. -->
    <DashboardListItemDialog v-model:open="adding" title="Add card details" :saving="saving" :save-disabled="!ready" :error="formError" save-label="Done" @save="confirmCard">
      <div ref="mount" class="min-h-40" />
    </DashboardListItemDialog>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { loadStripe, type Stripe, type StripeElements, type StripePaymentElement } from '@stripe/stripe-js'
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import type { PaymentMethodRow } from '~/server/utils/billing-customer'
import { cardBrandLabel, usePaymentMethods } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Payment methods | KrabiClaw', robots: 'noindex, nofollow' })

const dashboard = useDashboardOrganization()
const config = useRuntimeConfig()
const { methods, methodsError, refreshMethods } = await usePaymentMethods()
const scope = computed(() => {
  const organizationId = dashboard.organization.value?.id
  if (!organizationId) throw new Error('Organization context is unavailable')
  return { organizationId }
})
const failure = ref('')
const methodItems = (method: PaymentMethodRow) => [[
  ...(method.default ? [] : [{ label: 'Set default', icon: 'i-lucide-check', onSelect: () => void act('set_default', method.id) }]),
  { label: 'Remove', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => void act('remove', method.id) },
]]
async function act(action: 'set_default' | 'remove', paymentMethodId: string) {
  failure.value = ''
  try {
    await applicationFetch('/api/billing/payment-methods', {
      method: action === 'remove' ? 'DELETE' : 'POST',
      body: { ...scope.value, ...(action === 'remove' ? {} : { action }), payment_method_id: paymentMethodId },
      validate: (value: unknown): value is Record<string, unknown> => isRecord(value),
    })
    await refreshMethods()
  } catch (cause) {
    failure.value = getErrorMessage(cause, action === 'remove' ? 'The payment method could not be removed' : 'The default could not be changed')
  }
}

// Stripe's form lives in the sheet: a SetupIntent from the server, Elements mounted when the sheet opens, confirmed on Done.
const adding = ref(false)
const opening = ref(false)
const saving = ref(false)
const ready = ref(false)
const formError = ref('')
const mount = ref<HTMLElement | null>(null)
let stripe: Stripe | null = null
let elements: StripeElements | null = null
let paymentElement: StripePaymentElement | null = null
async function openCardForm() {
  if (opening.value) return
  opening.value = true
  failure.value = ''
  formError.value = ''
  ready.value = false
  try {
    const key = String(config.public.stripePublishableKey ?? '')
    if (!key) throw new Error('Card entry is not configured')
    const [loaded, setup] = await Promise.all([
      stripe ? Promise.resolve(stripe) : loadStripe(key),
      applicationFetch<{ client_secret: string }>('/api/billing/payment-methods', { method: 'POST', body: { ...scope.value, action: 'setup' }, validate: (value: unknown): value is { client_secret: string } => isRecord(value) && typeof value.client_secret === 'string' }),
    ])
    if (!loaded) throw new Error('Stripe could not be loaded')
    stripe = loaded
    adding.value = true
    await nextTick()
    if (!mount.value) throw new Error('The card form has nowhere to mount')
    elements = stripe.elements({ clientSecret: setup.client_secret, appearance: { theme: document.documentElement.classList.contains('dark') ? 'night' : 'stripe' } })
    paymentElement = elements.create('payment', { layout: 'tabs' })
    paymentElement.on('ready', () => { ready.value = true })
    paymentElement.mount(mount.value)
  } catch (cause) {
    adding.value = false
    failure.value = getErrorMessage(cause, 'The card form could not be opened')
  } finally {
    opening.value = false
  }
}
async function confirmCard() {
  if (!stripe || !elements || saving.value) return
  saving.value = true
  formError.value = ''
  try {
    const result = await stripe.confirmSetup({ elements, redirect: 'if_required', confirmParams: { return_url: window.location.href } })
    if (result.error) throw new Error(result.error.message ?? 'The card was not saved')
    adding.value = false
    await refreshMethods()
  } catch (cause) {
    formError.value = getErrorMessage(cause, 'The card was not saved')
  } finally {
    saving.value = false
  }
}
watch(adding, (open) => { if (!open) { paymentElement?.destroy(); paymentElement = null; elements = null; ready.value = false } })
</script>
