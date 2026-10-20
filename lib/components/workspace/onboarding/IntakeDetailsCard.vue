<template>
  <div class="onboarding-intake-card">
      <div class="grid gap-4">
        <template v-if="section === 'location'">
          <UFormField label="Street address" :required="requireLocationBasics">
            <UInput v-model="form.streetAddress" class="w-full" placeholder="123 Main Street" />
          </UFormField>
          <UFormField label="Unit, floor, or neighborhood">
            <UInput v-model="form.addressLine2" class="w-full" placeholder="Suite, building, landmark" />
          </UFormField>
          <div class="@container">
            <div class="grid gap-4 @sm:grid-cols-2">
              <UFormField label="City or town" :required="requireLocationBasics">
                <UInput v-model="form.city" class="w-full" placeholder="City" />
              </UFormField>
              <UFormField label="Province or region">
                <UInput v-model="form.region" class="w-full" placeholder="State or province" />
              </UFormField>
              <UFormField label="Postal code">
                <UInput v-model="form.postalCode" class="w-full" inputmode="numeric" placeholder="ZIP or postal code" />
              </UFormField>
              <UFormField label="Country">
                <USelectMenu
                  v-model="countryCode"
                  :items="countries"
                  value-key="code"
                  label-key="name"
                  class="w-full"
                  placeholder="Select country"
                  :search-input="{ placeholder: 'Search country...', icon: 'i-lucide-search' }"
                  :filter-fields="['name', 'code', 'dialCode']"
                >
                  <template #leading>
                    <span v-if="country" class="flex size-5 items-center text-lg">{{ country.emoji }}</span>
                  </template>
                  <template #item-leading="{ item }">
                    <span class="flex size-5 items-center text-lg">{{ item.emoji }}</span>
                  </template>
                </USelectMenu>
              </UFormField>
            </div>
          </div>
        </template>
        <UFormField v-if="section === 'contact'" label="Phone" :required="requireLocationBasics">
          <PhoneInput id="onboarding-phone" v-model="form.phone" :default-country="countryCode" :required="requireLocationBasics" />
        </UFormField>
        <UFormField v-if="section === 'currency'" label="Currency" required>
          <USelectMenu
            :model-value="form.currency ?? undefined"
            class="w-full"
            :items="currencyOptions"
            value-key="value"
            label-key="label"
            placeholder="Select currency"
            @update:model-value="selectCurrency"
          />
        </UFormField>
      </div>

      <div v-if="actionLabel" class="grid gap-3">
        <UButton
          block
          :loading="loading"
          :disabled="disabled || !canSubmit"
          @click="$emit('submit')"
        >
          {{ actionLabel }}
        </UButton>
      </div>
  </div>
</template>

<script setup lang="ts">
import PhoneInput from '~/components/PhoneInput.vue'
import { getPhoneCountry, listPhoneCountries, toE164, type CountryCode } from '~/utils/phone'
import { CURRENCY_OPTIONS, type CurrencyCode } from '~/shared/currencies'

type IntakeForm = {
  name: string
  city: string
  streetAddress: string
  addressLine2: string
  region: string
  postalCode: string
  /** ISO 3166-1 alpha-2 code from `listPhoneCountries()`, or '' until the owner picks one. */
  country: string
  phone: string
  currency: CurrencyCode | null
}

const form = defineModel<IntakeForm>('form', { required: true })

const props = defineProps<{
  /** Omitted when the surface around the card owns the commit control. */
  actionLabel?: string
  requireLocationBasics: boolean
  section: 'location' | 'contact' | 'currency'
  loading?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{ submit: [] }>()

const currencyOptions = CURRENCY_OPTIONS
const countries = listPhoneCountries()

// One country for the whole intake: the Location step names it, it is what the
// Currency step proposes from, and it is the country the Contact step reads a
// national phone number in. Nothing seeds it but the owner or the Google place.
const countryCode = computed<CountryCode | undefined>({
  get: () => getPhoneCountry(form.value.country)?.code,
  set: (value) => { form.value.country = value ? value : '' },
})
const country = computed(() => getPhoneCountry(countryCode.value))

const canSubmit = computed(() => {
  if (props.section === 'currency') return !!form.value.currency
  if (props.section === 'contact' && form.value.phone && !toE164(form.value.phone)) return false
  if (!props.requireLocationBasics) return true
  if (props.section === 'location') {
    return [form.value.streetAddress, form.value.city].every(value => value.trim().length > 0)
  }
  return toE164(form.value.phone) !== null
})

// "No answer" is null everywhere it is stored or sent; the select spells the
// same state undefined. This is the one place the two meet.
function selectCurrency(value: CurrencyCode | undefined) {
  form.value.currency = value ?? null
  if (props.section !== 'currency' || !value) return
  nextTick(() => emit('submit'))
}
</script>

<style scoped>
.onboarding-intake-card {
  display: grid;
  gap: 1rem;
}

.onboarding-intake-card :deep(.rounded-md),
.onboarding-intake-card :deep(.rounded-lg) {
  border-radius: 14px;
}

.onboarding-intake-card :deep(label) {
  color: var(--ui-text-muted);
  font-size: 0.76rem;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
}
</style>
