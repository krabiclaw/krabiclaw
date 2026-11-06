import { HTTPError } from 'nitro'
import { queryFirst, type DbClient } from '~/server/db'
import { getSourceLocale } from '~/server/utils/organization-locales'
import { isLegalPracticeSite } from '~/utils/site-routing'
import {
  FormQuestionDefinitionError,
  formQuestionLocalizationSchema,
  formQuestionsRevision,
  localizeFormQuestions,
  normalizeFormQuestionsInput,
  parseStoredFormQuestions,
  resolveFormAnswers,
  type FormAnswerSnapshot,
  type FormQuestion,
} from '~/shared/form-questions'

/**
 * Which configuration owns a question collection. Each is an existing
 * configuration record: the organization's inquiry settings, a location's
 * reservation policy, a product's booking setup and a home's stay settings.
 */
export type FormQuestionOwner =
  | { kind: 'inquiry'; organizationId: string }
  | { kind: 'reservation'; organizationId: string; locationId: string }
  | { kind: 'booking'; organizationId: string; productId: string }
  | { kind: 'stay'; organizationId: string; productId: string }

/** Where an owner's translated wording lives in its resource localization. */
export function formQuestionLocalizationField(owner: FormQuestionOwner): { resourceType: 'organization' | 'business_location' | 'product'; resourceId: string; field: string } {
  if (owner.kind === 'inquiry') return { resourceType: 'organization', resourceId: owner.organizationId, field: 'inquiry_questions' }
  if (owner.kind === 'reservation') return { resourceType: 'business_location', resourceId: owner.locationId, field: 'reservation_questions' }
  return { resourceType: 'product', resourceId: owner.productId, field: 'questions' }
}

const OWNER_QUERIES: Record<Exclude<FormQuestionOwner['kind'], 'inquiry'>, string> = {
  reservation: 'SELECT questions FROM location_reservation_configs WHERE organization_id = ? AND location_id = ?',
  booking: 'SELECT questions FROM product_booking_configs WHERE organization_id = ? AND product_id = ?',
  stay: 'SELECT questions FROM product_stay_configs WHERE organization_id = ? AND product_id = ?',
}

/** The saved collection of one explicitly named owner. An owner that does not exist is not an empty form. */
export async function readFormQuestions(db: DbClient, owner: FormQuestionOwner): Promise<FormQuestion[]> {
  if (owner.kind === 'inquiry') {
    const row = await queryFirst<{ questions: string | null }>(db, "SELECT json_extract(settings_json, '$.inquiry.questions') AS questions FROM organization WHERE id = ?", [owner.organizationId])
    if (!row) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found', data: { code: 'ORGANIZATION_NOT_FOUND' } })
    // An organization that never saved inquiry questions asks none.
    return row.questions === null ? [] : parseStoredFormQuestions(row.questions)
  }
  const row = await queryFirst<{ questions: string }>(db, OWNER_QUERIES[owner.kind], [owner.organizationId, owner.kind === 'reservation' ? owner.locationId : owner.productId])
  if (!row) throw new HTTPError({ statusCode: 404, statusMessage: owner.kind === 'reservation' ? 'Reservation policy not found' : owner.kind === 'booking' ? 'This product does not take bookings' : 'Place to stay not found', data: { code: 'FORM_QUESTIONS_OWNER_NOT_FOUND', field: owner.kind } })
  return parseStoredFormQuestions(row.questions)
}

/**
 * The collection worded in `locale`: the owner's translation where one exists,
 * its source wording otherwise. A null locale is the business's own language,
 * as a host entering a booking writes it.
 */
export async function readLocalizedFormQuestions(db: DbClient, owner: FormQuestionOwner, locale: string | null): Promise<{ questions: FormQuestion[]; questions_revision: string }> {
  const questions = await readFormQuestions(db, owner)
  const questions_revision = formQuestionsRevision(questions)
  if (!questions.length || locale === null || locale === await getSourceLocale(db, owner.organizationId)) return { questions, questions_revision }
  const { resourceType, resourceId, field } = formQuestionLocalizationField(owner)
  const row = await queryFirst<{ wording: string | null }>(db, `SELECT json_extract(values_json, '$.' || ?) AS wording FROM resource_localizations
    WHERE organization_id = ? AND resource_type = ? AND resource_id = ? AND locale = ?`, [field, owner.organizationId, resourceType, resourceId, locale])
  const localization = row?.wording ? formQuestionLocalizationSchema.parse(JSON.parse(row.wording)) : null
  return { questions: localizeFormQuestions(questions, localization), questions_revision }
}

