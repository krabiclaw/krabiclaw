<template>
  <!-- A question's essentials together, so one is never saved half-made. -->
  <DashboardLeafPanel id="form-question-new" title="New question" save-label="Add" :saving="saving" :disabled="Boolean(problem)" :error="owner.error.value ?? saveError ?? (draft.label ? problem : null) ?? ''" @cancel="clear" @save="add">
    <div class="space-y-8">
      <UFormField label="Question" :hint="`${FORM_QUESTION_LIMITS.label - draft.label.length}/${FORM_QUESTION_LIMITS.label} available`">
        <UInput v-model="draft.label" :maxlength="FORM_QUESTION_LIMITS.label" class="w-full" :disabled="saving" />
      </UFormField>
      <FormQuestionAnswerFields v-model:type="draft.type" v-model:choices="draft.choices" :disabled="saving" />
      <SettingRow v-model="draft.required" label="Required" :description="owner.requiredDescription" :disabled="saving" />
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import FormQuestionAnswerFields from '~/components/dashboard/FormQuestionAnswerFields.vue'
import SettingRow from '~/components/dashboard/SettingRow.vue'
import { useFormQuestionsOwner } from '~/composables/useFormQuestionsOwner'
import { FORM_QUESTION_LIMITS } from '~/shared/form-questions'
import { formQuestionDraft, formQuestionDraftProblem, formQuestionFromDraft, type FormQuestionDraft } from '~/utils/form-question-editing'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })
const owner = await useFormQuestionsOwner()
const level = useRouteLevel()
// The draft belongs to this form until it is added or dismissed.
const draft = useState<FormQuestionDraft>(`form-question-new:${owner.key}`, () => formQuestionDraft())
const saving = ref(false)
const saveError = ref<string | null>(null)
const problem = computed(() => formQuestionDraftProblem(draft.value))
function clear() { draft.value = formQuestionDraft(); saveError.value = null }

async function add() {
  if (saving.value || problem.value || !owner.questions.value) return
  saving.value = true
  saveError.value = null
  try {
    await owner.write([...owner.questions.value, formQuestionFromDraft(draft.value)])
  } catch (error) {
    saveError.value = getErrorMessage(error, 'The question could not be added')
    saving.value = false
    return
  }
  clear()
  saving.value = false
  await navigateTo(level.to.value ?? '/', { replace: true })
}
</script>
