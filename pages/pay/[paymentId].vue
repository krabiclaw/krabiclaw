<template>
  <!--
    Paying for a booking on the site itself. Stripe's Payment Element collects
    the method; the business's server attaches it to the payment and says what
    the card will cost — with any surcharge Stripe permits for it — before the
    buyer confirms. Nothing is charged until Pay.
  -->
  <main class="platform-theme min-h-screen bg-default px-5 py-12 text-default">
    <div class="mx-auto max-w-xl space-y-6">
      <h1 class="text-2xl font-semibold text-highlighted">{{ t('payment.title') }}</h1>
      <USkeleton v-if="status === 'idle' || status === 'pending'" class="h-64 w-full" />
      <UAlert v-else-if="loadError" color="error" :title="t('payment.unavailable')" :description="loadError" />
      <template v-else-if="handoff">
        <UCard variant="subtle">
          <dl class="space-y-4">
            <div class="flex items-start justify-between gap-4">
              <dt class="font-semibold text-highlighted">{{ handoff.title }} <span v-if="handoff.quantity > 1" class="text-muted">× {{ handoff.quantity }}</span></dt>
              <dd class="shrink-0 text-muted">{{ paymentMoney(handoff.subtotal, handoff.currency) }}</dd>
            </div>
            <template v-if="review">
              <div v-if="review.surcharge > 0" class="flex items-start justify-between gap-4" data-payment-surcharge>
                <dt class="text-highlighted">{{ t('payment.surcharge') }}</dt>
                <dd class="shrink-0 text-muted">{{ paymentMoney(review.surcharge, review.currency) }}</dd>
              </div>
              <div class="flex items-start justify-between gap-4 border-t border-default pt-4">
                <dt class="font-semibold text-highlighted">{{ t('payment.total') }}</dt>
                <dd class="shrink-0 font-semibold text-highlighted" data-payment-total>{{ paymentMoney(review.total, review.currency) }}</dd>
              </div>
            </template>
          </dl>
        </UCard>

        <UAlert v-if="handoff.state === 'paid'" color="success" :title="t('payment.already_paid')" />
        <UAlert v-else-if="handoff.state !== 'open'" color="warning" :title="t('payment.expired')" :description="t('payment.expired_help')" />
        <template v-else>
          <!-- Stripe's form stays mounted; a reviewed method is shown read-only until the buyer changes it. -->
          <div v-show="!review" ref="mount" class="min-h-40" />
          <p v-if="review" class="text-sm text-muted" data-payment-method>
            {{ methodLabel }} ·
            <UButton variant="link" size="sm" :label="t('payment.change_method')" :disabled="working" @click="changeMethod" />
          </p>
          <p v-if="review && handoff.surcharge_basis_points !== null" class="text-sm text-muted">{{ review.surcharge > 0 ? t('payment.surcharge_applies') : t('payment.no_surcharge') }}</p>
          <UAlert v-if="actionError" color="error" :description="actionError" />
          <div class="flex justify-between gap-4">
            <UButton :label="t('payment.cancel')" color="neutral" variant="outline" :disabled="working" @click="leave" />
            <UButton v-if="!review" :label="t('payment.review')" :loading="working" :disabled="!ready" @click="reviewMethod" />
            <UButton v-else :label="t('payment.pay', { amount: paymentMoney(review.total, review.currency) })" :loading="working" @click="pay" />
          </div>
        </template>
      </template>
    </div>
  </main>
</template>

<script setup lang="ts">
import { loadStripe, type Stripe, type StripeElements, type StripePaymentElement } from '@stripe/stripe-js'
import { paymentMoney } from '~/shared/payment-display'
import { isRecord, publicApiMutation, publicApiRequest } from '~/utils/api-clients'
import type { paymentHandoff, reviewPayment, confirmPayment } from '~/server/domain/payments/intent'

definePageMeta({ layout: 'standalone' })
useResponseHeader('cache-control').value = 'private, no-store'
useHead({ meta: [{ name: 'referrer', content: 'no-referrer' }, { name: 'robots', content: 'noindex, nofollow' }] })
const { t } = useI18n()
const route = useRoute()
const paymentId = String(route.params.paymentId)
// The claim the checkout handed this browser, in the fragment: no server, log or referrer sees it.
const claim = computed(() => route.hash.slice(1))

type Handoff = Awaited<ReturnType<typeof paymentHandoff>>
type Review = Awaited<ReturnType<typeof reviewPayment>>
type Confirmation = Awaited<ReturnType<typeof confirmPayment>>
const isHandoff = (value: unknown): value is Handoff => isRecord(value) && value.payment_id === paymentId && typeof value.title === 'string' && Number.isSafeInteger(value.subtotal) && typeof value.currency === 'string' && typeof value.stripe_account_id === 'string' && typeof value.publishable_key === 'string' && Array.isArray(value.payment_method_types) && value.payment_method_types.every(type => typeof type === 'string') && ['open', 'paid', 'failed', 'expired'].includes(String(value.state))
const isReview = (value: unknown): value is Review => isRecord(value) && typeof value.payment_method_id === 'string' && Number.isSafeInteger(value.subtotal) && Number.isSafeInteger(value.surcharge) && value.total === (value.subtotal as number) + (value.surcharge as number) && isRecord(value.method)
const isConfirmation = (value: unknown): value is Confirmation => isRecord(value) && typeof value.status === 'string' && typeof value.requires_action === 'boolean' && typeof value.return_url === 'string'

