<template>
  <!--
    A form's questions, in the order they are asked. These files are mounted
    beneath every record that holds a form (build/form-question-routes.ts); the
    owner says which record they edit and how it is written.
  -->
  <DashboardIndexPanel id="form-questions" :title="owner.title" :lead="editing ? 'Move questions up or down. The new order is saved when you tap Done.' : owner.lead">
    <UAlert v-if="owner.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="owner.error.value" />
    <template v-else-if="owner.questions.value">
      <UAlert v-if="saveError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="saveError" />
      <DashboardListEditor
        :editing="editing"
        :items="rows"
        title="Questions"
        empty-title="No questions yet"
        empty-icon="i-lucide-message-square-text"
        add-label="Add a question"
        :add-to="`${level.path.value}/new`"
        :addable="!editing && owner.questions.value.length < FORM_QUESTION_LIMITS.questions"
        :disabled="saving"
        reorderable
        @update:editing="setEditing"
        @remove="remove"
        @move="move"
      >
        <template #actions>
          <UButton v-if="editing" label="Cancel" color="neutral" variant="soft" :disabled="saving" @click="cancelEditing" />
          <template v-else>
            <UButton v-if="owner.localization.value && owner.questions.value.length" icon="i-lucide-languages" aria-label="Translate questions" color="neutral" variant="soft" square :to="translationsPath" />
            <UButton label="Copy" icon="i-lucide-copy" color="neutral" variant="soft" :disabled="saving" data-testid="form-questions-copy" @click="copying = true" />
          </template>
        </template>
      </DashboardListEditor>
      <FormQuestionsCopySheet v-model:open="copying" :owner="owner" />
      <!-- The questions' wording in the site's other languages; what they ask and accept is not translated. -->
      <DashboardResourceLocalization
        v-if="owner.localization.value"
        row-trigger
        :organization-id="owner.localization.value.organizationId"
        :resource-type="owner.localization.value.resourceType"
        :resource-id="owner.localization.value.resourceId"
        :resource-label="owner.localization.value.label"
        :fields="localizationFields"
        :language-settings-path="`/dashboard/${route.params.orgSlug}/website/localization`"
      />
    </template>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import DashboardListEditor from '~/components/dashboard/DashboardListEditor.vue'
import DashboardResourceLocalization from '~/components/dashboard/DashboardResourceLocalization.vue'
import FormQuestionsCopySheet from '~/components/dashboard/FormQuestionsCopySheet.vue'
import { useFormQuestionsOwner } from '~/composables/useFormQuestionsOwner'
import { FORM_QUESTION_LIMITS, type FormQuestion } from '~/shared/form-questions'
import { formQuestionRowSummary } from '~/utils/form-question-editing'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })
const owner = await useFormQuestionsOwner()
const level = useRouteLevel()
const route = useRoute()
const router = useRouter()
const editing = ref(false)
const saving = ref(false)
const saveError = ref<string | null>(null)
const copying = ref(false)
// Edit is a mode with its own draft: moves and removals land together on Done.
const draft = ref<FormQuestion[] | null>(null)
const shown = computed(() => draft.value ?? owner.questions.value ?? [])
const rows = computed(() => shown.value.map(question => ({
  id: question.id, title: question.label, summary: formQuestionRowSummary(question),
  to: editing.value ? undefined : router.resolve({ path: `${level.path.value}/${question.id}`, query: route.query }).fullPath,
})))

const translationsPath = computed(() => router.resolve({ path: level.path.value, query: { ...route.query, editMode: 'translations' } }).fullPath)
const localizationFields = computed(() => {
  const field = owner.localization.value?.field
  if (!field) return []
  return (owner.questions.value ?? []).flatMap(question => [
    { key: `${field}.${question.id}.label`, label: question.label, source: question.label },
    ...(question.help_text ? [{ key: `${field}.${question.id}.help_text`, label: `${question.label} · Help text`, source: question.help_text, multiline: true }] : []),
    ...question.choices.map(choice => ({ key: `${field}.${question.id}.choices.${choice.id}`, label: `${question.label} · ${choice.label}`, source: choice.label })),
  ])
})

async function setEditing(value: boolean) {
  if (saving.value) return
  if (value) { draft.value = [...owner.questions.value ?? []]; saveError.value = null; editing.value = true; return }
  const next = draft.value
  if (next && JSON.stringify(next) !== JSON.stringify(owner.questions.value)) {
    saving.value = true
    saveError.value = null
    try { await owner.write(next) } catch (error) { saveError.value = getErrorMessage(error, 'The questions could not be saved'); return } finally { saving.value = false }
  }
  draft.value = null
  editing.value = false
}
function cancelEditing() { draft.value = null; saveError.value = null; editing.value = false }
function remove(item: { id: string }) {
  if (draft.value) draft.value = draft.value.filter(question => question.id !== item.id)
}
function move(item: { id: string }, direction: -1 | 1) {
  if (!draft.value) return
  const from = draft.value.findIndex(question => question.id === item.id)
  const to = from + direction
  if (from === -1 || to < 0 || to >= draft.value.length) return
  const next = [...draft.value]
  ;[next[from], next[to]] = [next[to]!, next[from]!]
  draft.value = next
}
</script>
