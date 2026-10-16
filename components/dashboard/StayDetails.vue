<template>
  <!-- One stay at a place to stay: who is coming, when, and what the host has collected. -->
  <!-- Inside the guest thread's leaf, which owns the column, it is the body alone. -->
  <component :is="embedded ? 'div' : DashboardIndexPanel" v-bind="embedded ? {} : { id: 'stay-details', title, column: 'leaf' }">
    <UAlert v-if="error" color="error" variant="soft" title="This stay could not be loaded" :description="getErrorMessage(error, 'Stay request failed')" />
    <div v-else-if="stay">
      <UAlert v-if="actionError" class="mb-5" color="error" variant="soft" icon="i-lucide-circle-alert" :description="actionError" />
      <!-- A channel stay overlapping another is the host's to resolve; it never resolves itself. -->
      <UAlert
        v-if="stay.overbooked"
        class="mb-5"
        color="error"
        icon="i-lucide-triangle-alert"
        title="Overbooked"
        :description="`${channelName} confirmed this stay on nights another stay holds. Cancel this stay on ${channelName}, or cancel the other stay where it was booked.`"
      />
      <UAlert v-if="!personalScope && guest.state === 'missing'" class="mb-5" color="error" variant="soft" icon="i-lucide-circle-alert" title="Guest name missing" description="This stay was made in KrabiClaw, which requires a guest name, but it has none." />
      <template v-if="personalScope && home">
        <h2 class="text-2xl font-semibold text-highlighted">{{ home.name }}</h2>
        <p class="mt-1 text-base text-muted">{{ home.organization_name }}</p>
      </template>
      <h2 v-else-if="guest.state === 'named'" class="text-2xl font-semibold text-highlighted">{{ guest.name }}</h2>
      <h2 v-else-if="guest.state === 'not-provided'" class="text-2xl font-semibold text-muted">Name not provided by {{ channelName }}</h2>
      <h2 v-else-if="guest.state === 'missing'" class="text-2xl font-semibold text-error">Guest name missing</h2>
      <p class="mt-1 text-base text-muted">{{ stayDates }} · {{ partyLabel }}</p>
      <UBadge class="mt-3" :color="stay.status === 'cancelled' ? 'neutral' : 'success'" variant="soft" :label="statusLabel" />

      <dl class="mt-6 divide-y divide-default border-y border-default">
        <div v-for="row in rows" :key="row.label" class="flex justify-between gap-4 py-4">
          <dt class="text-base text-muted">{{ row.label }}</dt>
          <dd class="text-right text-base text-highlighted">{{ row.value }}</dd>
        </div>
      </dl>

      <!-- The policy the guest booked under, in Airbnb's words: what their own cancellation returns. -->
      <template v-if="policy">
        <h2 class="mt-8 text-xl font-semibold text-highlighted">Cancellation policy</h2>
        <p class="mt-1 text-base text-highlighted">{{ policy.label }}</p>
        <ul class="mt-2 space-y-1 text-base text-muted">
          <li v-for="term in policy.terms" :key="term">{{ term }}</li>
        </ul>
      </template>

      <!-- The Stripe payment the guest made on the site: its record and refunds are the payment's own screens. -->
      <template v-if="!personalScope && stay.online_payment">
        <h2 class="mt-8 text-xl font-semibold text-highlighted">Paid on your site</h2>
        <p class="mt-1 text-base text-muted">{{ money(stay.online_payment.captured_minor) }}{{ stay.online_payment.refunded_minor ? ` · ${money(stay.online_payment.refunded_minor)} refunded` : '' }}</p>
        <div class="mt-4 divide-y divide-default border-y border-default">
          <NuxtLink :to="`${paymentPath}`" class="flex items-center gap-4 py-4">
            <span class="min-w-0 flex-1 text-base font-medium text-highlighted">View payment</span>
            <UIcon name="i-lucide-chevron-right" class="size-5 text-muted" />
          </NuxtLink>
          <NuxtLink v-if="manage && stay.online_payment.captured_minor > stay.online_payment.refunded_minor" :to="{ path: `${paymentPath}/refund`, query: { payment: stay.online_payment.payment_id } }" class="flex items-center gap-4 py-4">
            <span class="min-w-0 flex-1 text-base font-medium text-highlighted">Send a refund</span>
            <UIcon name="i-lucide-chevron-right" class="size-5 text-muted" />
          </NuxtLink>
        </div>
      </template>

      <template v-if="personalScope">
        <UButton v-if="cancellation" class="mt-8" color="error" variant="soft" label="Cancel stay" :loading="busy === 'cancel'" @click="cancelAsGuest" />
      </template>
      <template v-else-if="stay.owner === 'app'">
        <h2 class="mt-8 text-xl font-semibold text-highlighted">Payments</h2>
        <p class="mt-1 text-sm text-muted">Money you received outside KrabiClaw. Recording it moves no money.</p>
        <ul v-if="stay.payments.length" class="mt-4 divide-y divide-default border-y border-default">
          <li v-for="payment in stay.payments" :key="payment.id" class="flex items-center gap-4 py-3">
            <span class="min-w-0 flex-1">
              <span class="block text-base text-highlighted">{{ money(payment.amount_minor) }} · {{ methodLabel(payment.method) }}</span>
              <span class="block text-sm text-muted">{{ formatCalendarDate(payment.paid_on, 'en') }}{{ payment.reference ? ` · ${payment.reference}` : '' }}</span>
            </span>
            <UButton v-if="manage" icon="i-lucide-trash-2" color="neutral" variant="ghost" :aria-label="`Delete payment of ${money(payment.amount_minor)}`" :loading="busy === payment.id" @click="deletePayment(payment.id)" />
          </li>
        </ul>
        <p v-else class="mt-4 text-base text-muted">No payments recorded.</p>

        <UForm v-if="manage && stay.status !== 'cancelled'" :state="draft" class="mt-6 space-y-4" @submit="recordPayment">
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField :label="`Amount (${stay.currency})`" name="amount" description="Negative for a refund." required>
              <UInput v-model="draft.amount" inputmode="decimal" class="w-full" />
            </UFormField>
            <UFormField label="Method" name="method" required>
              <USelect v-model="draft.method" :items="methods" class="w-full" />
            </UFormField>
            <UFormField label="Date" name="paid_on" required>
              <UInput v-model="draft.paid_on" type="date" class="w-full" />
            </UFormField>
            <UFormField label="Reference" name="reference">
              <UInput v-model="draft.reference" class="w-full" />
            </UFormField>
          </div>
          <UButton type="submit" label="Record payment" :loading="busy === 'record'" :disabled="!draft.amount.trim() || !draft.paid_on" />
        </UForm>
        <UButton v-if="manage && stay.status !== 'cancelled'" class="mt-8" color="error" variant="soft" label="Cancel stay" :loading="busy === 'cancel'" @click="cancel" />
      </template>
      <p v-else-if="!personalScope" class="mt-8 text-base text-muted">{{ channelName }} collected payment for this stay. Change or cancel it on {{ channelName }}.</p>
    </div>
  </component>
