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
        <UFormField
          v-if="section === 'contact'"
          label="Phone"
          :required="requireLocationBasics"
          :error="phoneError"
        >
          <UFieldGroup class="w-full gap-2">
            <USelectMenu
              v-model="countryCode"
              :items="countries"
              value-key="code"
              :search-input="{ placeholder: 'Search country...', icon: 'i-lucide-search' }"
              :filter-fields="['name', 'code', 'dialCode']"
              :content="{ align: 'start' }"
              class="shrink-0"
              :ui="{
                base: 'w-[6.5rem] justify-between pe-8',
                content: 'w-48',
                placeholder: 'hidden',
                trailingIcon: 'size-4',
              }"
              trailing-icon="i-lucide-chevrons-up-down"
            >
              <span class="flex min-w-0 items-center gap-2">
                <span v-if="country" class="flex size-5 items-center text-lg">{{ country.emoji }}</span>
                <span class="truncate text-sm font-semibold" :class="countryCode ? 'text-highlighted' : 'text-muted'">
                  {{ countryCode ?? 'Country' }}
                </span>
              </span>

              <template #item-leading="{ item }">
                <span class="flex size-5 items-center text-lg">
                  {{ item.emoji }}
                </span>
              </template>

              <template #item-label="{ item }">
                {{ item.name }} ({{ item.dialCode }})
              </template>
            </USelectMenu>

            <UInput
              :model-value="phone"
              class="min-w-0 flex-1"
              type="tel"
              autocomplete="tel-national"
              :disabled="!countryCode"
              :placeholder="countryCode ? 'Phone number' : 'Choose a country first'"
              @beforeinput="refusePhoneOverflow"
              @update:model-value="syncPhoneValue"
              @blur="phoneTouched = true"
            />
          </UFieldGroup>
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
import {
  exceedsPhoneLength,
  formatPhoneAsTyped,
  getPhoneCountry,
  listPhoneCountries,
  parsePhone,
  type CountryCode,
} from '~/utils/phone'
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
const phone = ref('')
const phoneTouched = ref(false)

// One country for the whole intake: the Location step's "Country" and the phone
// picker on the Contact step read and write the same `form.country`, so the
// owner answers once and the phone picker arrives seeded with that answer.
// Nothing seeds `form.country`: the owner names it on the Location step, and it
// is what the Currency step's proposal is derived from. The dial code and phone
// input stay inert while no country is set.
const countryCode = computed<CountryCode | undefined>({
  get: () => getPhoneCountry(form.value.country)?.code,
  set: (value) => {
    // Choosing a different country discards the number typed for the previous
    // one: a national number is meaningless under another dial code. It
    // happens HERE, where the picker writes, because only the picker is the
    // owner choosing. A watcher on the value could not tell that apart from
    // the parent hydrating a stored country, and cleared an imported number.
    if (props.section === 'contact' && value !== countryCode.value) {
      phone.value = ''
      form.value.phone = ''
    }
    form.value.country = value ? value : ''
  },
})
const country = computed(() => getPhoneCountry(countryCode.value))
const parsedPhone = computed(() =>
  countryCode.value
    ? parsePhone(phone.value, { defaultCountry: countryCode.value })
    : parsePhone(phone.value)
)

const digitsOf = (value: string) => value.replace(/\D/g, '')

/**
 * Refuse a keystroke that would take the number past the end of the country's
 * numbering plan. It has to happen here rather than in the change handler:
 * correcting the value afterwards leaves `phone` unchanged, Vue patches
 * nothing, and the character the owner typed stays in the field.
 */
function refusePhoneOverflow(event: InputEvent) {
  if (!countryCode.value) return
  const target = event.target as HTMLInputElement | null
  if (!target) return
  const inserted = event.data ?? (event.dataTransfer?.getData('text') || '')
  if (!inserted) return
  const start = target.selectionStart ?? target.value.length
  const end = target.selectionEnd ?? start
  const candidate = target.value.slice(0, start) + inserted + target.value.slice(end)
  if (exceedsPhoneLength(candidate, countryCode.value)) event.preventDefault()
}

function syncPhoneValue(value?: string | number) {
  if (value !== undefined) {
    let next = String(value)
    if (countryCode.value) {
      // Backspacing over a formatting character ("081 234|") would otherwise be
      // undone by the formatter re-inserting it: drop the digit before it instead.
      if (next.length < phone.value.length && digitsOf(next) === digitsOf(phone.value)) {
        let deletedAt = 0
        while (deletedAt < next.length && next[deletedAt] === phone.value[deletedAt]) deletedAt += 1
        next = next.slice(0, deletedAt).replace(/\d(?=\D*$)/, '') + next.slice(deletedAt)
      }
      next = formatPhoneAsTyped(next, countryCode.value)
    }
    phone.value = next
  }
  phoneTouched.value = true
  form.value.phone = parsedPhone.value.valid && parsedPhone.value.e164
    ? parsedPhone.value.e164
    : phone.value.trim()
}

// A stored E.164 value (imported from Google, or carried between steps) is shown
// as the owner would type it. Its country seeds `form.country` only when the
// owner has not answered the country yet; an owner's answer is never overwritten
// by imported data, and a number from another country is shown international.
watch(() => form.value.phone, value => {
  if (!value || value === parsedPhone.value.e164) return
  const parsed = parsePhone(value)
  if (parsed.valid && parsed.country && parsed.e164) {
    if (!form.value.country) form.value.country = parsed.country
    phone.value = parsed.country === countryCode.value
      ? formatPhoneAsTyped(parsed.nationalFormat ?? parsed.e164, parsed.country)
      : formatPhoneAsTyped(parsed.e164, parsed.country)
    return
  }
  phone.value = value
}, { immediate: true })

const canSubmit = computed(() => {
  if (props.section === 'currency') return !!form.value.currency
  if (props.section === 'contact' && phone.value.trim() && !parsedPhone.value.valid) return false
  if (!props.requireLocationBasics) return true
  if (props.section === 'location') {
    return [form.value.streetAddress, form.value.city].every(value => value.trim().length > 0)
  }
  return parsedPhone.value.valid
})

const phoneError = computed(() => {
  if (props.section !== 'contact' || !phoneTouched.value) return undefined
  if (!phone.value.trim()) return props.requireLocationBasics ? 'Enter a phone number.' : undefined
  if (parsedPhone.value.valid) return undefined
  return `Enter a valid ${country.value?.name ?? ''} phone number.`.replace(/\s{2,}/g, ' ')
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
