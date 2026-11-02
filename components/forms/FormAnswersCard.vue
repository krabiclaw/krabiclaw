<template>
  <!-- What the guest answered to the business's own questions, in the wording they read. -->
  <UCard v-if="answers.length" variant="record" data-testid="form-answers">
    <h3 class="text-base font-semibold text-highlighted">{{ title ?? 'Answers' }}</h3>
    <dl class="mt-4 space-y-4">
      <div v-for="answer in answers" :key="answer.question_id">
        <dt class="text-sm text-muted">{{ answer.label }}</dt>
        <dd class="mt-1 whitespace-pre-wrap break-words text-base text-highlighted">{{ formatFormAnswer(answer, { yes: 'Yes', no: 'No' }) }}</dd>
      </div>
    </dl>
  </UCard>
</template>

<script setup lang="ts">
import { formatFormAnswer, type FormAnswerSnapshot } from '~/shared/form-questions'

defineProps<{ answers: readonly FormAnswerSnapshot[]; title?: string }>()
</script>
