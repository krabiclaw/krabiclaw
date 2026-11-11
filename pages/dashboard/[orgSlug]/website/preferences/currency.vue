<template>
  <DashboardLeafPanel
    id="organization-currency"
    title="Choose a currency"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <div class="w-full py-2">
      <div
        class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-5"
        role="radiogroup"
        aria-label="Choose a currency"
      >
        <button
          v-for="currency in AIRBNB_CURRENCIES"
          :key="currency.code"
          type="button"
          role="radio"
          :aria-checked="editor.form.default_currency === currency.code"
          :data-testid="`currency-option-${currency.code}`"
          class="text-left transition cursor-pointer select-none"
          :class="editor.form.default_currency === currency.code
            ? 'border border-neutral-900 dark:border-white rounded-xl p-3 -m-3 bg-neutral-50/50 dark:bg-neutral-800/30'
            : 'p-3 -m-3 rounded-xl hover:bg-neutral-50 dark:hover:bg-neutral-800/40'"
          @click="selectCurrency(currency.code)"
        >
          <div class="text-base text-highlighted">
            {{ currency.name }}
          </div>
          <div class="text-sm text-muted mt-0.5">
            {{ currency.label }}
          </div>
        </button>
      </div>

      <UAlert
        v-if="editor.validationMessage.value"
        class="mt-8"
        color="error"
        variant="soft"
        :description="editor.validationMessage.value"
      />
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import type { CurrencyCode } from '~/shared/currencies'
import { organizationSettingsEditorKey } from '~/lib/components/workspace/settings/OrganizationSettingsPage.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(organizationSettingsEditorKey)!

interface AirbnbCurrencyItem {
  code: CurrencyCode
  name: string
  label: string
}

const AIRBNB_CURRENCIES: readonly AirbnbCurrencyItem[] = [
  { code: 'USD', name: 'United States dollar', label: 'USD – $' },
  { code: 'AUD', name: 'Australian dollar', label: 'AUD – $' },
  { code: 'BRL', name: 'Brazilian real', label: 'BRL – R$' },
  { code: 'BGN', name: 'Bulgarian lev', label: 'BGN – лв.' },
  { code: 'CAD', name: 'Canadian dollar', label: 'CAD – $' },
  { code: 'CLP', name: 'Chilean peso', label: 'CLP – $' },
  { code: 'CNY', name: 'Chinese yuan', label: 'CNY – ￥' },
  { code: 'COP', name: 'Colombian peso', label: 'COP – $' },
  { code: 'CRC', name: 'Costa Rican colon', label: 'CRC – ₡' },
  { code: 'CZK', name: 'Czech koruna', label: 'CZK – Kč' },
  { code: 'DKK', name: 'Danish krone', label: 'DKK – kr' },
  { code: 'EGP', name: 'Egyptian pound', label: 'EGP – ج.م' },
  { code: 'AED', name: 'Emirati dirham', label: 'AED – ﺩ.ﺇ' },
  { code: 'EUR', name: 'Euro', label: 'EUR – €' },
  { code: 'GHS', name: 'Ghanaian cedi', label: 'GHS – GH₵' },
  { code: 'HKD', name: 'Hong Kong dollar', label: 'HKD – $' },
  { code: 'HUF', name: 'Hungarian forint', label: 'HUF – Ft' },
  { code: 'INR', name: 'Indian rupee', label: 'INR – ₹' },
  { code: 'IDR', name: 'Indonesian rupiah', label: 'IDR – Rp' },
  { code: 'ILS', name: 'Israeli new shekel', label: 'ILS – ₪' },
  { code: 'JPY', name: 'Japanese yen', label: 'JPY – ¥' },
  { code: 'KZT', name: 'Kazakhstani tenge', label: 'KZT – ₸' },
  { code: 'KES', name: 'Kenyan shilling', label: 'KES – KSh' },
  { code: 'MYR', name: 'Malaysian ringgit', label: 'MYR – RM' },
  { code: 'MXN', name: 'Mexican peso', label: 'MXN – $' },
  { code: 'MAD', name: 'Moroccan dirham', label: 'MAD' },
  { code: 'TWD', name: 'New Taiwan dollar', label: 'TWD – $' },
  { code: 'NZD', name: 'New Zealand dollar', label: 'NZD – $' },
  { code: 'NOK', name: 'Norwegian krone', label: 'NOK – kr' },
  { code: 'PEN', name: 'Peruvian sol', label: 'PEN – S/' },
  { code: 'PHP', name: 'Philippine peso', label: 'PHP – ₱' },
  { code: 'PLN', name: 'Polish zloty', label: 'PLN – zł' },
  { code: 'GBP', name: 'Pound sterling', label: 'GBP – £' },
  { code: 'QAR', name: 'Qatari riyal', label: 'QAR – ر.ق' },
  { code: 'RON', name: 'Romanian leu', label: 'RON – lei' },
  { code: 'SAR', name: 'Saudi Arabian riyal', label: 'SAR – SR' },
  { code: 'SGD', name: 'Singapore dollar', label: 'SGD – $' },
  { code: 'ZAR', name: 'South African rand', label: 'ZAR – R' },
  { code: 'KRW', name: 'South Korean won', label: 'KRW – ₩' },
  { code: 'SEK', name: 'Swedish krona', label: 'SEK – kr' },
  { code: 'CHF', name: 'Swiss franc', label: 'CHF' },
  { code: 'THB', name: 'Thai baht', label: 'THB – ฿' },
  { code: 'TRY', name: 'Turkish lira', label: 'TRY – ₺' },
  { code: 'UGX', name: 'Ugandan shilling', label: 'UGX – USh' },
  { code: 'UAH', name: 'Ukrainian hryvnia', label: 'UAH – ₴' },
  { code: 'UYU', name: 'Uruguayan peso', label: 'UYU – $U' },
  { code: 'VND', name: 'Vietnamese dong', label: 'VND – ₫' },
]

function selectCurrency(code: CurrencyCode) {
  editor.form.default_currency = code
}
</script>