<template>
  <form @submit.prevent="submit" class="booking-contact-form space-y-4">
    <div>
      <label for="booking-name" class="block text-sm font-medium text-default mb-1">{{ t('saya.experience_detail.full_name') }}</label>
      <input 
        id="booking-name"
        v-model="form.name"
        type="text"
        required
        class="w-full rounded-lg border border-(--kc-field-border) bg-default px-3.5 py-2.5 text-base text-default placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary"
      />
    </div>

    <div>
      <label for="booking-email" class="block text-sm font-medium text-default mb-1">{{ t('saya.experience_detail.email_address') }}</label>
      <input 
        id="booking-email"
        v-model="form.email"
        type="email"
        required
        class="w-full rounded-lg border border-(--kc-field-border) bg-default px-3.5 py-2.5 text-base text-default placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary"
      />
    </div>

    <div>
      <label for="booking-phone" class="block text-sm font-medium text-default mb-1">{{ t('saya.experience_detail.phone_number') }} <span v-if="!phoneRequired" class="text-muted font-normal">({{ t('saya.experience_detail.optional') }})</span></label>
      <PhoneInput
        ref="phoneInput"
        id="booking-phone"
        v-model="form.phone"
        v-model:country="countryCode"
        :default-country="defaultCountry"
        :required="phoneRequired"
        :disabled="loading"
      />
    </div>

    <div>
      <label for="booking-notes" class="block text-sm font-medium text-default mb-1">{{ t('saya.experience_detail.special_requests') }} <span class="text-muted font-normal">({{ t('saya.experience_detail.optional') }})</span></label>
      <textarea 
        id="booking-notes"
        v-model="form.notes"
        rows="3"
        class="w-full rounded-lg border border-(--kc-field-border) bg-default px-3.5 py-2.5 text-base text-default placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary resize-none"
      ></textarea>
    </div>

    <div class="pt-2">
      <TenantButton type="submit" size="lg" block :loading="loading" :disabled="loading">
        {{ loading ? t('saya.experience_detail.processing') : submitText || t('saya.experience_detail.confirm_booking') }}
      </TenantButton>
    </div>
  </form>
</template>

<script setup lang="ts">
import PhoneInput from '~/components/PhoneInput.vue'
import { parsePhone, type CountryCode } from '~/utils/phone'

export interface ContactFormState {
  name: string
  email: string
  phone: string
  notes: string
}

const form = defineModel<ContactFormState>({ required: true })
const countryCode = defineModel<CountryCode | ''>('country')
const props = withDefaults(defineProps<{
  defaultCountry?: CountryCode
  loading?: boolean
  submitText?: string
  phoneRequired?: boolean
}>(), {
  loading: false,
  phoneRequired: false
})
const { t } = useI18n()
const phoneInput = ref<InstanceType<typeof PhoneInput> | null>(null)

const emit = defineEmits<{
  submit: [form: ContactFormState]
}>()

function submit() {
  if (props.loading || !phoneInput.value?.validate()) return
  const parsed = parsePhone(form.value.phone, countryCode.value ? { defaultCountry: countryCode.value } : undefined)
  emit('submit', { ...form.value, phone: parsed.e164 ?? '' })
}
</script>
