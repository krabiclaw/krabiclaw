import { HTTPError } from 'nitro'
import { FAQ_BLOCK_SOURCES, type FaqBlockSource } from '~/shared/faq-block'
import { getPersistedSourceLocale } from '~/server/utils/localization'
import { prepareContentDocumentWithBlocks, documentOfRootSql, prepareContentDocumentDeletion } from '~/server/utils/content/documents'
import { executeBatch, queryAll, queryFirst, type DbClient } from '../db/index.ts'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { d1JsonStringSet, d1JsonValue } from '../db/d1-limits.ts'
import { organizationEventQuery } from '~/server/utils/organization-events'
import type { AuthUserIdentity } from '~/server/utils/auth'

export interface QaScope {
  organizationId: string
  locationId: string | null
  pagePath?: string | null
}

export interface CreateQaInput {
  question: unknown
  answer?: unknown
  question_author?: unknown
  is_owner_answer?: unknown
  sort_order?: unknown
  status?: unknown
}

export interface UpdateQaInput {
  question?: unknown
  answer?: unknown
  question_author?: unknown
  is_owner_answer?: unknown
  status?: unknown
  sort_order?: unknown
}

export interface QaDocument {
  id: string
  organization_id: string
  location_id: string | null
  page_path: string | null
  question: string
  question_author: string | null
  question_date: string | null
  answer: string | null
  answer_author: string | null
  answer_date: string | null
  is_owner_answer: number
  upvote_count: number
  source: string
  status: 'published' | 'hidden'
  sort_order: number
  created_at: string
  updated_at: string
}

function normalizePagePath(pagePath: string | null | undefined) {
  if (!pagePath) return null
  const normalized = `/${pagePath.trim().replace(/^\/+|\/+$/g, '')}`
  return normalized === '/' ? '/' : normalized
}

function scopeSql(locationId: string | null, pagePath?: string | null) {
  const normalizedPagePath = normalizePagePath(pagePath)
  return locationId === null
    ? normalizedPagePath
      ? { clause: 'location_id IS NULL AND scope_path = ?', params: [normalizedPagePath] as unknown[] }
      : { clause: 'location_id IS NULL AND scope_path IS NULL', params: [] as unknown[] }
    : { clause: 'location_id = ?', params: [locationId] as unknown[] }
}

function stringOrNull(value: unknown, maxLength: number) {
  if (value == null) return null
  const normalized = String(value).trim()
  return normalized ? normalized.slice(0, maxLength) : null
}

function badQaInput(message: string): never {
  throw new HTTPError({ statusCode: 400, statusMessage: message })
}

async function assertQaScope(db: DbClient, scope: QaScope) {
  if (scope.locationId !== null && (typeof scope.locationId !== 'string' || !scope.locationId.trim())) badQaInput('location_id must be a non-empty string or null')
  if (scope.pagePath != null && typeof scope.pagePath !== 'string') badQaInput('page_path must be a string or null')
  if (scope.locationId !== null && scope.pagePath != null) badQaInput('Pass location_id or page_path, not both')
  const owner = scope.locationId === null
    ? await queryFirst<{ id: string }>(db, 'SELECT id FROM organization WHERE id = ?', [scope.organizationId])
    : await queryFirst<{ id: string }>(db, 'SELECT id FROM business_locations WHERE organization_id = ? AND id = ?', [scope.organizationId, scope.locationId])
  if (!owner) throw new HTTPError({ statusCode: 404, statusMessage: 'Q&A scope not found' })
}

/** Create and update accept the same values; omission on update retains them. */
function normalizeQaInput(input: UpdateQaInput, creating = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) badQaInput('Invalid request body')
  const normalized: UpdateQaInput = { ...input }
  if (creating || input.question !== undefined) {
    if (typeof input.question !== 'string' || !input.question.trim()) badQaInput('question required')
    if (input.question.trim().length > 500) badQaInput('question must be 500 characters or fewer')
    normalized.question = input.question.trim()
  }
  for (const [field, limit] of [['answer', 2000], ['question_author', 120]] as const) {
    if (input[field] !== undefined) {
      if (input[field] !== null && typeof input[field] !== 'string') badQaInput(`${field} must be a string or null`)
      normalized[field] = stringOrNull(input[field], limit)
    }
  }
  if (input.is_owner_answer !== undefined && typeof input.is_owner_answer !== 'boolean') badQaInput('is_owner_answer must be a boolean')
  if (input.sort_order !== undefined && !Number.isSafeInteger(input.sort_order)) badQaInput('sort_order must be an integer')
  if (input.status !== undefined && input.status !== 'published' && input.status !== 'hidden') badQaInput('Invalid Q&A status')
  return normalized
}

