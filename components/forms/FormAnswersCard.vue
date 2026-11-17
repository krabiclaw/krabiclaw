<template>
  <!-- What the guest answered to the business's own questions, in the wording they read. -->
  <div v-if="answers.length" class="mt-5" data-testid="form-answers">
    <h3 class="text-sm font-semibold text-highlighted">{{ title ?? 'Answers' }}</h3>
    <dl class="mt-2 space-y-3">
      <div v-for="answer in answers" :key="answer.question_id">
        <dt class="text-sm text-muted">{{ answer.label }}</dt>
        <dd class="mt-1 whitespace-pre-wrap break-words text-sm text-highlighted">{{ formatFormAnswer(answer, { yes: 'Yes', no: 'No' }) }}</dd>
      </div>
    </dl>
  </div>
</template>

<script setup lang="ts">
import { formatFormAnswer, type FormAnswerSnapshot } from '~/shared/form-questions'

defineProps<{ answers: readonly FormAnswerSnapshot[]; title?: string }>()
</script>
