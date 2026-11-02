<template>
  <!--
    The site's inquiry form: the shared contact details, the organization's own
    questions, and a message. Every page that places a contact or quote form
    renders this one, so a block, the contact page and a landing page ask the
    same questions and send them to the same inbox.
  -->
  <form class="grid gap-5" novalidate data-testid="inquiry-form" @submit.prevent="submit">
    <p v-if="notice" role="status" class="rounded-lg border border-default bg-muted p-4 text-sm text-highlighted" data-testid="inquiry-form-notice">{{ notice }}</p>
    <p v-if="submitError" role="alert" class="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-500">{{ submitError }}</p>

    <div class="grid gap-5 sm:grid-cols-2">
      <TenantFormField v-slot="{ id, describedBy, invalid }" :label="t('forms.name')" name="name" required :error="fieldErrors.name">
        <input :id="id" v-model.trim="contact.name" required maxlength="100" autocomplete="name" type="text" :class="FORM_INPUT_CLASS" :aria-describedby="describedBy" :aria-invalid="invalid" :disabled="submitting">
      </TenantFormField>
      <TenantFormField v-slot="{ id, describedBy, invalid }" :label="t('forms.email')" name="email" required :error="fieldErrors.email">
        <input :id="id" v-model.trim="contact.email" required maxlength="200" autocomplete="email" type="email" :class="FORM_INPUT_CLASS" :aria-describedby="describedBy" :aria-invalid="invalid" :disabled="submitting">
      </TenantFormField>
    </div>
    <div>
      <label :for="`${uid}-phone`" class="mb-1.5 block text-sm font-medium text-default">{{ t('forms.phone') }} <span class="font-normal text-muted">({{ t('forms.optional') }})</span></label>
      <PhoneInput :id="`${uid}-phone`" v-model="contact.phone" v-model:country="contact.phoneCountry" :disabled="submitting" />
      <p v-if="fieldErrors.phone" class="mt-1.5 text-xs text-red-500" role="alert">{{ fieldErrors.phone }}</p>
    </div>

    <TenantFormField v-if="!questions.length && subjects?.length" :label="t('site.contact_page.what_about')" name="subject">
      <div class="mt-2 flex flex-wrap gap-2">
        <button
          v-for="option in subjects"
          :key="option.key"
          type="button"
          :aria-pressed="contact.subject === option.key"
          :class="['rounded-full border px-4 py-2 text-xs font-medium uppercase tracking-widest transition', contact.subject === option.key ? 'border-inverted bg-inverted text-inverted' : 'border-default bg-default text-muted hover:border-muted hover:text-default']"
          @click="contact.subject = option.key"
        >
          {{ option.label }}
        </button>
      </div>
    </TenantFormField>

    <FormQuestionFields v-model="answers" :questions="questions" :errors="answerErrors" :disabled="submitting" />

    <TenantFormField v-slot="{ id, describedBy, invalid }" :label="questions.length ? t('forms.anything_else') : t('forms.message')" name="message" :required="!questions.length" :error="fieldErrors.message">
      <textarea :id="id" v-model="contact.message" :required="!questions.length" maxlength="2000" rows="5" :class="[FORM_INPUT_CLASS, 'resize-y']" :aria-describedby="describedBy" :aria-invalid="invalid" :disabled="submitting" />
    </TenantFormField>

    <label v-if="consentRequired" class="flex items-start gap-3 text-sm leading-6 text-muted">
      <input v-model="contact.consent" required type="checkbox" class="mt-1 size-4 rounded border-default" :disabled="submitting">
      <span>{{ t('forms.legal_consent') }}</span>
    </label>
    <p v-if="fieldErrors.consent" class="-mt-3 text-xs text-red-500" role="alert">{{ fieldErrors.consent }}</p>

    <TenantButton as="button" type="submit" :loading="submitting" :disabled="submitting || disabled" class="w-full">{{ submitting ? t('forms.sending') : submitLabel || t('forms.send') }}</TenantButton>
    <p v-if="booking" class="text-center text-sm text-muted">
      {{ t('forms.book_instead') }}
      <NuxtLink :to="booking.url" class="font-medium text-highlighted underline underline-offset-4" data-testid="inquiry-form-booking-link">{{ booking.label || t('forms.book_time') }}</NuxtLink>
    </p>
  </form>
</template>

<script setup lang="ts">
import PhoneInput from '~/components/PhoneInput.vue'
import FormQuestionFields from '~/components/forms/FormQuestionFields.vue'
import { FORM_INPUT_CLASS } from '~/utils/form-constants'
import { changedFormQuestions, formAnswerErrors, formAnswersInput, reconcileFormAnswerDraft, unansweredRequired, type FormAnswerDraft } from '~/utils/form-answers'
import { normalizeApiError } from '~/utils/api-clients'
import type { CountryCode } from '~/utils/phone'
import type { FormQuestion } from '~/shared/form-questions'
import type { SubmissionMeasurement } from '~/composables/useOrganizationConversionTracking'

const props = defineProps<{
  /** A secondary way in: the booking flow of an offering the page names. */
  booking?: { url: string; label?: string | null } | null
  /** Context the visitor arrived with, such as the product they asked about. */
  initialMessage?: string
  /** The site's message subjects, offered only when it asks no questions of its own. */
  subjects?: Array<{ key: string; label: string }>
  submitLabel?: string
  disabled?: boolean
}>()