/**
 * `qaId` addresses one record whatever its scope. A dashboard record has a URL
 * of its own — `/qa/<id>` — and cannot know the page it was filed under before
 * it has read it, so an id lookup replaces the scope clause rather than
 * narrowing it. Without an id this behaves exactly as before.
 */
export async function listQa(db: DbClient, organizationId: string, locationId: string | null, publishedOnly = false, pagePath?: string | null, locale?: string, qaId?: string | null) {
  locale ??= (await getPersistedSourceLocale(db, organizationId)).locale
  const scope = qaId
    ? { clause: 'root.id = ?', params: [qaId] as unknown[] }
    : scopeSql(locationId, pagePath)
  return queryAll<QaDocument>(db, `
    SELECT p.id, p.organization_id, root.location_id, root.scope_path AS page_path,
      p.title AS question, p.summary AS answer, (root.metadata_json ->> '$.question_author') AS question_author,
      (root.metadata_json ->> '$.question_date') AS question_date, (root.metadata_json ->> '$.answer_author') AS answer_author,
      (root.metadata_json ->> '$.answer_date') AS answer_date, (root.metadata_json ->> '$.is_owner_answer') AS is_owner_answer,
      (root.metadata_json ->> '$.upvote_count') AS upvote_count, root.source, root.status, root.sort_order, p.created_at, p.updated_at
    FROM content_documents root JOIN content_documents p ON ${documentOfRootSql('p', 'root')} AND p.locale = ?
    WHERE root.row_role = 'root' AND root.kind = 'qa' AND root.organization_id = ?
      AND ${scope.clause.replace(/\b(location_id|scope_path)\b/g, 'root.$1')}${publishedOnly ? " AND root.status = 'published'" : ''}
    ORDER BY root.sort_order, is_owner_answer DESC, upvote_count DESC, p.created_at
  `, [locale, organizationId, ...scope.params])
}

export function faqBlockSource(block: { type: string; data: Record<string, unknown> }): FaqBlockSource | null {
  if (block.type !== 'faq') return null
  return FAQ_BLOCK_SOURCES.find(source => source === block.data.source) ?? null
}

/** The published records a FAQ block with `source` lists on `pagePath`. */
export function listFaqBlockQa(db: DbClient, organizationId: string, pagePath: string, source: FaqBlockSource, locale?: string) {
  return listQa(db, organizationId, null, true, source === 'page_qa' ? pagePath : null, locale)
}

export function faqItems(rows: QaDocument[]) {
  return rows.map(row => {
    if (typeof row.question !== 'string' || !row.question.trim()) {
      throw new HTTPError({ statusCode: 500, statusMessage: `Stored Q&A ${row.id} question is missing`, data: { code: 'INVALID_STORED_CONTENT' } })
    }
    if (row.answer !== null && typeof row.answer !== 'string') {
      throw new HTTPError({ statusCode: 500, statusMessage: `Stored Q&A ${row.id} answer is invalid`, data: { code: 'INVALID_STORED_CONTENT' } })
    }
    return { id: row.id, title: row.question, description: row.answer ?? undefined }
  })
}

/**
 * FAQ blocks hold no questions of their own: each lists the published Q&A
 * records its `source` names. Public readers attach those records here so every
 * surface renders the same items.
 */
export async function attachPageQa<T extends { type: string; data: Record<string, unknown> }>(
  db: DbClient, organizationId: string, pagePath: string, blocks: T[], locale?: string,
): Promise<T[]> {
  const sources = new Set(blocks.map(faqBlockSource).filter((source): source is FaqBlockSource => source !== null))
  if (!sources.size) return blocks
  const itemsBySource = new Map(await Promise.all([...sources].map(async source =>
    [source, faqItems(await listFaqBlockQa(db, organizationId, pagePath, source, locale))] as const)))
  return blocks.map((block) => {
    const source = faqBlockSource(block)
    return source ? { ...block, data: { ...block.data, items: itemsBySource.get(source) } } : block
  })
}

