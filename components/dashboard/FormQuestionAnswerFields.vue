<template>
  <!-- How a guest answers one question: its answer type, and the options a choice offers. -->
  <div class="space-y-8">
    <URadioGroup v-model="type" :items="types" variant="card" indicator="hidden" color="neutral" :disabled="disabled" aria-label="Answer type" :ui="tileUi">
      <template #label="{ item }">
        <span class="flex flex-col gap-3">
          <UIcon :name="item.icon" class="size-8 text-highlighted" aria-hidden="true" />
          <span class="text-base font-medium text-highlighted">{{ item.label }}</span>
        </span>
      </template>
    </URadioGroup>

    <section v-if="isChoiceQuestionType(type)" aria-labelledby="form-question-options">
      <h3 id="form-question-options" class="text-base font-medium text-highlighted">Options</h3>
      <ul class="mt-2 divide-y divide-default">
        <li v-for="(choice, index) in choices" :key="choice.key" class="flex items-center gap-3 py-3">
          <UInput v-model="choice.label" :maxlength="FORM_QUESTION_LIMITS.choiceLabel" :aria-label="`Option ${index + 1}`" :disabled="disabled" class="min-w-0 flex-1" />
          <UButton label="Remove" color="neutral" variant="link" :disabled="disabled" :aria-label="`Remove ${choice.label || `option ${index + 1}`}`" @click="choices.splice(index, 1)" />
        </li>
      </ul>
      <UButton v-if="choices.length < FORM_QUESTION_LIMITS.choices" label="Add option" color="neutral" variant="link" class="mt-2 px-0 underline" :disabled="disabled" @click="choices.push({ key: crypto.randomUUID(), label: '' })" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { FORM_QUESTION_LIMITS, FORM_QUESTION_TYPES, isChoiceQuestionType, type FormQuestionType } from '~/shared/form-questions'
import { FORM_QUESTION_TYPE_LABELS, type FormQuestionChoiceDraft } from '~/utils/form-question-editing'

defineProps<{ disabled?: boolean }>()
const type = defineModel<FormQuestionType>('type', { required: true })
const choices = defineModel<FormQuestionChoiceDraft[]>('choices', { required: true })
const crypto = globalThis.crypto
const types = FORM_QUESTION_TYPES.map(value => ({ value, ...FORM_QUESTION_TYPE_LABELS[value] }))
const tileUi = { fieldset: 'grid grid-cols-2 gap-3 sm:grid-cols-3', item: 'block min-w-0 rounded-2xl p-4', wrapper: 'w-full', label: 'block w-full' }
// A choice needs two options to be one; switching to it starts with two to fill in.
watch(type, (next) => {
  if (!isChoiceQuestionType(next)) return
  while (choices.value.length < 2) choices.value.push({ key: crypto.randomUUID(), label: '' })
})
</script>
