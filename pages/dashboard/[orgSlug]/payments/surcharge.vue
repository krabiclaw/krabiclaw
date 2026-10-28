<template>
  <!-- Stripe's surcharge: the business names a rate, Stripe bounds it per card and never applies it to debit or prepaid. -->
  <DashboardLeafPanel id="organization-surcharge" title="Card surcharge" lead="Pass credit card fees on to the buyer. The surcharge is shown before they pay and included in the total. Stripe caps it for each card and never adds one to debit or prepaid cards." :footer="!connectPending && !connectError && account?.status === 'ready'" :saving="saving" :disabled="!dirty" :error="error" :save-label="account?.surchargeBasisPoints === null ? 'Turn on surcharge' : 'Save rate'" @save="save(parsed)">
    <UAlert v-if="connectError" color="error" :description="getErrorMessage(connectError, 'Payment settings could not be loaded')" />
    <p v-else-if="connectPending" role="status" class="text-muted">Loading payment settings…</p>
    <template v-else-if="account?.status === 'ready'">
      <UFormField label="Surcharge rate" description="Percent of the amount, up to Stripe’s cap for the card.">
        <UInput v-model="percent" type="number" inputmode="decimal" min="0" max="100" step="0.01" :disabled="saving" class="w-32" :ui="{ trailing: 'pe-2' }" data-testid="card-surcharge">
          <template #trailing><span class="text-sm text-muted">%</span></template>
        </UInput>
      </UFormField>
      <template v-if="account.surchargeBasisPoints !== null">
        <p class="mt-6 text-sm text-muted">Surcharging is on at {{ account.surchargeBasisPoints / 100 }}%.</p>
        <UButton class="mt-3" label="Turn off" color="neutral" variant="outline" :loading="saving" @click="save(null)" />
      </template>
    </template>
    <p v-else class="text-base text-muted">Surcharging starts once Stripe has enabled card payments for this business.</p>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { isConnectedAccount, useConnectAccount, type ConnectedAccount } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Card surcharge | KrabiClaw', robots: 'noindex, nofollow' })

const dashboardApi = useDashboardApi()
const { account, setAccount, connectPending, connectError } = useConnectAccount()
/** The rate as a percent in the field; basis points are what the account stores. */
const percent = ref('')
watch(account, (value) => { percent.value = value?.surchargeBasisPoints === null || value === null ? '3' : String(value.surchargeBasisPoints / 100) }, { immediate: true })
const parsed = computed(() => {
  const points = Math.round(Number(percent.value) * 100)
  return Number.isSafeInteger(points) && points >= 1 && points <= 10_000 ? points : null
})
const dirty = computed(() => !connectPending.value && !connectError.value && account.value?.status === 'ready' && parsed.value !== null && parsed.value !== account.value?.surchargeBasisPoints)
const saving = ref(false)
const error = ref('')
async function save(points: number | null) {
  if (saving.value) return
  saving.value = true
  error.value = ''
  try {
    if (connectPending.value || connectError.value || account.value?.status !== 'ready') throw new Error('Load enabled card payment settings before changing the surcharge.')
    const response = await dashboardApi<{ success: true; account: ConnectedAccount }>('/api/dashboard/connect/surcharge', {
      method: 'POST', body: { basis_points: points },
      validate: (value): value is { success: true; account: ConnectedAccount } => isRecord(value) && value.success === true && isConnectedAccount(value.account),
    })
    setAccount(response.account)
  } catch (cause) {
    error.value = getErrorMessage(cause, 'The surcharge could not be saved')
  } finally {
    saving.value = false
  }
}
</script>