/**
 * The editor's Q&A is the site's own. `source = 'manual'` is written here and
 * matched on every update and delete, so an imported Google question is not
 * addressable through these paths — it belongs to the Places import, and the
 * dashboard says to manage it in Google.
 *
 * Making *every* Q&A read-only instead stranded the 72 records four sites had
 * authored — NCLS's practice-area answers and KrabiClaw's own 50 docs questions
 * among them — with no way left to correct a word.
 */
export async function createQa(db: DbClient, scope: QaScope, input: CreateQaInput, actor: AuthUserIdentity | null) {
  await assertQaScope(db, scope)
  const normalized = normalizeQaInput(input, true)
  if (actor !== null && (!actor || typeof actor.id !== 'string' || !actor.id.trim() || typeof actor.name !== 'string')) badQaInput('actor must be the authenticated identity or explicitly null')
  const actorId = actor?.id ?? null
  const actorName = actor?.name ?? null
  const now = new Date().toISOString()
  const question = normalized.question as string
  const answer = stringOrNull(normalized.answer, 2000)
  const status = normalized.status === 'hidden' ? 'hidden' : 'published'
  const explicitSortOrder = normalized.sort_order === undefined ? null : normalized.sort_order as number

  const source = await getPersistedSourceLocale(db, scope.organizationId)
  const id = crypto.randomUUID()
  const pagePath = scope.locationId === null ? normalizePagePath(scope.pagePath) : null
  const scoped = scopeSql(scope.locationId, pagePath)
  const prepared = prepareContentDocumentWithBlocks({
    id, rowRole: 'root', kind: 'qa', locale: source.locale, organizationId: scope.organizationId,
    locationId: scope.locationId, scopePath: pagePath, status, source: 'manual', sortOrder: explicitSortOrder ?? 0,
    title: question, summary: answer, createdBy: actorId, updatedBy: actorId,
    metadata: { question_author: stringOrNull(normalized.question_author, 120),
      question_date: null, answer_author: answer ? actorName : null, answer_date: answer ? now : null,
      is_owner_answer: normalized.is_owner_answer === false ? 0 : 1, upvote_count: 0 },
  }, [], {
    additionalQueriesAfter: [...(explicitSortOrder === null ? [{
      query: `UPDATE content_documents SET sort_order = (
        SELECT COALESCE(MAX(sort_order), -1) + 1 FROM content_documents
        WHERE row_role = 'root' AND kind = 'qa' AND organization_id = ? AND ${scoped.clause} AND id <> ?
      ) WHERE id = ?`,
      params: [scope.organizationId, ...scoped.params, id, id],
    }] : [])],
  })
  await executeBatch(db, [...prepared.queries,
    organizationEventQuery({ organizationId: scope.organizationId, locationId: scope.locationId, actorId,
      eventType: 'content.updated', entityType: 'qa', entityId: id,
      afterState: { updated_at: prepared.document.updated_at, status },
      metadata: { operation: 'created', changed_fields: ['question', ...(answer ? ['answer'] : []), 'status'], evidence_basis: 'persisted_change', page_path: pagePath } }),
    publicResourceCacheInvalidationQuery(scope.organizationId, 'qa-create')])
  const inserted = await queryFirst<{ sort_order: number }>(db, 'SELECT sort_order FROM content_documents WHERE id = ?', [id])
  if (!inserted) throw new Error('Created Q&A document was not found')
  const sortOrder = inserted.sort_order

  return {
    status: 201,
    data: {
      id,
      question,
      answer,
      location_id: scope.locationId,
      page_path: pagePath,
      status,
      sort_order: sortOrder,
      // A newly created question has no votes yet, and it is the tenant's own.
      // Both are stated rather than omitted: this is the same row shape the
      // list returns and the CMS validates it as one, so a missing `source`
      // failed that check and no question could be created at all.
      upvote_count: 0,
      source: 'manual',
      created: true,
    },
  }
}