</template>

<script setup lang="ts">
import DashboardIndexPanel from '~/lib/components/workspace/dashboard/DashboardIndexPanel.vue'
import DashboardConfirmDialog from '~/components/dashboard/DashboardConfirmDialog.vue'
import type { GuestStay, StayDetail, StayPaymentMethod } from '~/server/domain/stays'
import { STAY_CANCELLATION_POLICIES, STAY_LONG_TERM_CANCELLATION_POLICIES } from '~/shared/stay-listing'
import { isCurrencyCode } from '~/shared/currencies'
import { formatMinorAmount, majorAmountToMinor } from '~/shared/prices'
import { formatCalendarDate, localDateAt } from '~/utils/timezone'
import { getErrorMessage } from '~/utils/errors'

const props = defineProps<{
  stayId: string
  /** Mounted inside the guest thread's leaf, which already owns the column and its padding. */
  embedded?: boolean
  /** The guest's own stay, read and cancelled from their account; stayId is then its activity ID. */
  personalScope?: boolean
}>()
const dashboardApi = useDashboardApi()
const route = useRoute()
const realtime = useDashboardInvalidations()
const confirmDialog = useOverlay().create(DashboardConfirmDialog)

const isStay = (value: unknown): value is { stay: StayDetail; manage?: boolean } => isRecord(value) && isRecord(value.stay) && typeof value.stay.id === 'string'
const isGuestStay = (value: unknown): value is GuestStay => isStay(value) && isRecord((value as Record<string, unknown>).home) && 'cancellation' in value
const { data, error, refresh } = await useAsyncData(`${props.personalScope ? 'account' : 'dashboard'}-stay:${props.stayId}`, (): Promise<{ stay: StayDetail; manage?: boolean } | GuestStay> => props.personalScope
  ? applicationFetch(`/api/account/stays/${encodeURIComponent(props.stayId)}`, { validate: isGuestStay })
  : dashboardApi(`/api/dashboard/stays/${encodeURIComponent(props.stayId)}`, { validate: isStay }))