const { t, locale, localePath } = useI18n()
const route = useRoute()
const uid = useId()
const { form } = await useInquiryForm()
const questions = ref<FormQuestion[]>(form.value?.questions ?? [])
const questionsRevision = ref(form.value?.questions_revision ?? '')
const consentRequired = computed(() => form.value?.consent_required === true)
watch(form, (next) => {
  if (!next) return
  answers.value = reconcileFormAnswerDraft(questions.value, next.questions, answers.value)
  questions.value = next.questions
  questionsRevision.value = next.questions_revision
})

const contact = reactive({ name: '', email: '', phone: '', phoneCountry: undefined as CountryCode | undefined, subject: 'general', message: props.initialMessage ?? '', consent: false })
const answers = ref<FormAnswerDraft>({})
const answerErrors = ref<Record<string, string>>({})
const fieldErrors = reactive<Record<'name' | 'email' | 'phone' | 'message' | 'consent', string | undefined>>({ name: undefined, email: undefined, phone: undefined, message: undefined, consent: undefined })
const submitting = ref(false)
const submitError = ref('')
const notice = ref('')
// One key per set of entered details: a retry of the same submission is the same inquiry.
let requestKey: string | null = null
let requestFingerprint: string | null = null
const { mirrorSubmission, pageEventId } = useOrganizationConversionTracking()

const SERVER_FIELD_MESSAGES: Record<string, () => string> = {
  NAME_REQUIRED: () => t('site.contact_page.enter_name'),
  EMAIL_INVALID: () => t('site.contact_page.invalid_email'),
  PHONE_INVALID: () => t('booking.invalid_phone'),
  MESSAGE_REQUIRED: () => t('forms.message_too_short'),
  CONSENT_REQUIRED: () => t('forms.answer_required'),
}

function validate(): boolean {
  // The phone is checked by the server alone; its refusal stands only until the next attempt.
  fieldErrors.phone = undefined
  fieldErrors.name = contact.name ? undefined : t('site.contact_page.enter_name')
  fieldErrors.email = !contact.email ? t('site.contact_page.enter_email') : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email) ? undefined : t('site.contact_page.invalid_email')
  const written = props.initialMessage && contact.message.startsWith(props.initialMessage) ? contact.message.slice(props.initialMessage.length) : contact.message
  // Without questions the message is the inquiry, and the server needs a sentence of it.
  fieldErrors.message = questions.value.length ? undefined : !written.trim() ? t('site.contact_page.enter_message') : written.trim().length < 10 ? t('forms.message_too_short') : undefined
  fieldErrors.consent = consentRequired.value && !contact.consent ? t('forms.answer_required') : undefined
  answerErrors.value = unansweredRequired(questions.value, answers.value, t('forms.answer_required'))
  return !Object.values(fieldErrors).some(Boolean) && !Object.keys(answerErrors.value).length
}

async function submit() {
  if (submitting.value || props.disabled) return
  submitError.value = ''
  if (!validate()) return
  submitting.value = true
  const body = {
    name: contact.name, email: contact.email, phone: contact.phone || undefined, message: contact.message.trim(),
    ...(!questions.value.length && props.subjects?.length ? { subject: contact.subject } : {}),
    consent: consentRequired.value ? contact.consent : undefined,
    answers: formAnswersInput(questions.value, answers.value), questions_revision: questionsRevision.value,
    locale: locale.value, page_path: route.path,
  }
  const fingerprint = JSON.stringify(body)
  if (fingerprint !== requestFingerprint) { requestKey = crypto.randomUUID(); requestFingerprint = fingerprint }
  try {
    const response = await publicApiMutation<{ success: true; measurement?: SubmissionMeasurement }>('/api/public/contact', {
      method: 'POST',
      body: { ...body, idempotency_key: requestKey, page_event_id: await pageEventId() },
      validate: (value): value is { success: true; measurement?: SubmissionMeasurement } => isRecord(value) && value.success === true,
    })
    mirrorSubmission('contact_submit', response.measurement)
    await navigateTo(localePath('/contact/confirmed'))
  } catch (error) {
    const failure = normalizeApiError(error, t('forms.send_failed'))
    const changed = changedFormQuestions(failure)
    if (changed) {
      // What they entered stays; they review it against the form as it is now.
      answers.value = reconcileFormAnswerDraft(questions.value, changed.questions, answers.value)
      questions.value = changed.questions
      questionsRevision.value = changed.questions_revision
      notice.value = t('forms.questions_changed')
      answerErrors.value = {}
    } else {
      answerErrors.value = formAnswerErrors(failure)
      // A field the server refused is marked on that field, in the visitor's language.
      const field = typeof failure.data.field === 'string' ? failure.data.field : null
      const fieldMessage = field ? SERVER_FIELD_MESSAGES[failure.code]?.() : undefined
      if (field && fieldMessage && field in fieldErrors) fieldErrors[field as keyof typeof fieldErrors] = fieldMessage
      else if (!Object.keys(answerErrors.value).length) submitError.value = failure.message
    }
  } finally {
    submitting.value = false
  }
}
</script>