export async function updateQa(db: DbClient, scope: QaScope, qaId: string, input: UpdateQaInput, actor: AuthUserIdentity | null) {
  await assertQaScope(db, scope)
  const updates = normalizeQaInput(input)
  if (actor !== null && (!actor || typeof actor.id !== 'string' || !actor.id.trim() || typeof actor.name !== 'string')) badQaInput('actor must be the authenticated identity or explicitly null')
  const actorId = actor?.id ?? null
  const actorName = actor?.name ?? null
  const scoped = scopeSql(scope.locationId, scope.pagePath)
  const current = await queryFirst<{ title: string; summary: string | null; status: string; sort_order: number; metadata_json: string; updated_at: string }>(db,
    `SELECT title, summary, status, sort_order, metadata_json, updated_at FROM content_documents
      WHERE row_role = 'root' AND kind = 'qa' AND source = 'manual' AND id = ? AND organization_id = ? AND ${scoped.clause}`,
    [qaId, scope.organizationId, ...scoped.params])
  if (!current) throw new HTTPError({ statusCode: 404, statusMessage: 'Q&A not found' })
  const fields = ['question', 'answer', 'question_author', 'is_owner_answer', 'status', 'sort_order'] as const
  if (!fields.some(field => updates[field] !== undefined)) badQaInput('No update fields provided')
  const metadata = JSON.parse(current.metadata_json) as Record<string, unknown>
  const changedFields = fields.filter(field => updates[field] !== undefined && updates[field] !== (
    field === 'question' ? current.title : field === 'answer' ? current.summary : field === 'is_owner_answer' ? metadata.is_owner_answer !== 0
      : field === 'question_author' ? metadata.question_author ?? null : current[field]))
  if (!changedFields.length) return { updated: false, qa_id: qaId }
  const now = new Date(Math.max(Date.now(), Date.parse(current.updated_at) + 1)).toISOString()
  const sets = ['updated_at = ?', 'updated_by = ?']
  const params: unknown[] = [now, actorId]
  for (const field of changedFields) {
    if (field === 'question_author' || field === 'is_owner_answer') metadata[field] = field === 'is_owner_answer' ? updates[field] ? 1 : 0 : updates[field]
    else {
      sets.push(`${field === 'question' ? 'title' : field === 'answer' ? 'summary' : field} = ?`)
      params.push(updates[field])
    }
  }
  if (changedFields.includes('answer')) {
    metadata.answer_author = updates.answer ? actorName : null
    metadata.answer_date = updates.answer ? now : null
  }
  if (changedFields.some(field => field === 'question_author' || field === 'is_owner_answer' || field === 'answer')) {
    sets.push('metadata_json = ?')
    params.push(JSON.stringify(metadata))
  }
  const [result] = await executeBatch(db, [{
    query: `UPDATE content_documents SET ${sets.join(', ')}
      WHERE row_role = 'root' AND kind = 'qa' AND source = 'manual' AND id = ? AND organization_id = ? AND ${scoped.clause} AND updated_at = ?`,
    params: [...params, qaId, scope.organizationId, ...scoped.params, current.updated_at],
  }, organizationEventQuery({ organizationId: scope.organizationId, locationId: scope.locationId, actorId,
    eventType: 'content.updated', entityType: 'qa', entityId: qaId,
    beforeState: { updated_at: current.updated_at, status: current.status }, afterState: { updated_at: now, status: updates.status ?? current.status },
    metadata: { changed_fields: changedFields, evidence_basis: 'persisted_change', page_path: normalizePagePath(scope.pagePath) }, onlyIfPreviousChangedOneRow: true }),
  publicResourceCacheInvalidationQuery(scope.organizationId, 'qa-update')])
  if (Number(result?.meta.changes ?? 0) !== 1) throw new HTTPError({ statusCode: 409, statusMessage: 'Q&A changed concurrently. Reload and try again.' })
  return { updated: true, qa_id: qaId }
}

