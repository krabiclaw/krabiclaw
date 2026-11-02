<template>
  <!--
    A tenant's own questions, drawn with the site's own field styling beside the
    platform's required fields. Every inquiry, reservation, booking and stay form
    renders them through this one component.
  -->
  <div v-if="questions.length" class="space-y-5">
    <div v-for="question in questions" :key="question.id" :data-question-id="question.id">
      <fieldset v-if="question.type === 'single_choice' || question.type === 'multiple_choice' || question.type === 'yes_no'" :aria-describedby="describedBy(question)" :aria-invalid="Boolean(errors[question.id])">
        <legend class="mb-1.5 block text-sm font-medium text-default">
          {{ question.label }}<span v-if="question.required" aria-hidden="true" class="ml-0.5 text-red-500">*</span>
          <span v-else class="font-normal text-muted"> ({{ t('forms.optional') }})</span>
        </legend>
        <p v-if="question.help_text" :id="helpId(question)" class="mb-2 text-xs text-muted">{{ question.help_text }}</p>
        <div class="flex flex-wrap gap-2">
          <label
            v-for="choice in choicesOf(question)"
            :key="choice.id"
            class="inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3.5 py-2 text-sm"
            :class="selected(question, choice.id) ? 'border-inverted bg-muted text-highlighted' : 'border-(--kc-field-border) text-default'"
          >
            <input
              :type="question.type === 'multiple_choice' ? 'checkbox' : 'radio'"
              :name="`${groupId}-${question.id}`"
              :value="choice.id"
              :checked="selected(question, choice.id)"
              :required="question.required && question.type !== 'multiple_choice'"
              :disabled="disabled"
              class="size-4 accent-current"
              @change="choose(question, choice.id, ($event.target as HTMLInputElement).checked)"
            >
            <span>{{ choice.label }}</span>
          </label>
        </div>
      </fieldset>
      <template v-else>
        <label :for="`${groupId}-${question.id}`" class="mb-1.5 block text-sm font-medium text-default">
          {{ question.label }}<span v-if="question.required" aria-hidden="true" class="ml-0.5 text-red-500">*</span>
          <span v-else class="font-normal text-muted"> ({{ t('forms.optional') }})</span>
        </label>
        <p v-if="question.help_text" :id="helpId(question)" class="mb-2 text-xs text-muted">{{ question.help_text }}</p>
        <textarea
          v-if="question.type === 'long_text'"
          :id="`${groupId}-${question.id}`"
          :value="textOf(question)"
          :required="question.required"
          :maxlength="FORM_QUESTION_LIMITS.longText"
          :disabled="disabled"
          rows="4"
          :aria-describedby="describedBy(question)"
          :aria-invalid="Boolean(errors[question.id])"
          :class="[FORM_INPUT_CLASS, 'resize-y']"
          @input="answers[question.id] = ($event.target as HTMLTextAreaElement).value"
        />
        <input
          v-else
          :id="`${groupId}-${question.id}`"
          :value="textOf(question)"
          type="text"
          :required="question.required"
          :maxlength="FORM_QUESTION_LIMITS.shortText"
          :disabled="disabled"
          :aria-describedby="describedBy(question)"
          :aria-invalid="Boolean(errors[question.id])"
          :class="FORM_INPUT_CLASS"
          @input="answers[question.id] = ($event.target as HTMLInputElement).value"
        >
      </template>
      <p v-if="errors[question.id]" :id="errorId(question)" class="mt-1.5 text-xs text-red-500" role="alert">{{ errors[question.id] }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { FORM_INPUT_CLASS } from '~/utils/form-constants'
import { FORM_QUESTION_LIMITS, type FormQuestion } from '~/shared/form-questions'
import type { FormAnswerDraft } from '~/utils/form-answers'

const props = withDefaults(defineProps<{
  questions: readonly FormQuestion[]
  /** Messages by question ID: the server's refusal, or the form's own check. */
  errors?: Record<string, string | undefined>
  disabled?: boolean
}>(), { errors: () => ({}), disabled: false })
const answers = defineModel<FormAnswerDraft>({ required: true })
const { t } = useI18n()
const groupId = useId()

function choicesOf(question: FormQuestion) {
  return question.type === 'yes_no' ? [{ id: 'yes', label: t('forms.yes') }, { id: 'no', label: t('forms.no') }] : question.choices
}
function selected(question: FormQuestion, choiceId: string): boolean {
  const value = answers.value[question.id]
  if (question.type === 'yes_no') return value === (choiceId === 'yes')
  if (question.type === 'multiple_choice') return Array.isArray(value) && value.includes(choiceId)
  return value === choiceId
}
function choose(question: FormQuestion, choiceId: string, checked: boolean) {
  if (question.type === 'yes_no') answers.value[question.id] = choiceId === 'yes'
  else if (question.type === 'single_choice') answers.value[question.id] = choiceId
  else {
    const current = Array.isArray(answers.value[question.id]) ? answers.value[question.id] as string[] : []
    answers.value[question.id] = checked ? [...new Set([...current, choiceId])] : current.filter(id => id !== choiceId)
  }
}
function textOf(question: FormQuestion): string {
  const value = answers.value[question.id]
  return typeof value === 'string' ? value : ''
}
const helpId = (question: FormQuestion) => `${groupId}-${question.id}-help`
const errorId = (question: FormQuestion) => `${groupId}-${question.id}-error`
function describedBy(question: FormQuestion): string | undefined {
  return [question.help_text ? helpId(question) : null, props.errors[question.id] ? errorId(question) : null].filter(Boolean).join(' ') || undefined
}
</script>
