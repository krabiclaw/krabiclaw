import type { MaybeRefOrGetter, Ref } from 'vue'
import type { FormQuestion } from '~/shared/form-questions'
import type { ApiClientError } from '~/utils/api-clients'
import { changedFormQuestions, formAnswerErrors, formAnswersInput, reconcileFormAnswerDraft, type FormAnswerDraft } from '~/utils/form-answers'

/**
 * A booking form's own questions while it is open: the questions and revision
 * it was built from, what the server refused, and the review a visitor is
 * asked for when the questions changed underneath them. Session, stay and
 * table booking all keep it the same way.
 */
export function useFormQuestionState(source: MaybeRefOrGetter<{ questions: FormQuestion[]; questions_revision: string } | null>, draft: Ref<FormAnswerDraft>) {
  const { t } = useI18n()
  const questions = ref<FormQuestion[]>(toValue(source)?.questions ?? [])
  const revision = ref(toValue(source)?.questions_revision ?? '')
  const answerErrors = ref<Record<string, string>>({})
  const notice = ref('')
  watch(() => toValue(source), (next) => {
    // The same revision can be worded in another language; a form shows the wording it will snapshot.
    if (!next || next.questions_revision === revision.value && JSON.stringify(next.questions) === JSON.stringify(questions.value)) return
    draft.value = reconcileFormAnswerDraft(questions.value, next.questions, draft.value)
    questions.value = next.questions
    revision.value = next.questions_revision
  })

  /** What a submission sends: the answers by ID and the revision they answer. */
  function submission() {
    return { answers: formAnswersInput(questions.value, draft.value), questions_revision: revision.value }
  }

  /**
   * Take the server's word on a refused submission. The questions changing is
   * shown as a review with what was entered kept; a refused answer is shown
   * against its question. Returns whether the refusal was about the questions.
   */
  function handleRefusal(failure: ApiClientError): boolean {
    const changed = changedFormQuestions(failure)
    if (changed) {
      draft.value = reconcileFormAnswerDraft(questions.value, changed.questions, draft.value)
      questions.value = changed.questions
      revision.value = changed.questions_revision
      answerErrors.value = {}
      notice.value = t('forms.questions_changed')
      return true
    }
    answerErrors.value = formAnswerErrors(failure)
    return Object.keys(answerErrors.value).length > 0
  }

  function clear() {
    answerErrors.value = {}
    notice.value = ''
  }

  return { questions, revision, answerErrors, notice, submission, handleRefusal, clear }
}
export type FormQuestionState = ReturnType<typeof useFormQuestionState>