/**
 * Accept a submission's answers for the questions of the owner it targets.
 *
 * The form says which revision it was built from. When the questions changed
 * while it was open, the submission is refused with the current questions so
 * the visitor reviews what they entered against them. Answers are validated
 * against the wording in the submission's language, which is what is stored.
 */
export async function acceptFormAnswers(db: DbClient, owner: FormQuestionOwner, input: { locale: string | null; answers: unknown; questionsRevision: unknown; revisionRequired: boolean }): Promise<FormAnswerSnapshot[]> {
  const current = await readLocalizedFormQuestions(db, owner, input.locale)
  const supplied = typeof input.questionsRevision === 'string' && input.questionsRevision.trim() ? input.questionsRevision.trim() : null
  const answered = Array.isArray(input.answers) && input.answers.length > 0
  if (supplied === null && (input.revisionRequired || answered)) {
    throw new HTTPError({ statusCode: 422, statusMessage: 'questions_revision is required: read the current questions and send the revision they came with.', data: { code: 'QUESTIONS_REVISION_REQUIRED', field: 'questions_revision', ...current } })
  }
  if (supplied !== null && supplied !== current.questions_revision) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'The questions on this form changed. Review your answers and submit again.', data: { code: 'questions_changed', field: 'answers', ...current } })
  }
  const resolution = resolveFormAnswers(current.questions, input.answers)
  if (!resolution.ok) {
    throw new HTTPError({ statusCode: 422, statusMessage: resolution.errors.map(error => error.message).join(' '), data: { code: 'invalid_answers', field: 'answers', answer_errors: resolution.errors } })
  }
  return resolution.answers
}

/**
 * A writer's new collection for an owner whose current collection is
 * `current`. The caller names the revision it read; a different current
 * revision means someone else changed the questions first.
 */
export function prepareFormQuestionsWrite(current: readonly FormQuestion[], input: { questions: unknown; expectedRevision: unknown }): FormQuestion[] {
  let next: FormQuestion[]
  try {
    next = normalizeFormQuestionsInput(input.questions)
  } catch (error) {
    if (!(error instanceof FormQuestionDefinitionError)) throw error
    throw new HTTPError({ statusCode: 422, statusMessage: error.message, data: { code: 'INVALID_QUESTIONS', field: error.field } })
  }
  const revision = formQuestionsRevision(current)
  // A save that restates the saved questions, as a whole-record editor does, changes nothing to guard.
  if (formQuestionsRevision(next) === revision) return [...current]
  if (typeof input.expectedRevision !== 'string' || !input.expectedRevision.trim()) {
    throw new HTTPError({ statusCode: 422, statusMessage: 'expected_questions_revision is required with questions: read the current questions first.', data: { code: 'QUESTIONS_REVISION_REQUIRED', field: 'expected_questions_revision' } })
  }
  if (input.expectedRevision.trim() !== revision) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'The questions changed since they were read. Read them again before saving.', data: { code: 'questions_changed', field: 'expected_questions_revision', questions: current, questions_revision: revision } })
  }
  return next
}

/** The site's inquiry form as a visitor reads it: its questions in their language, and whether the legal practice notice applies. */
export async function readPublicInquiryForm(db: DbClient, organizationId: string, locale: string): Promise<{ questions: FormQuestion[]; questions_revision: string; consent_required: boolean }> {
  const organization = await queryFirst<{ vertical: string; theme_id: string | null }>(db, "SELECT vertical, theme_id FROM organization WHERE id = ? AND status = 'active'", [organizationId])
  if (!organization) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
  return { ...await readLocalizedFormQuestions(db, { kind: 'inquiry', organizationId }, locale), consent_required: isLegalPracticeSite({ themeId: organization.theme_id, vertical: organization.vertical }) }
}
