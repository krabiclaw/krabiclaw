import { z } from 'zod'

/**
 * A tenant's own questions, asked beside the platform's required fields on an
 * inquiry, reservation, consultation, experience or stay form.
 *
 * One definition contract for every owner: the organization's inquiry
 * settings, a location's reservation policy, a product's booking setup and a
 * home's stay settings each hold one ordered collection of these. The writer
 * of each owner validates it here; submissions are checked here against the
 * collection the visitor's form was built from, and what is stored with the
 * submission is a snapshot of the wording the visitor answered, so a later
 * edit or removal never changes what an earlier answer meant.
 */

export const FORM_QUESTION_TYPES = ['short_text', 'long_text', 'single_choice', 'multiple_choice', 'yes_no'] as const
export type FormQuestionType = typeof FORM_QUESTION_TYPES[number]

export const FORM_QUESTION_LIMITS = {
  questions: 20,
  choices: 20,
  id: 64,
  label: 200,
  helpText: 500,
  choiceLabel: 120,
  shortText: 200,
  longText: 2000,
} as const

const CHOICE_TYPES: readonly FormQuestionType[] = ['single_choice', 'multiple_choice']
export function isChoiceQuestionType(type: FormQuestionType): type is 'single_choice' | 'multiple_choice' {
  return CHOICE_TYPES.includes(type)
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
const idSchema = z.string().regex(ID_PATTERN, 'IDs use lowercase letters, digits, hyphens and underscores, up to 64 characters')
const labelSchema = (max: number) => z.string().trim().min(1).max(max)

export const formQuestionChoiceSchema = z.object({ id: idSchema, label: labelSchema(FORM_QUESTION_LIMITS.choiceLabel) }).strict()

export const formQuestionSchema = z.object({
  id: idSchema,
  label: labelSchema(FORM_QUESTION_LIMITS.label),
  type: z.enum(FORM_QUESTION_TYPES),
  required: z.boolean(),
  help_text: labelSchema(FORM_QUESTION_LIMITS.helpText).nullable(),
  choices: z.array(formQuestionChoiceSchema).max(FORM_QUESTION_LIMITS.choices),
}).strict().superRefine((question, context) => {
  if (isChoiceQuestionType(question.type)) {
    if (question.choices.length < 2) context.addIssue({ code: 'custom', path: ['choices'], message: 'A choice question needs at least two choices' })
  } else if (question.choices.length > 0) {
    context.addIssue({ code: 'custom', path: ['choices'], message: 'Only choice questions have choices' })
  }
  const ids = question.choices.map(choice => choice.id)
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['choices'], message: 'Choice IDs must be unique within a question' })
})

export const formQuestionsSchema = z.array(formQuestionSchema).max(FORM_QUESTION_LIMITS.questions).superRefine((questions, context) => {
  const ids = questions.map(question => question.id)
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'Question IDs must be unique' })
})

export type FormQuestionChoice = z.infer<typeof formQuestionChoiceSchema>
export type FormQuestion = z.infer<typeof formQuestionSchema>

/** The JSON Schema of one question as an MCP tool reads or writes it. */
export function formQuestionsJsonSchema(mode: 'read' | 'write') {
  const write = mode === 'write'
  const id = { type: 'string', pattern: ID_PATTERN.source, maxLength: FORM_QUESTION_LIMITS.id }
  const choice = {
    type: 'object', additionalProperties: false,
    properties: { id: { ...id, description: write ? 'Existing choice ID to keep. Omit for a new choice; one is assigned from its label.' : 'Stable choice ID.' }, label: { type: 'string', minLength: 1, maxLength: FORM_QUESTION_LIMITS.choiceLabel } },
    required: write ? ['label'] : ['id', 'label'],
  }
  return {
    type: 'array', maxItems: FORM_QUESTION_LIMITS.questions,
    description: write
      ? 'The complete ordered question list; it replaces the saved list. Keep each existing question\'s id to preserve it. Choice questions need two or more choices; other types take none.'
      : 'Ordered tenant questions asked beside the platform\'s required fields.',
    items: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { ...id, description: write ? 'Existing question ID to keep. Omit for a new question; one is assigned from its label.' : 'Stable question ID; submissions answer by this ID.' },
        label: { type: 'string', minLength: 1, maxLength: FORM_QUESTION_LIMITS.label },
        type: { type: 'string', enum: [...FORM_QUESTION_TYPES] },
        required: { type: 'boolean' },
        help_text: { type: ['string', 'null'], maxLength: FORM_QUESTION_LIMITS.helpText },
        choices: { type: 'array', maxItems: FORM_QUESTION_LIMITS.choices, items: choice },
      },
      required: write ? ['label', 'type', 'required'] : ['id', 'label', 'type', 'required', 'help_text', 'choices'],
    },
  } as const
}

