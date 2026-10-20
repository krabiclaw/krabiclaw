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
      <PhoneInput
        id="booking-phone"
        v-model="form.phone"
        v-model:country="form.phoneCountry"
        :default-country="defaultCountry"
        :required="phoneRequired"
        :disabled="loading"
      />
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
import PhoneInput from '~/components/PhoneInput.vue'
import type { CountryCode } from '~/utils/phone'

export interface ContactFormState {
  name: string
  email: string
  /** E.164, or empty when no number was given. */
  phone: string
  /** The country the guest chose for the phone field; the location's is the default. */
  phoneCountry?: CountryCode
  notes: string
}

const form = defineModel<ContactFormState>({ required: true })
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

const emit = defineEmits<{
  submit: [form: ContactFormState]
}>()

// The browser refuses to submit while the phone field is invalid, so a form
// that reaches here carries E.164 or no number.
function submit() {
  if (props.loading) return
  emit('submit', { ...form.value })
}
</script>
