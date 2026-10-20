<template>
  <form @submit.prevent="submit" class="booking-contact-form space-y-4">
    <div>
      <label for="booking-name" class="block text-sm font-medium text-default mb-1">{{ t('site.experience_detail.full_name') }}</label>
      <input 
        id="booking-name"
        v-model="form.name"
        type="text"
        required
        class="w-full rounded-lg border border-(--kc-field-border) bg-default px-3.5 py-2.5 text-base text-default placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary"
      />
    </div>

    <div>
      <label for="booking-email" class="block text-sm font-medium text-default mb-1">{{ t('site.experience_detail.email_address') }}</label>
      <input 
        id="booking-email"
        v-model="form.email"
        type="email"
        required
        class="w-full rounded-lg border border-(--kc-field-border) bg-default px-3.5 py-2.5 text-base text-default placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary"
      />
    </div>

    <div>
      <label for="booking-phone" class="block text-sm font-medium text-default mb-1">{{ t('site.experience_detail.phone_number') }} <span v-if="!phoneRequired" class="text-muted font-normal">({{ t('site.experience_detail.optional') }})</span></label>
      <div class="flex rounded-lg border border-(--kc-field-border) bg-default transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-inset focus-within:ring-primary">
        <div class="relative flex items-center border-r border-(--kc-field-border) shrink-0">
          <div class="flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium text-default select-none pointer-events-none">
            <span class="text-base leading-none">{{ selectedCountry ? selectedCountry.emoji : '🌐' }}</span>
            <span class="text-xs font-semibold text-muted">{{ selectedCountry ? selectedCountry.dialCode : '+' }}</span>
            <svg class="size-3 text-muted shrink-0 ml-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
            </svg>
          </div>
          <select
            v-model="countryCode"
            :aria-label="t('booking.phone_country')"
            class="absolute inset-0 size-full opacity-0 cursor-pointer"
          >
            <option value="">{{ t('booking.international') }} (+)</option>
            <option v-for="country in countries" :key="country.code" :value="country.code">{{ country.emoji }} {{ country.name }} ({{ country.dialCode }})</option>
          </select>
        </div>
        <input
          ref="phoneInput"
          id="booking-phone"
          v-model="form.phone"
          type="tel"
          autocomplete="tel"
          :placeholder="phonePlaceholder"
          :required="phoneRequired"
          class="min-w-0 flex-1 bg-transparent px-3.5 py-2.5 text-base text-default placeholder:text-muted focus:outline-none"
        />
      </div>
    </div>

    <div>
      <label for="booking-notes" class="block text-sm font-medium text-default mb-1">{{ t('site.experience_detail.special_requests') }} <span class="text-muted font-normal">({{ t('site.experience_detail.optional') }})</span></label>
      <textarea 
        id="booking-notes"
        v-model="form.notes"
        rows="3"
        class="w-full rounded-lg border border-(--kc-field-border) bg-default px-3.5 py-2.5 text-base text-default placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary resize-none"
      ></textarea>
    </div>

    <div class="pt-2">
      <TenantButton type="submit" size="lg" block :loading="loading" :disabled="loading">
        {{ loading ? t('site.experience_detail.processing') : submitText || t('site.experience_detail.confirm_booking') }}
      </TenantButton>
    </div>
  </form>
</template>

<script setup lang="ts">
import { reactive } from 'vue'
import { listPhoneCountries, parsePhone, type CountryCode } from '~/utils/phone'

export interface ContactFormState {
  name: string
  email: string
  phone: string
  notes: string
}

const props = withDefaults(defineProps<{
  initialState?: Partial<ContactFormState>
  loading?: boolean
  submitText?: string
  phoneRequired?: boolean
}>(), {
  loading: false,
  phoneRequired: false
})
const { t, locale } = useI18n()
const phoneInput = ref<HTMLInputElement | null>(null)
const countryCode = ref<CountryCode | ''>(parsePhone(props.initialState?.phone ?? '').country ?? '')
const countries = computed(() => {
  const names = new Intl.DisplayNames(locale.value, { type: 'region' })
  return listPhoneCountries().map(country => ({ ...country, name: names.of(country.code) ?? country.code })).sort((a, b) => a.name.localeCompare(b.name, locale.value))
})
const selectedCountry = computed(() => countries.value.find(c => c.code === countryCode.value) ?? null)
const phonePlaceholder = computed(() => {
  if (!selectedCountry.value) return t('site.experience_detail.phone_number')
  return selectedCountry.value.code === 'US' || selectedCountry.value.code === 'CA'
    ? '(555) 000-0000'
    : selectedCountry.value.dialCode
})

const emit = defineEmits<{
  submit: [form: ContactFormState]
}>()

const form = reactive<ContactFormState>({
  name: props.initialState?.name || '',
  email: props.initialState?.email || '',
  phone: props.initialState?.phone || '',
  notes: props.initialState?.notes || ''
})

watch([() => form.phone, countryCode], () => phoneInput.value?.setCustomValidity(''))
watch(() => form.phone, (newPhone) => {
  if (newPhone?.trim().startsWith('+')) {
    const parsed = parsePhone(newPhone)
    if (parsed.country && parsed.country !== countryCode.value) {
      countryCode.value = parsed.country
    }
  }
})
function submit() {
  const parsed = parsePhone(form.phone, countryCode.value ? { defaultCountry: countryCode.value } : undefined)
  if (form.phone && (!parsed.valid || !parsed.e164)) {
    phoneInput.value?.setCustomValidity(t('booking.invalid_phone'))
    phoneInput.value?.reportValidity()
    return
  }
  emit('submit', { ...form, phone: parsed.e164 ?? '' })
}
</script>
