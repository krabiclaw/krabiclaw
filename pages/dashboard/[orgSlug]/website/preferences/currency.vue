<template>
  <DashboardLeafPanel
    id="organization-currency"
    title="Currency"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <div class="mb-6">
      <h2 class="text-xl sm:text-2xl font-semibold text-highlighted">
        Choose a currency
      </h2>
      <p class="mt-1 text-sm text-muted">
        Select the currency your website displays and prices in.
      </p>

      <div class="mt-4">
        <UInput
          v-model="searchQuery"
          icon="i-lucide-search"
          placeholder="Search currency..."
          class="w-full max-w-sm"
        />
      </div>
    </div>

    <div
      class="grid grid-cols-1 sm:grid-cols-2 gap-2.5 sm:gap-3"
      role="radiogroup"
      aria-label="Choose a currency"
    >
      <button
        v-for="currency in filteredCurrencies"
        :key="currency.code"
        type="button"
        role="radio"
        :aria-checked="editor.form.default_currency === currency.code"
        :data-testid="`currency-option-${currency.code}`"
        class="text-left rounded-2xl p-4 sm:p-5 transition cursor-pointer border-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        :class="editor.form.default_currency === currency.code
          ? 'border-highlighted bg-elevated shadow-sm ring-1 ring-highlighted/10'
          : 'border-transparent hover:bg-neutral-100 dark:hover:bg-neutral-800/60'"
        @click="editor.form.default_currency = currency.code"
      >
        <div class="font-medium text-sm sm:text-base text-highlighted leading-snug">
          {{ currency.name }}
        </div>
        <div class="text-xs sm:text-sm text-muted mt-0.5">
          {{ currency.code }} – {{ currency.symbol }}
        </div>
      </button>
    </div>

    <UAlert
      v-if="editor.validationMessage.value"
      class="mt-6"
      color="error"
      variant="soft"
      :description="editor.validationMessage.value"
    />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { CURRENCY_OPTIONS, type CurrencyCode } from '~/shared/currencies'
import { organizationSettingsEditorKey } from '~/lib/components/workspace/settings/OrganizationSettingsPage.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(organizationSettingsEditorKey)!
const searchQuery = ref('')

const currencyNames = new Intl.DisplayNames(['en'], { type: 'currency' })

function getCurrencySymbol(code: string): string {
  try {
    return (0).toLocaleString('en', {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).replace(/[\d.,\s]/g, '') || code
  } catch {
    return code
  }
}

const currencies = computed(() =>
  CURRENCY_OPTIONS.map(opt => ({
    code: opt.value as CurrencyCode,
    name: currencyNames.of(opt.value) || opt.label,
    symbol: getCurrencySymbol(opt.value),
  })),
)

const filteredCurrencies = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return currencies.value
  return currencies.value.filter(c =>
    c.name.toLowerCase().includes(q)
    || c.code.toLowerCase().includes(q)
    || c.symbol.toLowerCase().includes(q),
  )
})
</script>