const { data: handoff, status, error } = await useAsyncData(`payment-handoff:${paymentId}`, () => publicApiRequest<Handoff>(`/api/public/payments/${encodeURIComponent(paymentId)}`, { query: { claim: claim.value }, validate: isHandoff }), { server: false, immediate: Boolean(claim.value) })
const loadError = computed(() => !claim.value ? t('payment.unavailable') : error.value ? getErrorMessage(error.value, t('payment.unavailable')) : '')
useSocialMetadata(() => ({ path: route.path, title: t('payment.title'), description: t('payment.title'), socialImage: null, discoverability: 'private' }))

const mount = ref<HTMLElement | null>(null)
const ready = ref(false)
const working = ref(false)
const actionError = ref('')
const review = ref<Review | null>(null)
let stripe: Stripe | null = null
let elements: StripeElements | null = null
let paymentElement: StripePaymentElement | null = null

const methodLabel = computed(() => {
  const method = review.value?.method
  if (!method) return ''
  if (method.wallet) return method.wallet.replace('_', ' ')
  if (method.bank_name && method.last4) return `${method.bank_name} •••• ${method.last4}`
  return method.brand && method.last4 ? `${method.brand} •••• ${method.last4}` : method.type
})

// Stripe's Payment Element on the business's own account, in deferred mode: the
// method is created first so the server can price it before anything is confirmed.
watch(handoff, async (value) => {
  if (!value || value.state !== 'open' || import.meta.server) return
  if (value.review) review.value = null // A stored review is re-read only through its method; the buyer reviews again here.
  await nextTick()
  try {
    stripe = await loadStripe(value.publishable_key, { stripeAccount: value.stripe_account_id })
    if (!stripe || !mount.value) throw new Error('Stripe could not be loaded')
    elements = stripe.elements({
      mode: 'payment', amount: value.subtotal, currency: value.currency.toLowerCase(),
      paymentMethodTypes: value.payment_method_types,
      // The method is created here and attached by the server, which prices it before anything is confirmed.
      paymentMethodCreation: 'manual',
      ...(value.customer_session_client_secret ? { customerSessionClientSecret: value.customer_session_client_secret } : {}),
      appearance: { theme: document.documentElement.classList.contains('dark') ? 'night' : 'stripe' },
    })
    paymentElement = elements.create('payment', { layout: 'tabs' })
    paymentElement.on('ready', () => { ready.value = true })
    paymentElement.on('change', () => { if (review.value) review.value = null })
    paymentElement.mount(mount.value)
  } catch (cause) {
    actionError.value = getErrorMessage(cause, t('payment.unavailable'))
  }
}, { immediate: true })

async function reviewMethod() {
  if (working.value || !stripe || !elements) return
  working.value = true
  actionError.value = ''
  try {
    const submitted = await elements.submit()
    if (submitted.error) throw new Error(submitted.error.message ?? t('payment.unavailable'))
    const created = await stripe.createPaymentMethod({ elements })
    if (created.error || !created.paymentMethod) throw new Error(created.error?.message ?? t('payment.unavailable'))
    review.value = await publicApiMutation<Review>(`/api/public/payments/${encodeURIComponent(paymentId)}/review`, { method: 'POST', body: { claim: claim.value, payment_method_id: created.paymentMethod.id }, validate: isReview })
    if (elements && review.value.total !== review.value.subtotal) elements.update({ amount: review.value.total })
  } catch (cause) {
    actionError.value = getErrorMessage(cause, t('payment.unavailable'))
  } finally {
    working.value = false
  }
}

function changeMethod() {
  review.value = null
  if (elements && handoff.value) elements.update({ amount: handoff.value.subtotal })
}

async function pay() {
  if (working.value || !stripe || !review.value) return
  working.value = true
  actionError.value = ''
  try {
    const confirmed = await publicApiMutation<Confirmation>(`/api/public/payments/${encodeURIComponent(paymentId)}/confirm`, { method: 'POST', body: { claim: claim.value, payment_method_id: review.value.payment_method_id, total: review.value.total }, validate: isConfirmation })
    if (confirmed.requires_action) {
      if (!confirmed.client_secret) throw new Error(t('payment.unavailable'))
      const next = await stripe.handleNextAction({ clientSecret: confirmed.client_secret })
      if (next.error) throw new Error(next.error.message ?? t('payment.declined'))
      if (next.paymentIntent?.status !== 'succeeded' && next.paymentIntent?.status !== 'processing') throw new Error(t('payment.declined'))
    } else if (confirmed.status !== 'succeeded' && confirmed.status !== 'processing') {
      throw new Error(t('payment.declined'))
    }
    await navigateTo(confirmed.return_url, { external: true })
  } catch (cause) {
    actionError.value = getErrorMessage(cause, t('payment.declined'))
    // A decline leaves the intent waiting for another method; the review it was for is over.
    review.value = null
    if (elements && handoff.value) elements.update({ amount: handoff.value.subtotal })
  } finally {
    working.value = false
  }
}

async function leave() {
  await navigateTo('/')
}
</script>