const stay = computed(() => data.value?.stay ?? null)
const manage = computed(() => !props.personalScope && data.value !== null && 'manage' in data.value! && data.value.manage === true)
const home = computed(() => data.value && 'home' in data.value ? data.value.home : null)
const cancellation = computed(() => data.value && 'cancellation' in data.value ? data.value.cancellation : null)
const policy = computed(() => {
  const code = stay.value?.cancellation_policy
  if (!code) return null
  return code.startsWith('long_term_')
    ? STAY_LONG_TERM_CANCELLATION_POLICIES[code.slice('long_term_'.length) as keyof typeof STAY_LONG_TERM_CANCELLATION_POLICIES]
    : STAY_CANCELLATION_POLICIES[code as keyof typeof STAY_CANCELLATION_POLICIES]
})
const paymentPath = computed(() => stay.value?.online_payment ? `/dashboard/${route.params.orgSlug}/bookings/payment/${encodeURIComponent(stay.value.online_payment.payment_id)}` : '')
watch(realtime.event, event => {
  if (event?.type === 'stay.changed' && (event.stayId === props.stayId || (event.stayId === null && event.productId === stay.value?.product_id))) void refresh()
})
watch(realtime.connectionEpoch, epoch => { if (epoch > 0) void refresh() })

const CHANNELS = { airbnb: 'Airbnb', vrbo: 'Vrbo', direct: 'You' } as const
const METHODS: Record<StayPaymentMethod, string> = { cash: 'Cash', bank_transfer: 'Bank transfer', card_external: 'Card (outside KrabiClaw)', other: 'Other' }
const methods = Object.entries(METHODS).map(([value, label]) => ({ value, label }))
const channelName = computed(() => stay.value ? CHANNELS[stay.value.channel] : '')
/**
 * Who the stay is for. A stay made here always names its guest, so one without
 * is missing data; a channel may send a stay without a name, which is said as
 * such rather than given one.
 */
type GuestIdentity = { state: 'loading' } | { state: 'named'; name: string } | { state: 'not-provided' } | { state: 'missing' }
const guest = computed<GuestIdentity>(() => {
  const value = stay.value
  if (!value) return { state: 'loading' }
  if (value.owner === 'app' && !value.guest_name) return { state: 'missing' }
  const name = [value.guest_name, value.guest_surname].filter(Boolean).join(' ')
  return name ? { state: 'named', name } : { state: 'not-provided' }
})
const title = computed(() => props.personalScope ? 'Your stay' : guest.value.state === 'named' ? `${guest.value.name}’s stay` : 'Stay')
const nights = computed(() => stay.value ? Math.round((Date.parse(`${stay.value.check_out_date}T00:00:00Z`) - Date.parse(`${stay.value.check_in_date}T00:00:00Z`)) / 86_400_000) : 0)
const stayDates = computed(() => stay.value
  ? `${formatCalendarDate(stay.value.check_in_date, 'en')} – ${formatCalendarDate(stay.value.check_out_date, 'en')} · ${nights.value === 1 ? '1 night' : `${nights.value} nights`}`
  : '')
const partyLabel = computed(() => {
  const value = stay.value
  if (!value) return ''
  const parts = [`${value.adults} ${value.adults === 1 ? 'adult' : 'adults'}`]
  if (value.children) parts.push(`${value.children} ${value.children === 1 ? 'child' : 'children'}`)
  if (value.infants) parts.push(`${value.infants} ${value.infants === 1 ? 'infant' : 'infants'}`)
  return parts.join(', ')
})
const statusLabel = computed(() => stay.value?.status === 'cancelled' ? 'Cancelled' : stay.value?.status === 'pending' ? 'Pending' : 'Confirmed')

function money(minor: number): string {
  const currency = stay.value?.currency
  if (!isCurrencyCode(currency)) throw new Error(`Unsupported stay currency ${String(currency)}`)
  return `${minor < 0 ? '−' : ''}${formatMinorAmount(Math.abs(minor), currency)}`
}
function methodLabel(method: StayPaymentMethod) { return METHODS[method] }

const rows = computed(() => {
  const value = stay.value
  if (!value) return []
  return [
    ...(props.personalScope ? [] : [{ label: 'Booked through', value: channelName.value }]),
    { label: 'Total', value: money(value.total_minor) },
    ...(value.owner === 'app' ? [{ label: 'Paid', value: money(value.paid_minor) }] : []),
    ...(value.arrival_time ? [{ label: 'Arriving', value: value.arrival_time }] : []),
    ...(value.guest_phone ? [{ label: 'Phone', value: value.guest_phone }] : []),
    ...(value.guest_email ? [{ label: 'Email', value: value.guest_email }] : []),
    ...(value.channel_booking_id ? [{ label: `${channelName.value} confirmation`, value: value.channel_booking_id }] : []),
    ...(value.notes ? [{ label: 'Notes', value: value.notes }] : []),
    ...(value.cancellation_reason ? [{ label: 'Cancellation reason', value: value.cancellation_reason }] : []),
  ]
})

