<template>
  <!--
    Paying for a booking on the site itself. Stripe's Payment Element collects
    the method; the business's server attaches it to the payment and says what
    the card will cost — with any surcharge Stripe permits for it — before the
    buyer confirms. Nothing is charged until Pay.
  -->
  <!-- White, as Airbnb's checkout is: Stripe's fields are white and sit on the page, not in a panel. -->
  <main class="platform-theme min-h-screen bg-white px-5 py-10 lg:py-14 text-default dark:bg-default">
    <div class="mx-auto max-w-5xl">
      <div class="mb-8 flex items-center gap-4 lg:-ml-14">
        <button
          type="button"
          class="flex size-10 items-center justify-center rounded-full hover:bg-muted transition text-default"
          :aria-label="t('payment.cancel')"
          @click="leave"
        >
          <PlatformIcon name="arrow-left" class="size-4" />
        </button>
        <h1 class="text-2xl sm:text-[32px] font-semibold tracking-tight text-highlighted">{{ t('payment.title') }}</h1>
      </div>

      <USkeleton v-if="status === 'pending' || (status === 'idle' && !(mounted && !claim))" class="h-64 w-full rounded-2xl" />
      <UAlert v-else-if="loadError" color="error" :title="t('payment.unavailable')" :description="loadError" />
      <!-- Airbnb's Confirm and pay: the method and the one button on the left, what is being bought on the right. -->
      <div v-else-if="handoff" class="grid gap-8 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-16 items-start">
        <aside class="lg:sticky lg:top-8 lg:order-2 min-w-0 rounded-2xl border border-default bg-white p-6 space-y-5 dark:bg-default" data-payment-summary>
          <div class="flex gap-4 items-center">
            <img v-if="handoff.image_url" :src="handoff.image_url" alt="" class="size-24 shrink-0 rounded-xl object-cover">
            <h2 class="min-w-0 text-lg font-semibold leading-snug text-highlighted">{{ handoff.title }}</h2>
          </div>
          <p v-if="policySummary" class="text-sm text-default">
            <span class="line-clamp-3">{{ policySummary }}</span>
            <NuxtLink v-if="termsPath" :to="termsPath" class="font-semibold underline">{{ t('payment.full_policy') }}</NuxtLink>
          </p>

          <!-- Airbnb's Change goes back to what was picked; here that is the offering's own page. -->
          <div v-if="handoff.stay" class="flex items-start justify-between gap-4 border-t border-default pt-5" data-payment-stay>
            <div>
              <h3 class="text-sm font-semibold text-highlighted">{{ t('payment.dates') }}</h3>
              <p class="mt-1 text-sm text-default">{{ stayRange }}</p>
            </div>
            <UButton v-if="offeringPath" :to="offeringPath" color="neutral" variant="soft" size="sm" :label="t('payment.change')" />
          </div>
          <div v-else-if="handoff.starts_at && handoff.ends_at && handoff.timezone" class="flex items-start justify-between gap-4 border-t border-default pt-5" data-payment-time>
            <div>
              <h3 class="text-sm font-semibold text-highlighted">{{ t('payment.date') }}</h3>
              <p class="mt-1 text-sm text-default">{{ formatTimestamp(handoff.starts_at, locale, handoff.timezone, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }) }}</p>
              <p class="text-sm text-default">{{ formatTimestamp(handoff.starts_at, locale, handoff.timezone, { hour: 'numeric', minute: '2-digit' }) }} – {{ formatTimestamp(handoff.ends_at, locale, handoff.timezone, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) }}</p>
            </div>
            <UButton v-if="offeringPath" :to="offeringPath" color="neutral" variant="soft" size="sm" :label="t('payment.change')" />
          </div>
          <div v-if="guests" class="flex items-start justify-between gap-4 border-t border-default pt-5">
            <div>
              <h3 class="text-sm font-semibold text-highlighted">{{ t('payment.guests') }}</h3>
              <p class="mt-1 text-sm text-default">{{ guests }}</p>
            </div>
            <UButton v-if="offeringPath" :to="offeringPath" color="neutral" variant="soft" size="sm" :label="t('payment.change')" />
          </div>

          <div class="border-t border-default pt-5 space-y-2">
            <h3 class="text-sm font-semibold text-highlighted">{{ t('payment.price_details') }}</h3>
            <dl class="space-y-2 text-sm">
              <div v-for="line in priceLines" :key="line.label" class="flex justify-between gap-4">
                <dt class="text-default">{{ line.label }}</dt>
                <dd class="tabular-nums text-default">{{ line.amount }}</dd>
              </div>
              <div v-if="review && review.surcharge > 0" class="flex justify-between gap-4" data-payment-surcharge>
                <dt class="text-default">{{ t('payment.surcharge') }}</dt>
                <dd class="tabular-nums text-default">{{ paymentMoney(review.surcharge, review.currency) }}</dd>
              </div>
            </dl>
          </div>

          <div class="flex justify-between items-baseline border-t border-default pt-5">
            <span class="font-semibold text-highlighted">{{ t('payment.total') }} <span class="underline">{{ handoff.currency }}</span></span>
            <span class="font-semibold text-highlighted tabular-nums" data-payment-total>
              {{ paymentMoney(review ? review.total : handoff.subtotal, handoff.currency) }}
            </span>
          </div>
        </aside>

        <div class="lg:order-1 min-w-0 space-y-6">
          <p v-if="completing" class="text-sm text-muted">{{ t('payment.verifying') }}</p>
          <UAlert v-if="outcome === 'processing'" color="info" :title="t('payment.processing')" :description="t('payment.processing_help')" />
          <UAlert v-else-if="outcome === 'refunded'" color="warning" :title="t('payment.refunded')" :description="t('payment.refunded_help')" />
          <UAlert v-else-if="paid || handoff.state === 'paid'" color="success" :title="t('payment.already_paid')" />
          <UAlert v-else-if="handoff.state !== 'open'" color="warning" :title="t('payment.expired')" :description="t('payment.expired_help')" />
          <template v-else>
            <!-- Airbnb's own choice of when to pay, above the methods: paying later is Klarna's (or Affirm's, Afterpay's) method, and its terms are theirs. -->
            <section v-if="laterTypes.length && nowTypes.length" class="space-y-4" data-payment-when>
              <h2 class="text-lg font-semibold text-highlighted">{{ t('payment.when') }}</h2>
              <div class="divide-y divide-default rounded-xl border border-default" role="radiogroup" :aria-label="t('payment.when')">
                <label v-for="option in (['now', 'later'] as const)" :key="option" class="flex cursor-pointer items-start justify-between gap-4 p-4">
                  <span class="min-w-0">
                    <span class="block text-sm font-semibold text-highlighted">{{ option === 'now' ? t('payment.pay_now', { amount: paymentMoney(handoff.subtotal, handoff.currency) }) : t('payment.pay_later') }}</span>
                    <span v-if="option === 'later'" :ref="element => { laterMessage = element as HTMLElement | null }" class="mt-1 block" />
                  </span>
                  <input v-model="when" type="radio" name="payment-when" :value="option" class="mt-1 size-5 shrink-0 accent-(--ui-text-highlighted)" :disabled="working">
                </label>
              </div>
            </section>
            <!-- No frame around Stripe's form: its fields are the only boxes, as on Airbnb's page. -->
            <section class="space-y-4">
              <h2 class="text-lg font-semibold text-highlighted">{{ t('payment.pay_with') }}</h2>
              <!-- Stripe's form stays mounted; a method that carries a surcharge is shown read-only until the buyer pays or changes it. -->
              <div v-show="!review" ref="mount" class="min-h-40" />
              <div v-if="review" class="flex items-center justify-between gap-4">
                <div class="space-y-1" data-payment-method>
                  <p class="font-medium text-sm text-highlighted">{{ methodLabel }}</p>
                  <p v-if="review.surcharge > 0" class="text-xs text-muted">{{ t('payment.surcharge_applies') }}</p>
                </div>
                <UButton color="neutral" variant="soft" size="sm" :label="t('payment.change')" :disabled="working" @click="changeMethod" />
              </div>
            </section>

            <i18n-t keypath="payment.agreement" tag="p" scope="global" class="text-xs text-muted leading-relaxed">
              <template #terms>
                <NuxtLink v-if="termsPath" :to="termsPath" class="font-semibold text-default underline">{{ t('payment.booking_terms') }}</NuxtLink>
                <template v-else>{{ t('payment.booking_terms') }}</template>
              </template>
            </i18n-t>
            <UButton
              size="xl"
              block
              :label="review ? t('payment.pay', { amount: paymentMoney(review.total, review.currency) }) : t('payment.confirm')"
              :loading="working || completing"
              :disabled="!review && !ready"
              class="font-semibold py-3.5 text-base"
              @click="review ? pay() : confirmAndPay()"
            />
          </template>
          <UAlert v-if="actionError" color="error" :description="actionError" />
        </div>
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { useMounted } from '@vueuse/core'
import { loadStripe, type Stripe, type StripeElements, type StripePaymentElement, type StripePaymentMethodMessagingElementOptions } from '@stripe/stripe-js'
import { presentationForProduct } from '~/utils/product-presentation'
import type { ProductKind } from '~/shared/product-details'
import { paymentMoney } from '~/shared/payment-display'
import { cardBrandLabel } from '~/composables/usePaymentsSettings'
import { formatCalendarDate, formatTimestamp } from '~/utils/timezone'
import { stayNightlyGroups } from '~/shared/stay-listing'
import { bookedPolicyTerms } from '~/shared/stay-cancellation'
import { isRecord, publicApiMutation, publicApiRequest } from '~/utils/api-clients'
import type { paymentHandoff, reviewPayment, confirmPayment, PaymentReturn } from '~/server/domain/payments/intent'

