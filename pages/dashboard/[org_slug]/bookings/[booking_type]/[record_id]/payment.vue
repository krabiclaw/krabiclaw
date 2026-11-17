<template>
  <!-- Money the host received or refunded outside KrabiClaw, recorded on the stay. Nothing moves. -->
  <DashboardLeafPanel
    id="booking-payment"
    title="Record a payment"
    lead="Money you received or refunded outside KrabiClaw. Recording it moves no money."
    :saving="saving"
    :disabled="!draft.amount.trim() || !draft.paid_on"
    save-label="Record payment"
    :error="failure"
    @save="record"
  >
    <UFormField :label="`Amount (${b.stayPayment.currency.value ?? ''})`" description="Negative for a refund." required>
      <UInput v-model="draft.amount" inputmode="decimal" class="w-full" />
    </UFormField>
    <UFormField label="Method" required>
      <USelect v-model="draft.method" :items="methods" class="w-full" />
    </UFormField>
    <UFormField label="Date" required>
      <UInput v-model="draft.paid_on" type="date" class="w-full" />
    </UFormField>
    <UFormField label="Reference">
      <UInput v-model="draft.reference" class="w-full" />
    </UFormField>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { bookingEditorKey } from '~/components/dashboard/BookingDetails.vue'
import { STAY_PAYMENT_METHOD_LABELS, type StayPaymentMethod } from '~/shared/bookings'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

const b = inject(bookingEditorKey)!
const level = useRouteLevel()
const methods = Object.entries(STAY_PAYMENT_METHOD_LABELS).map(([value, label]) => ({ value, label }))
const draft = reactive({ amount: '', method: 'cash' as StayPaymentMethod, paid_on: b.stayPayment.today(), reference: '', idempotency_key: crypto.randomUUID() })
const saving = ref(false)
const failure = ref('')

async function record() {
  if (saving.value) return
  saving.value = true
  failure.value = ''
  try {
    await b.stayPayment.record(draft)
    await navigateTo(level.to.value ?? level.path.value)
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'The payment could not be recorded')
  } finally {
    saving.value = false
  }
}
</script>
