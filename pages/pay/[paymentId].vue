<template>
  <!--
    Paying for a booking on the site itself. Stripe's Payment Element collects
    the method; the business's server attaches it to the payment and says what
    the card will cost — with any surcharge Stripe permits for it — before the
    buyer confirms. Nothing is charged until Pay.
  -->
  <main class="platform-theme min-h-screen bg-default px-5 py-10 lg:py-14 text-default">
    <div class="mx-auto max-w-6xl">
      <!-- Back button and Page Title -->
      <div class="mb-8 flex items-center gap-4">
        <button
          type="button"
          class="flex size-10 items-center justify-center rounded-full border border-default hover:bg-muted transition text-default"
          :aria-label="t('payment.cancel')"
          @click="leave"
        >
          <PlatformIcon name="arrow-left" class="size-4" />
        </button>
        <h1 class="text-2xl sm:text-3xl font-bold tracking-tight text-highlighted">{{ t('payment.title') }}</h1>
      </div>

      <USkeleton v-if="status === 'idle' || status === 'pending'" class="h-64 w-full rounded-2xl" />
      <UAlert v-else-if="loadError" color="error" :title="t('payment.unavailable')" :description="loadError" />
      <div v-else-if="handoff" class="grid gap-10 lg:grid-cols-[1fr_400px] xl:grid-cols-[1fr_440px] items-start">
        <!-- Left Column: Reservation / Appointment Details, Payment, and Agreement -->
        <div class="space-y-8 min-w-0">
          <!-- Reservation / Appointment details -->
          <section class="space-y-4">
            <h2 class="text-xl font-semibold text-highlighted">
              {{ handoff.stay ? 'Your trip' : 'Your appointment' }}
            </h2>

            <div v-if="handoff.stay" class="space-y-4" data-payment-stay>
              <div class="flex justify-between items-baseline">
                <div>
                  <h3 class="font-medium text-sm text-highlighted">Dates</h3>
                  <p class="text-sm text-muted mt-0.5">
                    {{ formatCalendarDate(handoff.stay.check_in_date, locale, { month: 'short', day: 'numeric' }) }} – {{ formatCalendarDate(handoff.stay.check_out_date, locale, { month: 'short', day: 'numeric', year: 'numeric' }) }}
                  </p>
                </div>
              </div>
              <div class="flex justify-between items-baseline">
                <div>
                  <h3 class="font-medium text-sm text-highlighted">Guests</h3>
                  <p class="text-sm text-muted mt-0.5">
                    {{ handoff.stay.adults + handoff.stay.children }} {{ (handoff.stay.adults + handoff.stay.children) === 1 ? 'guest' : 'guests' }}
                  </p>
                </div>
              </div>
            </div>

            <div v-else class="space-y-4">
              <div class="flex justify-between items-baseline">
                <div>
                  <h3 class="font-medium text-sm text-highlighted">{{ handoff.title }}</h3>
                  <p class="text-sm text-muted mt-0.5">
                    {{ handoff.quantity > 1 ? `Quantity: ${handoff.quantity}` : 'Confirmed booking' }}
                  </p>
                </div>
              </div>
            </div>
          </section>

          <hr class="border-default" />

          <!-- Payment Section -->
          <section class="space-y-4">
            <div class="flex items-center justify-between">
              <h2 class="text-xl font-semibold text-highlighted">Pay with</h2>
              <span class="inline-flex items-center gap-1.5 text-xs text-muted">
                <PlatformIcon name="shield-check" class="size-4 text-emerald-500" />
                Guaranteed secure
              </span>
            </div>

            <UAlert v-if="handoff.state === 'paid'" color="success" :title="t('payment.already_paid')" />
            <UAlert v-else-if="handoff.state !== 'open'" color="warning" :title="t('payment.expired')" :description="t('payment.expired_help')" />
            <div v-else class="space-y-4">
              <!-- Stripe's form stays mounted; a reviewed method is shown read-only until the buyer changes it. -->
              <div v-show="!review" ref="mount" class="min-h-40 rounded-xl border border-default p-4 bg-elevated" />

              <div v-if="review" class="rounded-xl border border-default bg-elevated p-4 flex items-center justify-between">
                <div class="space-y-1" data-payment-method>
                  <p class="font-medium text-sm text-highlighted">{{ methodLabel }}</p>
                  <p v-if="handoff.surcharge_basis_points !== null" class="text-xs text-muted">
                    {{ review.surcharge > 0 ? t('payment.surcharge_applies') : t('payment.no_surcharge') }}
                  </p>
                </div>
                <UButton variant="outline" size="sm" :label="t('payment.change_method')" :disabled="working" @click="changeMethod" />
              </div>

              <UAlert v-if="actionError" color="error" :description="actionError" />
            </div>
          </section>

          <hr class="border-default" />

          <!-- Ground rules / Notes -->
          <section class="space-y-3">
            <h2 class="text-xl font-semibold text-highlighted">
              {{ handoff.stay ? 'Ground rules' : 'Before your session' }}
            </h2>
            <p v-if="handoff.stay" class="text-sm text-muted leading-relaxed">
              We ask every guest to remember a few simple things about what makes a great guest:
              Follow the house rules, treat your Host's home like your own, and communicate with your host if issues arise.
            </p>
            <p v-else class="text-sm text-muted leading-relaxed">
              Please ensure your contact information is accurate and prepare any questions or documents for your appointment.
            </p>
          </section>

          <hr class="border-default" />

          <!-- Policies and Primary Confirm CTA -->
          <section class="space-y-4 pt-2">
            <p class="text-xs text-muted leading-relaxed">
              By selecting the button below, I agree to the Host's House Rules, Ground Rules for guests, and that KrabiClaw can charge my payment method for the amount stated.
            </p>

            <div v-if="handoff.state === 'open'" class="pt-2">
              <UButton
                v-if="!review"
                size="xl"
                block
                :label="t('payment.review')"
                :loading="working"
                :disabled="!ready"
                class="font-semibold py-3.5 text-base"
                @click="reviewMethod"
              />
              <UButton
                v-else
                size="xl"
                block
                :label="t('payment.pay', { amount: paymentMoney(review.total, review.currency) })"
                :loading="working"
                class="font-semibold py-3.5 text-base"
                @click="pay"
              />
            </div>
            <div class="text-center">
              <button type="button" class="text-xs text-muted hover:text-highlighted underline" :disabled="working" @click="leave">
                {{ t('payment.cancel') }}
              </button>
            </div>
          </section>
        </div>

        <!-- Right Column: Sticky Reservation Summary Card -->
        <div class="lg:sticky lg:top-8 min-w-0">
          <div class="rounded-2xl border border-default bg-elevated p-6 shadow-sm space-y-5">
            <!-- Property / Service Header -->
            <div class="flex gap-4 items-center">
              <div class="size-20 shrink-0 rounded-xl bg-muted border border-default flex items-center justify-center overflow-hidden">
                <SayaIcon v-if="handoff.stay" name="home" class="size-8 text-dimmed" />
                <PlatformIcon v-else name="calendar" class="size-8 text-dimmed" />
              </div>
              <div class="min-w-0 flex-1">
                <p class="text-xs text-muted font-medium uppercase tracking-wider">{{ handoff.stay ? 'Place to stay' : 'Appointment' }}</p>
                <h3 class="font-semibold text-highlighted text-base truncate mt-0.5">{{ handoff.title }}</h3>
                <p v-if="handoff.quantity > 1" class="text-xs text-muted mt-0.5">Quantity: {{ handoff.quantity }}</p>
              </div>
            </div>

            <hr class="border-default" />

            <!-- Price Details -->
            <div class="space-y-3">
              <h4 class="font-semibold text-sm text-highlighted">Price details</h4>
              <dl class="space-y-2 text-sm">
                <div class="flex justify-between items-baseline">
                  <dt class="text-muted">
                    {{ handoff.stay ? `${handoff.stay.nights} nights` : handoff.title }}
                  </dt>
                  <dd class="tabular-nums text-highlighted font-medium">
                    {{ paymentMoney(handoff.subtotal, handoff.currency) }}
                  </dd>
                </div>
                <div v-if="review && review.surcharge > 0" class="flex justify-between items-baseline" data-payment-surcharge>
                  <dt class="text-muted">{{ t('payment.surcharge') }}</dt>
                  <dd class="tabular-nums text-highlighted font-medium">{{ paymentMoney(review.surcharge, review.currency) }}</dd>
                </div>
              </dl>
            </div>

            <hr class="border-default" />

            <!-- Total -->
            <div class="flex justify-between items-baseline">
              <span class="font-semibold text-base text-highlighted">{{ t('payment.total') }} ({{ handoff.currency }})</span>
              <span class="font-bold text-lg text-highlighted tabular-nums" data-payment-total>
                {{ paymentMoney(review ? review.total : handoff.subtotal, handoff.currency) }}
              </span>
            </div>
            <p class="text-xs text-muted">Charged in full at confirmation.</p>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { loadStripe, type Stripe, type StripeElements, type StripePaymentElement } from '@stripe/stripe-js'
import { paymentMoney } from '~/shared/payment-display'
import { formatCalendarDate } from '~/utils/timezone'
import { isRecord, publicApiMutation, publicApiRequest } from '~/utils/api-clients'
import type { paymentHandoff, reviewPayment, confirmPayment } from '~/server/domain/payments/intent'

definePageMeta({ layout: 'standalone' })
useResponseHeader('cache-control').value = 'private, no-store'
useHead({ meta: [{ name: 'referrer', content: 'no-referrer' }, { name: 'robots', content: 'noindex, nofollow' }] })
const { t, locale } = useI18n()
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