definePageMeta({ layout: 'standalone' })
useResponseHeader('cache-control').value = 'private, no-store'
useHead({ meta: [{ name: 'referrer', content: 'no-referrer' }, { name: 'robots', content: 'noindex, nofollow' }] })
const { t, locale, localePath } = useI18n()
const route = useRoute()
const paymentId = String(route.params.paymentId)
// A method that left the site comes back here from Stripe, the claim in its return URL's query.
const returned = typeof route.query.claim === 'string'
// Otherwise the claim the checkout handed this browser is in the fragment: no server, log or referrer sees it.
const claim = computed(() => typeof route.query.claim === 'string' ? route.query.claim : route.hash.slice(1))

type Handoff = Awaited<ReturnType<typeof paymentHandoff>>
type Review = Awaited<ReturnType<typeof reviewPayment>>
type Confirmation = Awaited<ReturnType<typeof confirmPayment>>
const isHandoff = (value: unknown): value is Handoff => isRecord(value) && value.payment_id === paymentId && typeof value.title === 'string' && Number.isSafeInteger(value.subtotal) && typeof value.currency === 'string' && typeof value.stripe_account_id === 'string' && typeof value.publishable_key === 'string' && Array.isArray(value.payment_method_types) && value.payment_method_types.every(type => typeof type === 'string') && ['open', 'paid', 'failed', 'expired'].includes(String(value.state))
const isReview = (value: unknown): value is Review => isRecord(value) && typeof value.payment_method_id === 'string' && Number.isSafeInteger(value.subtotal) && Number.isSafeInteger(value.surcharge) && value.total === (value.subtotal as number) + (value.surcharge as number) && isRecord(value.method)
const isConfirmation = (value: unknown): value is Confirmation => isRecord(value) && typeof value.status === 'string' && typeof value.requires_action === 'boolean'
const isReturn = (value: unknown): value is PaymentReturn => isRecord(value) && (value.state === 'processing' || value.state === 'refunded' || (value.state === 'paid' && (
  (value.kind === 'stay' && typeof value.activity_id === 'string' && typeof value.receipt_token === 'string')
  || ((value.kind === 'booking' || value.kind === 'reservation') && typeof value.request_id === 'string' && typeof value.cancellation_token === 'string'))))

