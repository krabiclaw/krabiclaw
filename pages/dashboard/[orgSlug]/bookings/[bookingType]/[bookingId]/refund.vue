<template>
  <!-- Airbnb's host sends money from the reservation: one amount, then an explicit approval. -->
  <DashboardLeafPanel
    id="booking-refund"
    title="Send a refund"
    :lead="payment ? `Up to ${paymentMoney(remaining, payment.currency)} can be refunded. It comes from your Stripe balance; KrabiClaw Payments fees aren’t returned.` : ''"
    :saving="preparing"
    :disabled="!amount.trim() || !note.trim()"
    save-label="Review refund"
    :error="failure"
    @save="prepare"
  >
    <UFormField v-if="payment" :label="`Amount (${payment.currency})`">
      <UInput v-model="amount" inputmode="decimal" class="w-full" />
    </UFormField>
    <UFormField v-if="payment" label="Reason" :hint="`${b.firstName(b.booking.value?.guest_name ?? '')} will see this`">
      <UTextarea v-model="note" :rows="3" maxlength="500" class="w-full" placeholder="Tell them why you’re sending this refund." />
    </UFormField>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { bookingEditorKey } from '~/components/dashboard/BookingDetails.vue'
import { paymentMoney } from '~/shared/payment-display'
import { majorAmountToMinor } from '~/shared/prices'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const api = useDashboardApi()
const b = inject(bookingEditorKey)!
const amount = ref('')
const note = ref('')
const preparing = ref(false)
const failure = ref('')
const payment = computed(() => b.booking.value?.payments?.find(entry => entry.payment.id === route.query.payment)?.payment ?? null)
const remaining = computed(() => payment.value ? payment.value.captured_amount - payment.value.refunded_amount : 0)
// Raised, not thrown: a nested page's setup throw leaves a blank screen (DESIGN.md).
watch(() => b.booking.value, (loaded) => { if (loaded && !payment.value) showError(createError({ statusCode: 404, statusMessage: 'Payment not found on this booking' })) }, { immediate: true })

async function prepare() {
  if (!payment.value || preparing.value) return
  preparing.value = true
  failure.value = ''
  try {
    const approval = await api<{ authorization_id: string }>('/api/dashboard/payments/refund', {
      method: 'POST',
      body: { action: 'prepare', payment_id: payment.value.id, amount: majorAmountToMinor(amount.value, payment.value.currency), note: note.value.trim() },
      validate: (value: unknown): value is { authorization_id: string } => isRecord(value) && typeof value.authorization_id === 'string',
    })
    await navigateTo(`/dashboard/${route.params.orgSlug}/earnings/refunds/approve?id=${approval.authorization_id}`)
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'Refund could not be prepared')
  } finally {
    preparing.value = false
  }
}
</script>
