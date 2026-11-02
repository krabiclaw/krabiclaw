import { isChoiceQuestionType, type FormQuestion, type FormQuestionType } from '~/shared/form-questions'

/** A question as the editor sends it: a new question or choice has no ID yet, and the writer gives it one. */
export type FormQuestionWrite = Omit<FormQuestion, 'id' | 'choices'> & { id?: string; choices: Array<{ id?: string; label: string }> }

export const FORM_QUESTION_TYPE_LABELS: Record<FormQuestionType, { label: string; icon: string }> = {
  short_text: { label: 'Short answer', icon: 'i-lucide-text-cursor-input' },
  long_text: { label: 'Paragraph', icon: 'i-lucide-align-left' },
  single_choice: { label: 'One choice', icon: 'i-lucide-circle-dot' },
  multiple_choice: { label: 'Any of several', icon: 'i-lucide-list-checks' },
  yes_no: { label: 'Yes or no', icon: 'i-lucide-toggle-right' },
}

/** The index row's preview of a whole form: "4 questions · 3 required". */
export function formQuestionsSummary(questions: readonly FormQuestion[]): string {
  if (!questions.length) return 'No questions'
  const required = questions.filter(question => question.required).length
  return `${questions.length} ${questions.length === 1 ? 'question' : 'questions'}${required ? ` · ${required} required` : ''}`
}

/** How a guest answers one question, as its rows preview it: "One choice from 4". */
export function formQuestionAnswerSummary(question: Pick<FormQuestion, 'type' | 'choices'>): string {
  if (question.type === 'single_choice') return `One choice from ${question.choices.length}`
  if (question.type === 'multiple_choice') return `Any of ${question.choices.length}`
  return FORM_QUESTION_TYPE_LABELS[question.type].label
}

export function formQuestionRowSummary(question: FormQuestion): string {
  return `${formQuestionAnswerSummary(question)} · ${question.required ? 'Required' : 'Optional'}`
}

/** One option as the editor holds it: `key` keeps its row while it is renamed; `id` is the saved choice it edits. */
export interface FormQuestionChoiceDraft { key: string; id?: string; label: string }

/** One question as a screen edits it, before it is written. */
export interface FormQuestionDraft { id?: string; label: string; help_text: string; type: FormQuestionType; required: boolean; choices: FormQuestionChoiceDraft[] }

export function formQuestionDraft(question?: FormQuestion): FormQuestionDraft {
  if (!question) return { label: '', help_text: '', type: 'short_text', required: false, choices: [] }
  return { id: question.id, label: question.label, help_text: question.help_text ?? '', type: question.type, required: question.required, choices: question.choices.map(choice => ({ key: choice.id, id: choice.id, label: choice.label })) }
}

/** What stops a draft being saved, in the words its screen shows; null when it can be. */
export function formQuestionDraftProblem(draft: FormQuestionDraft): string | null {
  if (!draft.label.trim()) return 'Enter the question.'
  if (isChoiceQuestionType(draft.type)) {
    if (draft.choices.some(choice => !choice.label.trim())) return 'Name each option, or remove it.'
    if (draft.choices.length < 2) return 'Add at least two options.'
  }
  return null
}

export function formQuestionFromDraft(draft: FormQuestionDraft): FormQuestionWrite {
  return {
    ...(draft.id ? { id: draft.id } : {}),
    label: draft.label.trim(), help_text: draft.help_text.trim() || null, type: draft.type, required: draft.required,
    choices: isChoiceQuestionType(draft.type) ? draft.choices.map(choice => ({ ...(choice.id ? { id: choice.id } : {}), label: choice.label.trim() })) : [],
  }
}

/** Another form's question as a new one here: the writer gives it and its options IDs of their own. */
export function formQuestionCopy(question: FormQuestion): FormQuestionWrite {
  return { label: question.label, help_text: question.help_text, type: question.type, required: question.required, choices: question.choices.map(choice => ({ label: choice.label })) }
}