const actionError = ref<string | null>(null)
const busy = ref<string | null>(null)
// The payment day defaults to today where the home is; one key per payment being entered, kept across retries.
const homeToday = () => stay.value ? localDateAt(new Date(), stay.value.timezone) : ''
const draft = reactive({ amount: '', method: 'cash' as StayPaymentMethod, paid_on: homeToday(), reference: '', key: crypto.randomUUID() })
watch(stay, () => { if (!draft.paid_on) draft.paid_on = homeToday() })

async function run(key: string, action: () => Promise<unknown>, failure: string) {
  busy.value = key
  actionError.value = null
  try {
    await action()
    await refresh()
    if (error.value) throw error.value
  } catch (cause) {
    actionError.value = getErrorMessage(cause, failure)
  } finally {
    busy.value = null
  }
}

async function recordPayment() {
  const value = stay.value
  if (!value || !isCurrencyCode(value.currency)) return
  const typed = draft.amount.trim()
  const negative = typed.startsWith('-')
  await run('record', async () => {
    const minor = majorAmountToMinor(negative ? typed.slice(1) : typed, value.currency as Parameters<typeof majorAmountToMinor>[1])
    await dashboardApi(`/api/dashboard/stays/${encodeURIComponent(value.id)}/payments`, {
      method: 'POST', validate: isStay,
      body: { amount_minor: negative ? -minor : minor, method: draft.method, paid_on: draft.paid_on, reference: draft.reference || undefined, idempotency_key: draft.key },
    })
    draft.amount = ''
    draft.reference = ''
    draft.key = crypto.randomUUID()
  }, 'The payment could not be recorded')
}

async function deletePayment(paymentId: string) {
  const value = stay.value
  if (!value) return
  await run(paymentId, () => dashboardApi(`/api/dashboard/stays/${encodeURIComponent(value.id)}/payments/${encodeURIComponent(paymentId)}`, { method: 'DELETE', validate: isStay }), 'The payment could not be deleted')
}

// A stay paid on the site returns the guest's whole payment, as Airbnb's host cancellation does; the host approves that refund next.
async function cancel() {
  const value = stay.value
  if (!value) return
  const held = value.online_payment ? value.online_payment.captured_minor - value.online_payment.refunded_minor : 0
  const description = held > 0
    ? `Its nights become available again and ${guest.value.state === 'named' ? guest.value.name : 'the guest'} is refunded ${money(held)} in full. You approve the refund next.`
    : 'Its nights become available again. Record any refund as a payment.'
  if (!await confirmDialog.open({ title: guest.value.state === 'named' ? `Cancel ${guest.value.name}’s stay` : 'Cancel this stay', description, confirmLabel: 'Cancel stay', cancelLabel: 'Keep stay' })) return
  busy.value = 'cancel'
  actionError.value = null
  try {
    await dashboardApi(`/api/dashboard/stays/${encodeURIComponent(value.id)}/cancel`, { method: 'POST', validate: isStay, body: { expected_version: value.version } })
    await refresh()
  } catch (cause) {
    const approval = isRecord(cause) && isRecord(cause.data) && isRecord(cause.data.data) && typeof cause.data.data.financial_approval_url === 'string' ? cause.data.data.financial_approval_url : null
    if (approval) await navigateTo(approval)
    else actionError.value = getErrorMessage(cause, 'The stay could not be cancelled')
  } finally {
    busy.value = null
  }
}

/** The guest cancels their own stay; the policy they booked under decides what comes back. */
async function cancelAsGuest() {
  const value = stay.value
  const quote = cancellation.value
  if (!value || !quote || !value.request_id || !policy.value) return
  const description = quote.refund_minor === quote.paid_minor ? `You get back the full ${money(quote.paid_minor)}.`
    : quote.refund_minor > 0 ? `Under the ${policy.value.label} policy you get back ${money(quote.refund_minor)} of the ${money(quote.paid_minor)} you paid.`
      : `Under the ${policy.value.label} policy none of the ${money(quote.paid_minor)} you paid comes back.`
  if (!await confirmDialog.open({ title: 'Cancel your stay?', description, confirmLabel: 'Cancel stay', cancelLabel: 'Keep stay' })) return
  await run('cancel', () => applicationFetch('/api/account/cancel', {
    method: 'POST', body: { request_id: value.request_id },
    validate: (response: unknown): response is { success: true } => isRecord(response) && response.success === true,
  }), 'Your stay could not be cancelled')
}
</script>
