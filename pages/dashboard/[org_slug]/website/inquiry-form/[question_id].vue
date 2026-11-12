<template>
  <!-- One question's independent decisions, each a row that opens its own leaf. -->
  <DashboardIndexPanel id="form-question" :title="question?.label ?? 'Question'" :auto-open="groups[0]?.items[0]?.to ?? null">
    <UAlert v-if="owner.error.value || removeError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="owner.error.value ?? removeError ?? ''" />
    <EditorNavigationList v-if="question" :groups="groups" :active-item="level.child.value" @act="remove" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { useFormQuestionsOwner } from '~/composables/useFormQuestionsOwner'
import { isChoiceQuestionType } from '~/shared/form-questions'
import { FORM_QUESTION_TYPE_LABELS } from '~/utils/form-question-editing'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })
const owner = await useFormQuestionsOwner()
const level = useRouteLevel()
const route = useRoute()
const router = useRouter()
const questionId = computed(() => String(route.params.question_id))
const question = computed(() => owner.questions.value?.find(candidate => candidate.id === questionId.value) ?? null)
const removeError = ref<string | null>(null)
const removing = ref(false)
const to = (concern: string) => router.resolve({ path: `${level.path.value}/${concern}`, query: route.query }).fullPath
const groups = computed<EditorNavigationGroup[]>(() => question.value ? [
  { id: 'question', items: [
    { id: 'question', label: 'Question', summary: question.value.label, to: to('question') },
    { id: 'help-text', label: 'Help text', summary: question.value.help_text ?? 'Not set', placeholder: !question.value.help_text, to: to('help-text') },
    { id: 'answers', label: 'Answers', summary: isChoiceQuestionType(question.value.type) ? `${FORM_QUESTION_TYPE_LABELS[question.value.type].label} · ${question.value.choices.map(choice => choice.label).join(', ')}` : FORM_QUESTION_TYPE_LABELS[question.value.type].label, to: to('answers') },
    { id: 'required', label: 'Required', summary: question.value.required ? owner.requiredDescription : 'Optional', to: to('required') },
  ] },
  { id: 'remove', items: [{ id: 'remove', label: 'Remove question', summary: 'Answers already given are kept', icon: 'i-lucide-trash-2', action: {} }] },
] : [])

// A question this form does not ask is not a page. Saved questions are read before this renders.
watchEffect(() => {
  if (level.mode.value === 'yield' || removing.value) return
  if (owner.questions.value && !question.value) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})

async function remove(id: string) {
  if (id !== 'remove' || !owner.questions.value || removing.value) return
  removing.value = true
  removeError.value = null
  try {
    await owner.write(owner.questions.value.filter(candidate => candidate.id !== questionId.value))
    await navigateTo(level.to.value ?? '/', { replace: true })
  } catch (error) {
    removeError.value = getErrorMessage(error, 'The question could not be removed')
    removing.value = false
  }
}
</script>
