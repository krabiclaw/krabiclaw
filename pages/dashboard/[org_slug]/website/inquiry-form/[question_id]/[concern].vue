<template>
  <DashboardLeafPanel :id="`form-question-${concern}`" :title="setting.title" :lead="setting.lead" :saving="saving" :disabled="!draft || !changed || Boolean(problem)" :error="owner.error.value ?? saveError ?? (changed ? problem : null) ?? ''" @cancel="reset" @save="save">
    <template v-if="draft">
      <UFormField v-if="concern === 'question'" label="Question" :hint="`${FORM_QUESTION_LIMITS.label - draft.label.length}/${FORM_QUESTION_LIMITS.label} available`">
        <UInput v-model="draft.label" :maxlength="FORM_QUESTION_LIMITS.label" class="w-full" :disabled="saving" />
      </UFormField>
      <UFormField v-else-if="concern === 'help-text'" label="Help text" :hint="`${FORM_QUESTION_LIMITS.helpText - draft.help_text.length}/${FORM_QUESTION_LIMITS.helpText} available`">
        <UTextarea v-model="draft.help_text" :maxlength="FORM_QUESTION_LIMITS.helpText" :rows="3" autoresize class="w-full" :disabled="saving" />
      </UFormField>
      <FormQuestionAnswerFields v-else-if="concern === 'answers'" v-model:type="draft.type" v-model:choices="draft.choices" :disabled="saving" />
      <SettingRow v-else-if="concern === 'required'" v-model="draft.required" label="Required" :description="owner.requiredDescription" :disabled="saving" />
    </template>
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
const route = useRoute()
const level = useRouteLevel()
const concern = computed(() => String(route.params.concern))
const SETTINGS: Record<string, { title: string; lead: string }> = {
  'question': { title: 'Question', lead: 'What you ask, as guests will read it.' },
  'help-text': { title: 'Help text', lead: 'A line under the question that helps someone answer it.' },
  'answers': { title: 'Answers', lead: 'How guests answer this question.' },
  'required': { title: 'Required', lead: 'Whether the form can be sent without an answer.' },
}
const setting = computed(() => SETTINGS[concern.value] ?? { title: '', lead: '' })
const question = computed(() => owner.questions.value?.find(candidate => candidate.id === String(route.params.question_id)) ?? null)
const draft = ref<FormQuestionDraft | null>(null)
const saving = ref(false)
const saveError = ref<string | null>(null)
function reset() {
  draft.value = question.value ? formQuestionDraft(question.value) : null
  saveError.value = null
}
watch(question, reset, { immediate: true })
const changed = computed(() => Boolean(draft.value && question.value) && JSON.stringify(formQuestionFromDraft(draft.value!)) !== JSON.stringify(formQuestionFromDraft(formQuestionDraft(question.value!))))
const problem = computed(() => draft.value ? formQuestionDraftProblem(draft.value) : null)

watchEffect(() => {
  if (level.mode.value === 'yield') return
  if (!SETTINGS[concern.value]) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})

async function save() {
  if (!draft.value || !owner.questions.value || saving.value || problem.value) return
  saving.value = true
  saveError.value = null
  const edited = formQuestionFromDraft(draft.value)
  try {
    await owner.write(owner.questions.value.map(candidate => candidate.id === edited.id ? edited : candidate))
  } catch (error) {
    saveError.value = getErrorMessage(error, 'The question could not be saved')
  } finally {
    saving.value = false
  }
}
</script>
