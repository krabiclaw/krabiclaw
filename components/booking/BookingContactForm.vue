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

    <p v-if="questionsNotice" role="status" class="rounded-lg border border-default bg-muted p-3 text-sm text-highlighted" data-testid="booking-questions-notice">{{ questionsNotice }}</p>
    <FormQuestionFields v-model="form.answers" :questions="questions" :errors="{ ...localAnswerErrors, ...answerErrors }" :disabled="loading" />

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
import FormQuestionFields from '~/components/forms/FormQuestionFields.vue'
import type { CountryCode } from '~/utils/phone'
import type { FormQuestion } from '~/shared/form-questions'
import { unansweredRequired, type FormAnswerDraft } from '~/utils/form-answers'

export interface ContactFormState {
  name: string
  email: string
  /** E.164, or empty when no number was given. */
  phone: string
  /** The country the guest chose for the phone field; the location's is the default. */
  phoneCountry?: CountryCode
  notes: string
  /** Answers to the offering's, location's or home's own questions, by question ID. */
  answers: FormAnswerDraft
}

const form = defineModel<ContactFormState>({ required: true })
const props = withDefaults(defineProps<{
  defaultCountry?: CountryCode
  loading?: boolean
  submitText?: string
  phoneRequired?: boolean
  /** The tenant's own questions for this booking, in the visitor's language. */
  questions?: readonly FormQuestion[]
  /** Messages by question ID, from the server's refusal. */
  answerErrors?: Record<string, string>
  /** Said when the questions changed while the form was open. */
  questionsNotice?: string
}>(), {
  loading: false,
  phoneRequired: false,
  questions: () => [],
  answerErrors: () => ({}),
  questionsNotice: '',
})
const { t } = useI18n()

const emit = defineEmits<{
  submit: [form: ContactFormState]
}>()

// The browser refuses to submit while the phone field is invalid, so a form
// that reaches here carries E.164 or no number.
const localAnswerErrors = ref<Record<string, string>>({})
function submit() {
  if (props.loading) return
  // The browser checks text and single choices; a required set of checkboxes is checked here.
  localAnswerErrors.value = unansweredRequired(props.questions, form.value.answers, t('forms.answer_required'))
  const first = props.questions.find(question => Object.hasOwn(localAnswerErrors.value, question.id))
  if (first) {
    document.querySelector<HTMLElement>(`[data-question-id="${first.id}"] input, [data-question-id="${first.id}"] textarea`)?.focus()
    return
  }
  emit('submit', { ...form.value })
}
</script>