export class FormQuestionDefinitionError extends Error {
  readonly field: string
  constructor(message: string, field: string) {
    super(message)
    this.name = 'FormQuestionDefinitionError'
    this.field = field
  }
}

function slugId(label: string, prefix: string, taken: Set<string>): string {
  const base = label.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || prefix
  let candidate = /^[a-z0-9]/.test(base) ? base : `${prefix}_${base}`.slice(0, 48)
  for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${base.slice(0, 44)}_${suffix}`
  taken.add(candidate)
  return candidate
}

function issueMessage(error: z.ZodError): { message: string; field: string } {
  const issue = error.issues[0]!
  const field = ['questions', ...issue.path.map(String)].join('.')
  return { message: `${field}: ${issue.message}`, field }
}

/**
 * The saved question list a writer receives: a new question or choice without
 * an ID is given one from its label; an existing one keeps the ID it was sent
 * with. Anything else that is not a valid definition is refused whole.
 */
export function normalizeFormQuestionsInput(input: unknown): FormQuestion[] {
  if (!Array.isArray(input)) throw new FormQuestionDefinitionError('questions must be an array', 'questions')
  const questionIds = new Set(input.flatMap(item => item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' ? [(item as { id: string }).id] : []))
  const prepared = input.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    const question = { ...(item as Record<string, unknown>) }
    if (question.id === undefined && typeof question.label === 'string') question.id = slugId(question.label, 'question', questionIds)
    if (question.help_text === undefined || (typeof question.help_text === 'string' && !question.help_text.trim())) question.help_text = null
    if (question.choices === undefined) question.choices = []
    if (Array.isArray(question.choices)) {
      const choiceIds = new Set(question.choices.flatMap(choice => choice && typeof choice === 'object' && typeof (choice as { id?: unknown }).id === 'string' ? [(choice as { id: string }).id] : []))
      question.choices = question.choices.map((choice) => {
        if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return choice
        const next = { ...(choice as Record<string, unknown>) }
        if (next.id === undefined && typeof next.label === 'string') next.id = slugId(next.label, 'choice', choiceIds)
        return next
      })
    }
    return question
  })
  const parsed = formQuestionsSchema.safeParse(prepared)
  if (!parsed.success) {
    const { message, field } = issueMessage(parsed.error)
    throw new FormQuestionDefinitionError(message, field)
  }
  return parsed.data
}

/** A saved collection read back from its owner; a stored value that is not one is corrupt state, not an empty form. */
export function parseStoredFormQuestions(value: unknown): FormQuestion[] {
  const raw = typeof value === 'string' ? JSON.parse(value) as unknown : value
  return formQuestionsSchema.parse(raw)
}

function cyrb53(text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

/**
 * The revision of a question collection: a digest of the definitions, so any
 * change to a question, its order or its choices is a new revision. A form
 * carries the revision it was built from, and a submission against another is
 * the form having changed while the visitor typed.
 */
export function formQuestionsRevision(questions: readonly FormQuestion[]): string {
  return `qr_${cyrb53(JSON.stringify(questions.map(question => [question.id, question.label, question.type, question.required, question.help_text, question.choices.map(choice => [choice.id, choice.label])])))}`
}

/**
 * Translated wording for a collection, keyed by question ID and choice ID, as
 * the owner's resource localization stores it. Absent entries keep the source
 * wording; a question's meaning (type, required, choices) is never translated.
 */
export const formQuestionLocalizationSchema = z.record(idSchema, z.object({
  label: labelSchema(FORM_QUESTION_LIMITS.label).optional(),
  help_text: labelSchema(FORM_QUESTION_LIMITS.helpText).optional(),
  choices: z.record(idSchema, labelSchema(FORM_QUESTION_LIMITS.choiceLabel)).optional(),
}).strict())
export type FormQuestionLocalization = z.infer<typeof formQuestionLocalizationSchema>

export function localizeFormQuestions(questions: readonly FormQuestion[], localization: FormQuestionLocalization | null | undefined): FormQuestion[] {
  if (!localization) return [...questions]
  return questions.map((question) => {
    const translated = localization[question.id]
    if (!translated) return question
    return {
      ...question,
      label: translated.label ?? question.label,
      help_text: question.help_text === null ? null : translated.help_text ?? question.help_text,
      choices: question.choices.map(choice => ({ ...choice, label: translated.choices?.[choice.id] ?? choice.label })),
    }
  })
}

// ── Answers ─────────────────────────────────────────────────────────────────

export type FormAnswerValue = string | string[] | boolean

/** What a form or an MCP caller sends: the question's ID and its value. */
export interface FormAnswerInput { question_id: string; value: FormAnswerValue }

/** What is stored with a submission: the answer and the wording it answered. */
export const formAnswerSnapshotSchema = z.object({
  question_id: idSchema,
  label: z.string().min(1),
  type: z.enum(FORM_QUESTION_TYPES),
  help_text: z.string().nullable(),
  value: z.union([z.string(), z.array(z.string()), z.boolean()]),
  selected_choices: z.array(formQuestionChoiceSchema),
}).strict()
export const formAnswerSnapshotsSchema = z.array(formAnswerSnapshotSchema).max(FORM_QUESTION_LIMITS.questions)
export type FormAnswerSnapshot = z.infer<typeof formAnswerSnapshotSchema>

export function formAnswerSnapshotsJsonSchema() {
  const choice = { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'], additionalProperties: false }
  return {
    type: 'array',
    description: 'Answers to the tenant\'s own questions, with the wording the guest answered. Later edits to the questions do not change them.',
    items: {
      type: 'object', additionalProperties: false,
      properties: {
        question_id: { type: 'string' }, label: { type: 'string' }, type: { type: 'string', enum: [...FORM_QUESTION_TYPES] }, help_text: { type: ['string', 'null'] },
        value: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }, { type: 'boolean' }], description: 'Text, the selected choice ID, the selected choice IDs, or true/false for yes/no.' },
        selected_choices: { type: 'array', items: choice },
      },
      required: ['question_id', 'label', 'type', 'help_text', 'value', 'selected_choices'],
    },
  } as const
}

export function formAnswerInputJsonSchema() {
  return {
    type: 'array', maxItems: FORM_QUESTION_LIMITS.questions,
    description: 'Answers to the configured questions by question ID: text for short_text/long_text, a choice ID for single_choice, choice IDs for multiple_choice, true or false for yes_no. Required questions must be answered.',
    items: {
      type: 'object', additionalProperties: false,
      properties: { question_id: { type: 'string' }, value: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }, { type: 'boolean' }] } },
      required: ['question_id', 'value'],
    },
  } as const
}

export type FormAnswerErrorCode = 'unknown_question' | 'duplicate_answer' | 'invalid_type' | 'invalid_choice' | 'too_long' | 'required' | 'invalid_answers'
export interface FormAnswerError { question_id: string | null; code: FormAnswerErrorCode; message: string }

export type FormAnswerResolution = { ok: true; answers: FormAnswerSnapshot[] } | { ok: false; errors: FormAnswerError[] }

function isAnswered(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return typeof value === 'boolean'
}

/**
 * Check a submission's answers against the questions it was answering, worded
 * in the language the visitor saw, and build what is stored. Unknown
 * questions, wrong types, unknown choices, oversized text and unanswered
 * required questions are each refused by name. `false` answers a yes/no
 * question; an empty string or an empty selection does not answer anything.
 */
export function resolveFormAnswers(questions: readonly FormQuestion[], input: unknown): FormAnswerResolution {
  const errors: FormAnswerError[] = []
  if (input !== undefined && input !== null && !Array.isArray(input)) return { ok: false, errors: [{ question_id: null, code: 'invalid_answers', message: 'answers must be a list of { question_id, value }' }] }
  const entries = (input ?? []) as unknown[]
  if (entries.length > FORM_QUESTION_LIMITS.questions) return { ok: false, errors: [{ question_id: null, code: 'invalid_answers', message: `At most ${FORM_QUESTION_LIMITS.questions} answers are accepted` }] }
  const byId = new Map(questions.map(question => [question.id, question]))
  const given = new Map<string, unknown>()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof (entry as { question_id?: unknown }).question_id !== 'string') {
      errors.push({ question_id: null, code: 'invalid_answers', message: 'Each answer needs a question_id and a value' })
      continue
    }
    const { question_id: questionId, value } = entry as { question_id: string; value?: unknown }
    if (!byId.has(questionId)) { errors.push({ question_id: questionId, code: 'unknown_question', message: `Unknown question: ${questionId}` }); continue }
    if (given.has(questionId)) { errors.push({ question_id: questionId, code: 'duplicate_answer', message: `Question ${questionId} was answered twice` }); continue }
    given.set(questionId, value)
  }

  const answers: FormAnswerSnapshot[] = []
  for (const question of questions) {
    const value = given.get(question.id)
    if (!isAnswered(value)) {
      if (value !== undefined && value !== null && typeof value !== 'string' && !Array.isArray(value)) {
        errors.push({ question_id: question.id, code: 'invalid_type', message: `${question.label}: unsupported answer` })
      } else if (question.required) {
        errors.push({ question_id: question.id, code: 'required', message: `${question.label} is required` })
      }
      continue
    }
    const base = { question_id: question.id, label: question.label, type: question.type, help_text: question.help_text }
    if (question.type === 'short_text' || question.type === 'long_text') {
      if (typeof value !== 'string') { errors.push({ question_id: question.id, code: 'invalid_type', message: `${question.label} needs a text answer` }); continue }
      const text = value.trim()
      const limit = question.type === 'short_text' ? FORM_QUESTION_LIMITS.shortText : FORM_QUESTION_LIMITS.longText
      if (text.length > limit) { errors.push({ question_id: question.id, code: 'too_long', message: `${question.label} must be ${limit} characters or fewer` }); continue }
      if (question.type === 'short_text' && /[\r\n]/.test(text)) { errors.push({ question_id: question.id, code: 'invalid_type', message: `${question.label} takes one line` }); continue }
      answers.push({ ...base, value: text, selected_choices: [] })
    } else if (question.type === 'yes_no') {
      if (typeof value !== 'boolean') { errors.push({ question_id: question.id, code: 'invalid_type', message: `${question.label} needs yes or no` }); continue }
      answers.push({ ...base, value, selected_choices: [] })
    } else {
      const selected = question.type === 'single_choice' ? (typeof value === 'string' ? [value] : null) : (Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : null)
      if (!selected) { errors.push({ question_id: question.id, code: 'invalid_type', message: question.type === 'single_choice' ? `${question.label} needs one choice` : `${question.label} needs a list of choices` }); continue }
      if (new Set(selected).size !== selected.length) { errors.push({ question_id: question.id, code: 'invalid_choice', message: `${question.label}: a choice was selected twice` }); continue }
      const unknown = selected.filter(choiceId => !question.choices.some(choice => choice.id === choiceId))
      if (unknown.length) { errors.push({ question_id: question.id, code: 'invalid_choice', message: `${question.label}: unknown choice ${unknown.join(', ')}` }); continue }
      const selectedChoices = question.choices.filter(choice => selected.includes(choice.id))
      answers.push({ ...base, value: question.type === 'single_choice' ? selected[0]! : selectedChoices.map(choice => choice.id), selected_choices: selectedChoices })
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, answers }
}

/**
 * The answers a submission sent, normalized for its replay fingerprint: what
 * was answered, not how it was worded or ordered. A retry with the same key
 * and the same answers is the same submission even after the questions'
 * wording changed; changed answers are a different one.
 */
export function formAnswersFingerprint(input: unknown): Array<[string, FormAnswerValue]> {
  if (!Array.isArray(input)) return []
  return input.flatMap((entry): Array<[string, FormAnswerValue]> => {
    if (!entry || typeof entry !== 'object' || typeof (entry as { question_id?: unknown }).question_id !== 'string') return []
    const { question_id: questionId, value } = entry as { question_id: string; value?: unknown }
    if (typeof value === 'string') return value.trim() ? [[questionId, value.trim()]] : []
    if (typeof value === 'boolean') return [[questionId, value]]
    if (Array.isArray(value) && value.length && value.every(item => typeof item === 'string')) return [[questionId, [...value as string[]].sort()]]
    return []
  }).sort(([left], [right]) => left.localeCompare(right))
}

/** One answer in words, for the inbox, a booking's record and its notification. */
export function formatFormAnswer(answer: FormAnswerSnapshot, words: { yes: string; no: string }): string {
  if (answer.type === 'yes_no') return answer.value === true ? words.yes : words.no
  if (answer.type === 'single_choice' || answer.type === 'multiple_choice') return answer.selected_choices.map(choice => choice.label).join(', ')
  return String(answer.value)
}
