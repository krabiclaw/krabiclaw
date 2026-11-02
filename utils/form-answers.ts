import { isChoiceQuestionType, type FormAnswerInput, type FormQuestion } from '~/shared/form-questions'
import type { ApiClientError } from '~/utils/api-clients'
import { isRecord } from '~/utils/api-clients'

/** What a visitor has entered so far, by question ID; a value is kept until they submit. */
export type FormAnswerDraft = Record<string, string | string[] | boolean | null | undefined>

/** The questions a form is built from, and the revision it sends back with its answers. */
export interface FormQuestionSet { questions: FormQuestion[]; questions_revision: string }

/** The draft as a submission sends it: answered questions only, by ID. */
export function formAnswersInput(questions: readonly FormQuestion[], draft: FormAnswerDraft): FormAnswerInput[] {
  return questions.flatMap((question): FormAnswerInput[] => {
    const value = draft[question.id]
    if (typeof value === 'boolean') return question.type === 'yes_no' ? [{ question_id: question.id, value }] : []
    if (typeof value === 'string') return value.trim() ? [{ question_id: question.id, value: value.trim() }] : []
    if (Array.isArray(value)) return value.length ? [{ question_id: question.id, value }] : []
    return []
  })
}

/** Required questions the visitor has not answered yet, as messages by question ID. */
export function unansweredRequired(questions: readonly FormQuestion[], draft: FormAnswerDraft, message: string): Record<string, string> {
  const answered = new Set(formAnswersInput(questions, draft).map(answer => answer.question_id))
  return Object.fromEntries(questions.filter(question => question.required && !answered.has(question.id)).map(question => [question.id, message]))
}

/**
 * The draft for a form whose questions changed while it was open. A value the
 * visitor entered stays where its question still asks the same kind of thing
 * and its choices still exist; everything else is shown again unanswered, so
 * they review it rather than submit what no longer applies.
 */
export function reconcileFormAnswerDraft(previous: readonly FormQuestion[], next: readonly FormQuestion[], draft: FormAnswerDraft): FormAnswerDraft {
  const before = new Map(previous.map(question => [question.id, question]))
  return Object.fromEntries(next.flatMap((question) => {
    const old = before.get(question.id)
    const value = draft[question.id]
    if (!old || old.type !== question.type || value === undefined || value === null) return []
    if (isChoiceQuestionType(question.type)) {
      const ids = new Set(question.choices.map(choice => choice.id))
      const kept = (Array.isArray(value) ? value : [value]).filter((id): id is string => typeof id === 'string' && ids.has(id))
      if (!kept.length) return []
      return [[question.id, question.type === 'multiple_choice' ? kept : kept[0]!]]
    }
    return [[question.id, value]]
  }))
}

/** A refusal saying the form's questions changed, with the current ones to review against. */
export function changedFormQuestions(error: ApiClientError): FormQuestionSet | null {
  if (error.code !== 'questions_changed') return null
  const data = isRecord(error.data) && isRecord(error.data.data) ? error.data.data : error.data
  if (!isRecord(data) || !Array.isArray(data.questions) || typeof data.questions_revision !== 'string') return null
  return { questions: data.questions as FormQuestion[], questions_revision: data.questions_revision }
}

/** The server's per-question refusals, as messages by question ID. */
export function formAnswerErrors(error: ApiClientError): Record<string, string> {
  if (error.code !== 'invalid_answers') return {}
  const data = isRecord(error.data) && isRecord(error.data.data) ? error.data.data : error.data
  if (!isRecord(data) || !Array.isArray(data.answer_errors)) return {}
  return Object.fromEntries(data.answer_errors.flatMap(entry => isRecord(entry) && typeof entry.question_id === 'string' && typeof entry.message === 'string' ? [[entry.question_id, entry.message]] : []))
}