export async function deleteQa(db: DbClient, scope: QaScope, qaId: string) {
  await assertQaScope(db, scope)
  const scoped = scopeSql(scope.locationId, scope.pagePath)
  const params = [qaId, scope.organizationId, ...scoped.params]
  const where = `row_role = 'root' AND kind = 'qa' AND source = 'manual' AND id = ? AND organization_id = ? AND ${scoped.clause}`
  const document = await queryFirst<{ id: string }>(db, `SELECT id FROM content_documents WHERE ${where}`, params)
  if (!document) return { status: 404, data: { error: 'Q&A not found' } }
  const results = await executeBatch(db, prepareContentDocumentDeletion({ documentId: qaId, organizationId: scope.organizationId}))
  if (!Number(results.at(-1)?.meta.changes ?? 0)) return { status: 404, data: { error: 'Q&A not found' } }
  return { status: 200, data: { qa_id: qaId, deleted: true } }
}

export async function reorderQa(
  db: DbClient,
  scope: QaScope,
  updates: Array<{ id: string; sort_order: number }>,
) {
  await assertQaScope(db, scope)
  if (!Array.isArray(updates)) badQaInput('Q&A reorder requires an updates array')
  if (!updates.length || updates.some(update => !update || typeof update.id !== 'string' || !update.id || !Number.isSafeInteger(update.sort_order))) {
    badQaInput('Q&A reorder requires ids with integer sort_order values')
  }
  if (new Set(updates.map(update => update.id)).size !== updates.length) {
    badQaInput('Q&A reorder ids must be distinct')
  }

  const scoped = scopeSql(scope.locationId, scope.pagePath)
  const validation = await queryFirst<{ valid_count: number }>(db, `
    SELECT COUNT(*) AS valid_count
    FROM content_documents
    WHERE row_role = 'root' AND kind = 'qa' AND source = 'manual' AND id IN (SELECT value FROM json_each(?)) AND organization_id = ? AND ${scoped.clause}
  `, [d1JsonStringSet(updates.map(update => update.id)), scope.organizationId, ...scoped.params])
  if (Number(validation?.valid_count ?? 0) !== updates.length) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Q&A reorder contains records outside the requested scope' })
  }

  const now = new Date().toISOString()
  const ids = d1JsonStringSet(updates.map(update => update.id))
  // One guarded UPDATE: every requested row must still be manual and in scope
  // at write time. A failed precondition changes no row, even after the read.
  const [result] = await executeBatch(db, [{
    query: `UPDATE content_documents SET sort_order = (
      SELECT json_extract(value, '$.sort_order') FROM json_each(?) WHERE json_extract(value, '$.id') = content_documents.id
    ), updated_at = ?
    WHERE row_role = 'root' AND kind = 'qa' AND source = 'manual' AND organization_id = ? AND ${scoped.clause}
      AND id IN (SELECT value FROM json_each(?))
      AND (SELECT count(*) FROM content_documents WHERE row_role = 'root' AND kind = 'qa' AND source = 'manual'
        AND organization_id = ? AND ${scoped.clause} AND id IN (SELECT value FROM json_each(?))) = ?`,
    params: [d1JsonValue(updates), now, scope.organizationId, ...scoped.params, ids, scope.organizationId, ...scoped.params, ids, updates.length],
  }, publicResourceCacheInvalidationQuery(scope.organizationId, 'qa-reorder')])
  const changed = Number(result?.meta.changes ?? 0)
  if (changed !== updates.length) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'Q&A reorder changed concurrently. Reload and try again.' })
  }
  return { updated: updates.length }
}

export const listLocationQa = (db: DbClient, organizationId: string, locationId: string) => listQa(db, organizationId, locationId)

export function createLocationQa(
  db: DbClient,
  organizationId: string,
  locationId: string,
  input: CreateQaInput,
  actor: AuthUserIdentity | null,
) {
  return createQa(db, { organizationId, locationId }, input, actor)
}

export function deleteLocationQa(db: DbClient, organizationId: string, locationId: string, qaId: string) {
  return queryFirst<{ id: string }>(db, 'SELECT id FROM organization WHERE id = ?', [organizationId])
    .then(organization => organization
      ? deleteQa(db, { organizationId, locationId }, qaId)
      : { status: 404, data: { error: 'Q&A not found' } })
}
