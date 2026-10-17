<template>
  <DashboardLeafPanel id="reservation-deposit" title="Reservation deposit" :saving="editor.saving.value" :disabled="editor.saveDisabled.value || editor.reservationForm.value.deposit_required && !currency" :error="editor.editorError.value ?? (!currency ? 'Set the business currency before configuring deposits' : '')" @cancel="editor.revert" @save="editor.save">
    <USwitch v-model="editor.reservationForm.value.deposit_required" label="Require a deposit" />
    <template v-if="editor.reservationForm.value.deposit_required && currency">
      <UFormField label="Currency"><USelect :model-value="currency" :items="CURRENCY_OPTIONS" @update:model-value="editor.reservationForm.value.deposit_currency = $event; editor.reservationForm.value.deposit_amount = null" /></UFormField>
      <UFormField :label="`Total per reservation (${currency})`">
        <UInputNumber v-model="amount" :min="0" :step="10 ** -currencyFractionDigits(currency)" />
      </UFormField>
      <UFormField label="Tax">
        <URadioGroup :model-value="editor.reservationForm.value.deposit_tax_behavior ?? undefined" @update:model-value="editor.reservationForm.value.deposit_tax_behavior = $event as 'inclusive' | 'exclusive'" :items="[{ value: 'inclusive', label: 'Included in the amount' }, { value: 'exclusive', label: 'Added at checkout' }]" />
      </UFormField>
      <UFormField label="Minimum party size" hint="Optional">
        <UInputNumber v-model="editor.reservationForm.value.deposit_trigger_party_size" :min="1" />
      </UFormField>
      <NuxtLink :to="paymentsPath">Payments settings</NuxtLink>
    </template>
  </DashboardLeafPanel>
</template>
<script setup lang="ts">
import { CURRENCY_OPTIONS, isCurrencyCode, currencyFractionDigits } from '~/shared/currencies'
import { majorAmountToMinor, minorAmountToMajor } from '~/shared/prices'
import { useCalendarLocationEditor } from '~/composables/useCalendarLocationEditor'
definePageMeta({ layout: 'dashboard' })
const editor = await useCalendarLocationEditor('reservations')
const { organization } = await useDashboardOrganization()
const currency = computed(() => { const value = editor.reservationForm.value.deposit_currency ?? organization.value?.default_currency; return isCurrencyCode(value) ? value : null })
const amount = computed({ get: () => editor.reservationForm.value.deposit_amount == null || !currency.value ? null : Number(minorAmountToMajor(editor.reservationForm.value.deposit_amount, currency.value)), set: value => { if (!currency.value) throw new Error('Choose a deposit currency'); editor.reservationForm.value.deposit_currency = currency.value; editor.reservationForm.value.deposit_amount = value == null ? null : majorAmountToMinor(String(value), currency.value) } })
const route = useRoute()
const paymentsPath = computed(() => `/dashboard/${encodeURIComponent(String(route.params.orgSlug))}/payments`)
</script>