const { data: handoff, status, error } = await useAsyncData(`payment-handoff:${paymentId}`, () => publicApiRequest<Handoff>(`/api/public/payments/${encodeURIComponent(paymentId)}`, { query: { claim: claim.value }, validate: isHandoff }), { server: false, immediate: Boolean(claim.value) })
// The fragment never reaches the server, so a missing claim is known only once mounted.
const mounted = useMounted()
const loadError = computed(() => !claim.value ? t('payment.unavailable') : error.value ? getErrorMessage(error.value, t('payment.unavailable')) : '')
useSocialMetadata(() => ({ path: route.path, title: t('payment.title'), description: t('payment.title'), socialImage: null, discoverability: 'private' }))

const mount = ref<HTMLElement | null>(null)
const ready = ref(false)
const working = ref(false)
const actionError = ref('')
const review = ref<Review | null>(null)
const completing = ref(false)
const paid = ref(false)
const outcome = ref<'processing' | 'refunded' | null>(null)
let stripe: Stripe | null = null
let mounting = false
let elements: StripeElements | null = null
let paymentElement: StripePaymentElement | null = null

const methodLabel = computed(() => {
  const method = review.value?.method
  if (!method) return ''
  if (method.wallet) return method.wallet.replace('_', ' ')
  if (method.bank_name && method.last4) return `${method.bank_name} •••• ${method.last4}`
  return method.brand && method.last4 ? `${cardBrandLabel(method.brand)} •••• ${method.last4}` : method.type
})

