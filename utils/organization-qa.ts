// The site Q&A record, shared by the list and the record's own editor so
// neither restates the other's shape.

export interface QaRow {
  id: string
  question: string
  answer: string | null
  status: 'published' | 'hidden'
  sort_order: number
  page_path: string | null
  upvote_count: number | null
  /** Where the record came from. An 'import' row is Google's and is read-only. */
  source: string | null
}

export const isQaRow = (value: unknown): value is QaRow =>
  isRecord(value)
  && typeof value.id === 'string'
  && typeof value.question === 'string'
  && (value.answer === null || typeof value.answer === 'string')
  && (value.status === 'published' || value.status === 'hidden')
  && typeof value.sort_order === 'number'
  && (value.page_path === null || typeof value.page_path === 'string')
  && (value.upvote_count === null || typeof value.upvote_count === 'number')
  && (value.source === null || typeof value.source === 'string')

export const isQaResponse = (value: unknown): value is { qa: QaRow[] } =>
  isRecord(value) && Array.isArray(value.qa) && value.qa.every(isQaRow)

// A created row is a QaRow, so it is checked as one: callers read `status` and
// `answer` off the result, and a guard that never looked at them promised
// fields the response might not carry.
export const isQaCreated = (value: unknown): value is QaRow => isQaRow(value)

export const isQaUpdated = (value: unknown): value is { updated: true; qa_id: string; qa: QaRow } =>
  isRecord(value) && value.updated === true && isQaRow(value.qa) && value.qa_id === value.qa.id

export function qaIndexKey(organizationId: string, locationId: string | null, pagePath: string | null) {
  return locationId ? `dashboard-location-qa-${organizationId}-${locationId}` : `dashboard-organization-qa-${organizationId}-${pagePath ?? 'general'}`
}

export function qaRecordKey(organizationId: string, locationId: string | null, id: string) {
  return `dashboard-qa-record-${organizationId}-${locationId ?? 'organization'}-${id}`
}

export const isQaDeleted = (value: unknown): value is { qa_id: string; deleted: true } =>
  isRecord(value) && typeof value.qa_id === 'string' && value.deleted === true

/** The question is the only field the create endpoint will not accept empty. */
export function qaCreateBlockers(form: { question: string }): Array<'question'> {
  return form.question.trim() ? [] : ['question']
}
