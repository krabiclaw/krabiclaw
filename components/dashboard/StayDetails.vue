<template>
  <!-- One stay at a place to stay: who is coming, when, and what the host has collected. -->
  <DashboardIndexPanel id="stay-details" :title="title">
    <UAlert v-if="error" color="error" variant="soft" title="This stay could not be loaded" :description="getErrorMessage(error, 'Stay request failed')" />
    <div v-else-if="stay" class="mx-auto w-full" :class="dashboardColumnWidths.leaf">
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
      <h1 class="text-[32px] font-semibold leading-tight text-highlighted">{{ guestName }}</h1>
      <p class="mt-1 text-base text-muted">{{ stayDates }} · {{ partyLabel }}</p>
      <UBadge class="mt-3" :color="stay.status === 'cancelled' ? 'neutral' : 'success'" variant="soft" :label="statusLabel" />

      <dl class="mt-6 divide-y divide-default border-y border-default">
        <div v-for="row in rows" :key="row.label" class="flex justify-between gap-4 py-4">
          <dt class="text-base text-muted">{{ row.label }}</dt>
          <dd class="text-right text-base text-highlighted">{{ row.value }}</dd>
        </div>
      </dl>

      <template v-if="stay.owner === 'app'">
        <h2 class="mt-8 text-lg font-semibold text-highlighted">Payments</h2>
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
      <p v-else class="mt-8 text-base text-muted">{{ channelName }} collected payment for this stay. Change or cancel it on {{ channelName }}.</p>
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import DashboardIndexPanel from '~/lib/components/workspace/dashboard/DashboardIndexPanel.vue'
import { dashboardColumnWidths } from '~/lib/components/workspace/dashboard/dashboardPanelContext'
import DashboardConfirmDialog from '~/components/dashboard/DashboardConfirmDialog.vue'
import type { StayDetail, StayPaymentMethod } from '~/server/domain/stays'
import { isCurrencyCode } from '~/shared/currencies'
import { formatMinorAmount, majorAmountToMinor } from '~/shared/prices'
import { formatCalendarDate, localDateAt } from '~/utils/timezone'
import { getErrorMessage } from '~/utils/errors'

const props = defineProps<{ stayId: string }>()
const dashboardApi = useDashboardApi()
const confirmDialog = useOverlay().create(DashboardConfirmDialog)

const isStay = (value: unknown): value is { stay: StayDetail; manage?: boolean } => isRecord(value) && isRecord(value.stay) && typeof value.stay.id === 'string'
const { data, error, refresh } = await useAsyncData(`dashboard-stay:${props.stayId}`, () => dashboardApi(`/api/dashboard/stays/${encodeURIComponent(props.stayId)}`, { validate: isStay }))
const stay = computed(() => data.value?.stay ?? null)
const manage = computed(() => data.value?.manage === true)

const CHANNELS = { airbnb: 'Airbnb', vrbo: 'Vrbo', direct: 'You' } as const
const METHODS: Record<StayPaymentMethod, string> = { cash: 'Cash', bank_transfer: 'Bank transfer', card_external: 'Card (outside KrabiClaw)', other: 'Other' }
const methods = Object.entries(METHODS).map(([value, label]) => ({ value, label }))
const channelName = computed(() => stay.value ? CHANNELS[stay.value.channel] : '')
const guestName = computed(() => [stay.value?.guest_name, stay.value?.guest_surname].filter(Boolean).join(' ') || 'Guest')
const title = computed(() => stay.value ? `${guestName.value}’s stay` : 'Stay')
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
    { label: 'Booked through', value: channelName.value },
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

async function cancel() {
  const value = stay.value
  if (!value) return
  if (!await confirmDialog.open({ title: `Cancel ${guestName.value}’s stay`, description: 'Its nights become available again. Record any refund as a payment.', confirmLabel: 'Cancel stay', cancelLabel: 'Keep stay' })) return
  await run('cancel', () => dashboardApi(`/api/dashboard/stays/${encodeURIComponent(value.id)}/cancel`, { method: 'POST', validate: isStay, body: { expected_version: value.version } }), 'The stay could not be cancelled')
}
</script>