const money = (minor: number) => paymentMoney(minor, handoff.value!.currency)
const nightsLabel = (count: number) => count === 1 ? t('stay.one_night') : t('stay.nights_count', { count })
const guestsLabel = (count: number) => `${count} ${t(count === 1 ? 'site.experience_detail.guest' : 'site.experience_detail.guests')}`
const stayRange = computed(() => {
  const stay = handoff.value?.stay
  return stay ? `${formatCalendarDate(stay.check_in_date, locale.value, { month: 'short', day: 'numeric' })} – ${formatCalendarDate(stay.check_out_date, locale.value, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''
})
// A party is shown where it was chosen: a stay's guests, an experience's places.
const guests = computed(() => {
  const value = handoff.value
  if (!value) return ''
  if (value.stay) return guestsLabel(value.stay.adults + value.stay.children)
  return value.kind === 'experience' || value.kind === 'reservation' ? guestsLabel(value.quantity) : ''
})
const policySummary = computed(() => {
  const policy = handoff.value?.stay?.cancellation_policy
  return policy ? bookedPolicyTerms(policy).summary : handoff.value?.cancellation_policy ?? ''
})
// The offering's own page: where its full terms are stated and what was picked can be changed.
const offeringPath = computed(() => {
  const value = handoff.value
  if (!value?.product_slug || !value.kind || value.kind === 'reservation') return ''
  // Only an experience's and a stay's page is the site's; any other offering's is its location's.
  if (value.kind !== 'experience' && value.kind !== 'stay' && !value.location_slug) return ''
  return localePath(presentationForProduct({ kind: value.kind as ProductKind }).productPath(value.location_slug ?? '', value.product_slug))
})
// A stay's booked policy is always among its things to know; any other offering states its terms on its page.
const termsPath = computed(() => !offeringPath.value ? '' : handoff.value?.stay ? `${offeringPath.value}#things-to-know` : offeringPath.value)

// Airbnb's "Choose when to pay": now with any method, or later with the method that pays in installments.
const LATER_TYPES = ['klarna', 'affirm', 'afterpay_clearpay']
const laterTypes = computed(() => handoff.value?.payment_method_types.filter(type => LATER_TYPES.includes(type)) ?? [])
const nowTypes = computed(() => handoff.value?.payment_method_types.filter(type => !LATER_TYPES.includes(type)) ?? [])
const when = ref<'now' | 'later'>('now')
const shownTypes = () => !laterTypes.value.length || !nowTypes.value.length ? handoff.value!.payment_method_types : when.value === 'now' ? nowTypes.value : laterTypes.value
const laterMessage = ref<HTMLElement | null>(null)
/** How the total adds up, the way Airbnb's receipt reads: "$120.00 × 2 nights", "$95.00 × 1 guest". */
const priceLines = computed(() => {
  const value = handoff.value
  if (!value) return []
  if (value.stay) return stayNightlyGroups(value.stay.nightly).map(({ price, nights }) => ({ label: t('stay.nightly_line', { price: money(price), nights: nightsLabel(nights) }), amount: money(price * nights) }))
  if (value.quantity === 1) return [{ label: value.title, amount: money(value.subtotal) }]
  return [{ label: t('payment.unit_line', { price: money(value.unit_amount), count: guests.value || value.quantity }), amount: money(value.subtotal) }]
})

// A paid purchase, or one Stripe sent back here, goes on to its receipt.
watch(handoff, (value) => {
  if (value && !import.meta.server && (value.state === 'paid' || (returned && value.state === 'open'))) void complete()
}, { immediate: true })

// Stripe's Payment Element on the business's own account, in deferred mode: the
// method is created first so the server can price it before anything is confirmed.
// It mounts once both the open handoff and its container exist: the container
// renders only after the load status settles, which is after the data arrives.
watch([handoff, mount], async ([value, container]) => {
  if (!value || value.state !== 'open' || !container || mounting || import.meta.server) return
  mounting = true
  if (value.review) review.value = null // A stored review is re-read only through its method; the buyer reviews again here.
  try {
    stripe = await loadStripe(value.publishable_key, { stripeAccount: value.stripe_account_id })
    if (!stripe) throw new Error('Stripe could not be loaded')
    elements = stripe.elements({
      mode: 'payment', amount: value.subtotal, currency: value.currency.toLowerCase(),
      paymentMethodTypes: shownTypes(),
      // The method is created here and attached by the server, which prices it before anything is confirmed.
      paymentMethodCreation: 'manual',
      ...(value.customer_session_client_secret ? { customerSessionClientSecret: value.customer_session_client_secret } : {}),
      // Airbnb lists the ways to pay as radio rows divided by hairlines, not boxed tabs.
      appearance: {
        theme: document.documentElement.classList.contains('dark') ? 'night' : 'stripe',
        rules: { '.AccordionItem': { border: 'none', boxShadow: 'none', paddingLeft: '0px', paddingRight: '0px', backgroundColor: 'transparent' } },
      },
    })
    paymentElement = elements.create('payment', { layout: { type: 'accordion', defaultCollapsed: false, radios: 'always', spacedAccordionItems: false } })
    paymentElement.on('ready', () => { ready.value = true })
    paymentElement.on('change', () => { if (review.value) review.value = null })
    paymentElement.mount(container)
    // Klarna's own words for what paying later costs, priced on this total.
    if (laterMessage.value && laterTypes.value.length) {
      elements.create('paymentMethodMessaging', { amount: value.subtotal, currency: value.currency as StripePaymentMethodMessagingElementOptions['currency'], paymentMethodTypes: laterTypes.value as StripePaymentMethodMessagingElementOptions['paymentMethodTypes'] }).mount(laterMessage.value)
    }
  } catch (cause) {
    actionError.value = getErrorMessage(cause, t('payment.unavailable'))
  }
}, { immediate: true })

/**
 * Airbnb's one button. The method is priced first; with no surcharge the
 * reviewed total is the one on screen, so it is paid at once. A surcharge is
 * shown, and the buyer pays the new total with a second press.
 */
async function confirmAndPay() {
  await reviewMethod()
  if (review.value && review.value.surcharge === 0) await pay()
}

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

// The button waits for Stripe to show the chosen list, so nothing is submitted from the one before.
watch(when, async () => {
  review.value = null
  if (!elements) return
  // The radios are disabled while working, so one switch finishes before the next.
  working.value = true
  ready.value = false
  try {
    await elements.update({ paymentMethodTypes: shownTypes(), amount: handoff.value!.subtotal })
    ready.value = true
  } catch (cause) {
    actionError.value = getErrorMessage(cause, t('payment.unavailable'))
  } finally {
    working.value = false
  }
})

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
    paid.value = true
  } catch (cause) {
    actionError.value = getErrorMessage(cause, t('payment.declined'))
    // A decline leaves the intent waiting for another method; the review it was for is over.
    review.value = null
    if (elements && handoff.value) elements.update({ amount: handoff.value.subtotal })
  } finally {
    working.value = false
  }
  if (paid.value) await complete()
}

/**
 * The business's site confirms what was paid for, as it does an unpaid
 * booking: its own receipt page. A payment still clearing, or one refunded
 * because what it paid for was taken first, is said so here.
 */
async function complete() {
  if (completing.value) return
  completing.value = true
  actionError.value = ''
  try {
    const done = await publicApiMutation<PaymentReturn>(`/api/public/payments/${encodeURIComponent(paymentId)}/return`, { method: 'POST', body: { claim: claim.value }, validate: isReturn })
    if (done.state !== 'paid') outcome.value = done.state
    else if (done.kind === 'stay') await navigateTo({ path: localePath('/bookings/stay'), query: { id: done.activity_id }, hash: `#${done.receipt_token}` }, { replace: true })
    else await navigateTo({ path: localePath(done.kind === 'booking' ? '/bookings/confirmed' : '/reservations/confirmed'), query: { id: done.request_id }, hash: `#${done.cancellation_token}` }, { replace: true })
  } catch (cause) {
    actionError.value = getErrorMessage(cause, t('payment.unavailable'))
  } finally {
    completing.value = false
  }
}

async function leave() {
  await navigateTo(offeringPath.value || localePath('/'))
}
</script>
