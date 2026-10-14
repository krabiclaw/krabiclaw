import { markdownRequiresSourceMode } from '~/shared/markdown-editor-mode'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { resolveMcpDocumentationBlocks } from '~/server/utils/mcp-documentation'
import { HTTPError } from 'nitro';

import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '../../db/index.ts'
import { d1JsonStringSet } from '../../db/d1-limits.ts'
import { validateContentBlockData } from '../../../utils/tenant-page-blocks.ts'
import type { content_documents } from '../../db/schema.ts'
import {
  CONTENT_BLOCK_TYPES,
  type ContentBlockType,
  type ContentDocumentKind,
} from '~/shared/content-registries'


export {
  CONTENT_BLOCK_TYPES,
  CONTENT_DOCUMENT_KINDS,
  type ContentBlockType,
  type ContentDocumentKind,
} from '~/shared/content-registries'

export type ContentDocumentRow = Pick<typeof content_documents.$inferSelect,
  'id' | 'organization_id' | 'kind' | 'created_at' | 'updated_at'
> & { row_role: 'root' | 'representation'; root_id: string | null; locale: string }

interface ContentDocumentInputFields {
  id?: string
  organizationId: string
  kind: ContentDocumentKind
  title?: string | null
  slug?: string | null
  path?: string | null
  summary?: string | null
  seoKeywords?: string | null
  robots?: string | null
  metadata?: Record<string, unknown>
  createdBy?: string | null
  updatedBy?: string | null
}

export type ContentDocumentInput = ContentDocumentInputFields & (
  | { rowRole: 'representation'; rootId: string; locale: string }
  | { rowRole: 'root'; locale: string; locationId?: string | null; productId?: string | null; scopePath?: string | null;
      status?: string | null; visibility?: string | null; sortOrder?: number; source?: string | null;
      authorId?: string | null; publishedAt?: string | null; firstPublishedAt?: string | null }
)

export interface ContentBlockRow {
  source_block_id: string | null
  id: string
  document_id: string
  parent_block_id: string | null
  type: ContentBlockType
  position: number
  level: number | null
  data_json: string
  created_at: string
  updated_at: string
}

export interface ContentBlockSnapshot {
  source_block_id?: string | null
  id: string
  parent_block_id: string | null
  type: ContentBlockType
  position: number
  level: number | null
  data: Record<string, unknown>
  media?: ContentBlockMedia[]
}

export interface ContentBlockMedia {
  asset_id: string
  slot: string
  sort_order?: number
  public_url?: string | null
  thumbnail_url?: string | null
  kind?: string | null
  alt_text?: string | null
  width?: number | null
  height?: number | null
}

export interface ContentBlockInput {
  source_block_id?: string | null
  id?: string
  type: ContentBlockType
  data: Record<string, unknown>
  media?: ContentBlockMedia[]
  parent_block_id?: string | null
  level?: number | null
}

type ContentBlockWriteInput = Omit<ContentBlockSnapshot, 'id'> & { id?: string; updated_at?: string | null }

export type ContentDocumentChanges = Partial<Pick<typeof content_documents.$inferInsert,
  'title' | 'slug' | 'path' | 'summary' | 'seo_keywords'
  | 'status' | 'visibility' | 'sort_order' | 'location_id' | 'source' | 'scope_path' | 'published_at' | 'first_published_at' | 'updated_by'
>> & { metadata?: Record<string, unknown> }

interface ContentDocumentWriteOptions {
  changes?: ContentDocumentChanges
  bodyMarkdown?: string
  expectedDocument?: { id: string; updatedAt: string }
  additionalQueriesBefore?: BatchQuery[]
  additionalQueriesAfter?: BatchQuery[]
}

function badRequest(message: string): never {
  throw new HTTPError({ statusCode: 400, statusMessage: message })
}

function notFound(message: string): never {
  throw new HTTPError({ statusCode: 404, statusMessage: message })
}

function assertBlockType(type: string): ContentBlockType {
  if (!(CONTENT_BLOCK_TYPES as readonly string[]).includes(type)) {
    badRequest(`content block type must be one of: ${CONTENT_BLOCK_TYPES.join(', ')}`)
  }
  return type as ContentBlockType
}

function asObject(value: unknown, field: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) badRequest(`${field} must be an object`)
  return value as Record<string, unknown>
}

function mediaFreeBlockData(type: ContentBlockType, value: unknown, field: string) {
  let data = asObject(value, field)
  try {
    data = validateContentBlockData(type, data)
  } catch (error) {
    badRequest(error instanceof Error ? error.message : `${field} contains invalid block data`)
  }
  // The markdown contract lives here, on the one batch builder every content
  // document write passes through, because `content_blocks` is one table and a
  // block cannot mean different things depending on which caller wrote it.
  // It used to live in platform-content's blog path alone, so a tenant page
  // could store a markdown block with no editor_mode that the blog path would
  // then refuse — the same row, legal to one writer and rejected by the other.
  // That left documents nobody could save from the CMS: not the block, every
  // field on the page.
  if (type === 'markdown') {
    if (typeof data.markdown !== 'string') badRequest(`${field}.markdown is required`)
    if (data.editor_mode !== 'rich' && data.editor_mode !== 'source') {
      badRequest(`${field}.editor_mode must be rich or source`)
    }
    if (data.editor_mode === 'rich' && markdownRequiresSourceMode(data.markdown)) {
      badRequest(`${field} uses markdown tables or raw HTML, which require editor_mode source`)
    }
  }
  return data
}

function parseBlockData(row: Pick<ContentBlockRow, 'data_json' | 'id' | 'type'>) {
  try {
    const data = asObject(JSON.parse(row.data_json) as unknown, `content block ${row.id} data`)
    if (row.type === 'how_to' || row.type === 'faq' || row.type === 'page_grid') validateContentBlockData(row.type, data)
    return data
  } catch (error) {
    throw new HTTPError({
      statusCode: 500,
      statusMessage: `Content block ${row.id} has invalid stored data`,
      cause: error,
    })
  }
}

export function renderContentBlocksToMarkdown(blocks: Array<Pick<ContentBlockRow, 'type' | 'position' | 'level' | 'data_json' | 'id'>>) {
  const sections = [...blocks]
    .sort((a, b) => a.position - b.position)
    .map((block) => {
      const data = parseBlockData(block)
      if (block.type === 'heading') {
        const text = typeof data.text === 'string' ? data.text.trim() : ''
        if (!text) return ''
        const level = Math.max(1, Math.min(6, block.level ?? 2))
        return `${'#'.repeat(level)} ${text}`
      }
      if (block.type === 'markdown') {
        return typeof data.markdown === 'string' ? data.markdown.trim() : ''
      }
      if (block.type === 'divider') return '---'
      return `{{component type="${block.type}"}}`
    })
    .filter(Boolean)

  return sections.join('\n\n').trim()
}

export async function getContentRepresentation(db: DbClient, input: { rootId: string; locale?: string }) {
  return await queryFirst<ContentDocumentRow>(db, `
    SELECT d.id, d.organization_id, d.kind, d.row_role, d.root_id, d.locale, d.created_at, d.updated_at
    FROM content_documents d
    JOIN organization_locales l ON l.organization_id = d.organization_id AND l.locale = d.locale
    WHERE COALESCE(d.root_id, d.id) = ? AND d.row_role IN ('root', 'representation')
      AND (? IS NULL AND l.is_source = 1 OR d.locale = ?)
    LIMIT 1
  `, [input.rootId, input.locale ?? null, input.locale ?? null])
}

/**
 * `expectedUpdatedAt` is enforced inside the batch, not by the caller reading the
 * row first. A caller that checks a timestamp and then deletes has every query
 * in between as a window for another writer, and would delete the newer version
 * it never saw. The assertion is the same one an update uses, and it runs first,
 * so a stale delete aborts before a placement, a redirect or a document is
 * touched.
 */
export function prepareContentDocumentDeletion(input: { organizationId: string } & ({ documentId: string; expectedUpdatedAt?: string; expectedRepresentations?: Array<{ id: string; updatedAt: string }> } | { locationId: string })): BatchQuery[] {
  const document = 'documentId' in input
  const owned = document
    ? 'SELECT id FROM content_documents WHERE (id = ? OR root_id = ?) AND organization_id = ?'
    : `SELECT d.id FROM content_documents d LEFT JOIN content_documents root ON root.id = d.root_id
       WHERE (d.location_id = ? OR root.location_id = ?) AND d.organization_id = ?`
  const id = document ? input.documentId : input.locationId
  const params = [id, id, input.organizationId]
  return [
    ...(document && input.expectedUpdatedAt !== undefined
      ? [assertDocumentSnapshotQuery(input.documentId, new Date().toISOString(), input.expectedUpdatedAt)]
      : []),
    // A root takes its representations with it through the cascade, so each
    // one the caller saw is asserted too: a translation edited between the
    // locale read and this batch aborts the delete instead of vanishing.
    ...(document && input.expectedRepresentations !== undefined
      ? [
          ...input.expectedRepresentations.map(representation =>
            assertDocumentSnapshotQuery(representation.id, new Date().toISOString(), representation.updatedAt)),
          // And none the caller did not see: a translation created after the
          // locale read would otherwise go through the cascade unasserted.
          assertRepresentationCountQuery(input.documentId, new Date().toISOString(), input.expectedRepresentations.length),
        ]
      : []),
    // Deleting a location removes every document scoped to it, so one
    // document's timestamp says nothing about the set; the union above is what
    // keeps a caller from passing one there and believing it was honoured.
    { query: `DELETE FROM organization_redirects WHERE owner_type = 'content_document' AND owner_id IN (${owned})`, params },
    { query: `DELETE FROM organization_redirects WHERE owner_type = 'content_block' AND owner_id IN (
      SELECT id FROM content_blocks WHERE document_id IN (${owned})
    )`, params },
    { query: `DELETE FROM media_placements WHERE owner_type = 'content_document' AND owner_id IN (${owned})`, params },
    { query: `DELETE FROM media_placements WHERE owner_type = 'content_block' AND owner_id IN (
      SELECT id FROM content_blocks WHERE document_id IN (${owned})
    )`, params },
    // Before the delete itself, whose result the caller reads as the last statement's.
    publicResourceCacheInvalidationQuery(input.organizationId, 'content-document-delete'),
    // The same reach as every statement above it. `WHERE id = ?` deleted the
    // root and left its translations behind: content_documents has no foreign
    // key on root_id, so nothing cascaded, and each representation became a row
    // whose root no longer exists.
    { query: `DELETE FROM content_documents WHERE ${document ? '(id = ? OR root_id = ?)' : '(location_id = ? OR root_id IN (SELECT id FROM content_documents WHERE location_id = ?))'} AND organization_id = ?`,
      params: [id, id, input.organizationId] },
  ]
}

export async function getContentDocumentById(db: DbClient, documentId: string) {
  return await queryFirst<ContentDocumentRow>(db, `
    SELECT id, organization_id, kind, row_role, root_id, locale, created_at, updated_at
    FROM content_documents WHERE id = ? AND row_role IN ('root', 'representation')
  `, [documentId])
}

function assertRepresentationCountQuery(rootId: string, now: string, expectedCount: number): BatchQuery {
  return {
    query: `INSERT INTO content_blocks (id, document_id, parent_block_id, type, position, level, data_json, created_at, updated_at)
      SELECT NULL, ?, NULL, 'markdown', 0, NULL, '{}', ?, ?
       WHERE (SELECT count(*) FROM content_documents WHERE root_id = ? AND row_role = 'representation') != ?`,
    params: [rootId, now, now, rootId, expectedCount],
  }
}

function assertDocumentSnapshotQuery(documentId: string, now: string, expectedUpdatedAt?: string): BatchQuery {
  return {
    query: `INSERT INTO content_blocks (id, document_id, parent_block_id, type, position, level, data_json, created_at, updated_at)
      SELECT NULL, ?, NULL, 'markdown', 0, NULL, '{}', ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM content_documents d
          WHERE d.id = ? AND d.row_role IN ('root', 'representation')${expectedUpdatedAt === undefined ? '' : ' AND d.updated_at = ?'}
       )`,
    params: [documentId, now, now, documentId, ...(expectedUpdatedAt === undefined ? [] : [expectedUpdatedAt])],
  }
}

function buildDocumentWriteBatch(
  document: ContentDocumentRow,
  blocks: ContentBlockWriteInput[] | undefined,
  opts: ContentDocumentWriteOptions = {},
) {
  const now = new Date(Math.max(Date.now(), Date.parse(document.updated_at) + 1)).toISOString()
  const snapshots: Array<ContentBlockSnapshot & { updated_at: string }> = (blocks ?? []).map((block, index) => ({
    id: block.id ?? crypto.randomUUID(),
    source_block_id: block.source_block_id ?? null,
    parent_block_id: block.parent_block_id ?? null,
    type: assertBlockType(block.type),
    // Where a block sits is its index in the array, always. The write used to
    // take a caller's number when it sent one, which is how one document came
    // to hold fifteen blocks at position 0.
    position: index,
    level: block.level ?? null,
    data: mediaFreeBlockData(block.type, block.data, `content block ${index} data`),
    updated_at: block.updated_at ?? now,
  }))
  const byId = new Map(snapshots.map(block => [block.id, block]))
  if (byId.size !== snapshots.length) badRequest('Content block IDs must be unique within a document')
  const visiting = new Set<string>()
  const inserted = new Set<string>()
  const insertionOrder: typeof snapshots = []
  function visit(block: typeof snapshots[number]) {
    if (inserted.has(block.id)) return
    if (visiting.has(block.id)) badRequest('Content block hierarchy must not contain a cycle')
    visiting.add(block.id)
    if (block.parent_block_id !== null) {
      const parent = byId.get(block.parent_block_id)
      if (!parent) badRequest('Content block parent must exist in the same document')
      visit(parent)
    }
    visiting.delete(block.id)
    inserted.add(block.id)
    insertionOrder.push(block)
  }
  snapshots.forEach(visit)
  const bodyMarkdown = opts.bodyMarkdown ?? renderContentBlocksToMarkdown(snapshots.map(block => ({
    id: block.id,
    type: block.type,
    position: block.position,
    level: block.level,
    data_json: JSON.stringify(block.data),
  })))

  const snapshotAssertion = assertDocumentSnapshotQuery(document.id, now, opts.expectedDocument?.updatedAt)

  const retainedIds = snapshots.map(block => block.id)
  const stalePlacementQuery = retainedIds.length
    ? {
        query: `DELETE FROM media_placements WHERE owner_type = 'content_block' AND owner_id IN (
          SELECT id FROM content_blocks WHERE document_id = ? AND id NOT IN (SELECT value FROM json_each(?))
        )`,
        params: [document.id, d1JsonStringSet(retainedIds)],
      }
    : {
        query: `DELETE FROM media_placements WHERE owner_type = 'content_block' AND owner_id IN (SELECT id FROM content_blocks WHERE document_id = ?)`,
        params: [document.id],
      }
  const liveBlockQueries: { query: string; params: unknown[] }[] = blocks === undefined ? [] : [
    { query: `INSERT INTO content_blocks(id, document_id, type, position, data_json)
      SELECT NULL, ?, 'markdown', 0, '{}' WHERE EXISTS (SELECT 1 FROM content_blocks
        WHERE id IN (SELECT value FROM json_each(?)) AND document_id <> ?)`, params: [document.id, d1JsonStringSet(retainedIds), document.id] },
    { query: `INSERT INTO content_blocks(id, document_id, type, position, data_json)
      SELECT NULL, ?, 'markdown', 0, '{}' WHERE EXISTS (
        SELECT 1 FROM content_blocks source
        JOIN content_blocks translated ON translated.source_block_id = source.id
        JOIN json_each(?) incoming ON json_extract(incoming.value, '$.id') = source.id
        WHERE source.document_id = ? AND source.type <> json_extract(incoming.value, '$.type')
      )`, params: [document.id, JSON.stringify(snapshots.map(({ id, type }) => ({ id, type }))), document.id] },
    ...insertionOrder.filter(block => block.source_block_id).map(block => ({
      query: `INSERT INTO content_blocks(id, document_id, type, position, data_json)
        SELECT NULL, ?, 'markdown', 0, '{}' WHERE NOT EXISTS (
          SELECT 1 FROM content_blocks source JOIN content_documents root ON root.id = source.document_id
          WHERE source.id = ? AND source.type = ? AND source.source_block_id IS NULL AND root.id = ?
            AND root.row_role = 'root' AND root.kind = ?
            AND root.organization_id = ?
        )`, params: [document.id, block.source_block_id, block.type, document.root_id, document.kind, document.organization_id],
    })),
    stalePlacementQuery,
    { query: `DELETE FROM media_placements WHERE owner_type = 'content_block' AND owner_id IN (
      WITH RECURSIVE removed(id) AS (
        SELECT translated.id FROM content_blocks translated JOIN content_blocks source ON source.id = translated.source_block_id
        WHERE source.document_id = ? AND source.id NOT IN (SELECT value FROM json_each(?))
        UNION
        SELECT child.id FROM content_blocks child JOIN removed ON child.parent_block_id = removed.id OR child.source_block_id = removed.id
      ) SELECT id FROM removed
    )`, params: [document.id, d1JsonStringSet(retainedIds)] },
    ...insertionOrder.map(block => ({
      query: `INSERT INTO content_blocks (id, document_id, source_block_id, parent_block_id, type, position, level, data_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET source_block_id = excluded.source_block_id, parent_block_id = excluded.parent_block_id,
          type = excluded.type, position = excluded.position, level = excluded.level, data_json = excluded.data_json, updated_at = excluded.updated_at`,
      params: [block.id, document.id, block.source_block_id ?? null, block.parent_block_id, block.type, block.position, block.level, JSON.stringify(block.data), now, block.updated_at],
    })),
    { query: 'DELETE FROM content_blocks WHERE document_id = ? AND id NOT IN (SELECT value FROM json_each(?))', params: [document.id, d1JsonStringSet(retainedIds)] },
  ]

  // A social_posts block that names a location names one of this
  // organization's active ones, as the public page requires; the write refuses
  // anything else in the same batch.
  const blockLocationGuards: BatchQuery[] = snapshots
    .filter(block => block.type === 'social_posts' && typeof block.data.location_id === 'string' && block.data.location_id)
    .map(block => ({
      query: `INSERT INTO content_blocks (id, document_id, type, position, data_json) SELECT NULL, ?, 'markdown', 0, '{}'
        WHERE NOT EXISTS (SELECT 1 FROM business_locations WHERE id = ? AND organization_id = ? AND status = 'active')`,
      params: [document.id, block.data.location_id as string, document.organization_id],
    }))

  const assignments = ['updated_at = ?']
  const values: unknown[] = [now]
  const changedColumns = ['title', 'slug', 'path', 'summary', 'seo_keywords', 'status', 'visibility', 'sort_order', 'location_id', 'source', 'scope_path',
    'published_at', 'first_published_at', 'updated_by'] as const
  for (const column of changedColumns) {
    if (opts.changes?.[column] !== undefined) {
      assignments.push(column + ' = ?')
      values.push(opts.changes[column])
    }
  }
  const metadata = Object.entries(opts.changes?.metadata ?? {}).filter(([, value]) => value !== undefined)
  if (metadata.length) {
    assignments.push('metadata_json = json_set(metadata_json, ' + metadata.map(() => '?, json(?)').join(', ') + ')')
    for (const [key, value] of metadata) values.push('$.' + JSON.stringify(key), JSON.stringify(value))
  }

  const queries: { query: string; params: unknown[] }[] = [
    { query: snapshotAssertion.query, params: snapshotAssertion.params ?? [] },
    ...(opts.additionalQueriesBefore ?? []).map(query => ({ query: query.query, params: query.params ?? [] })),
    ...blockLocationGuards.map(query => ({ query: query.query, params: query.params ?? [] })),
    ...liveBlockQueries,
    {
      query: `UPDATE content_documents SET ${assignments.join(', ')} WHERE id = ?`,
      params: [...values, document.id],
    },
    ...(opts.additionalQueriesAfter ?? []).map(query => ({ query: query.query, params: query.params ?? [] })),
  ]

  return { queries, body_markdown: bodyMarkdown, blocks: snapshots, updated_at: now }
}

async function writeDocumentBlocks(
  db: DbClient,
  document: ContentDocumentRow,
  blocks: ContentBlockWriteInput[] | undefined,
  opts: ContentDocumentWriteOptions = {},
) {
  const prepared = buildDocumentWriteBatch(document, blocks, {
    ...opts,
    expectedDocument: { id: document.id, updatedAt: document.updated_at },
  })
  try {
    await executeBatch(db, prepared.queries)
  } catch (error) {
    const current = await getContentDocumentById(db, document.id)
    if (!current || current.updated_at !== document.updated_at) {
      throw new HTTPError({ statusCode: 409, statusMessage: 'Content document was updated by another writer', cause: error })
    }
    throw error
  }

  return {
    body_markdown: prepared.body_markdown,
    blocks: prepared.blocks,
    updated_at: prepared.updated_at,
  }
}

export function prepareContentDocumentWithBlocks(
  input: ContentDocumentInput,
  blocks: ContentBlockInput[],
  opts: {
    bodyMarkdown?: string
    additionalQueriesBefore?: BatchQuery[]
    additionalQueriesAfter?: BatchQuery[]
  } = {},
) {
  const now = new Date().toISOString()
  const document: ContentDocumentRow = {
    id: input.id ?? crypto.randomUUID(), organization_id: input.organizationId,
    kind: input.kind, row_role: input.rowRole, root_id: input.rowRole === 'representation' ? input.rootId : null, locale: input.locale,
    created_at: now, updated_at: now,
  }
  const root = input.rowRole === 'root' ? input : null
  const documentInsert: BatchQuery = {
    query: `INSERT INTO content_documents
      (id, organization_id, kind, row_role, root_id, root_role, locale, title, slug, path, summary,
       seo_keywords, metadata_json, created_by, updated_by,
       location_id, product_id, scope_path, status, visibility, sort_order, source, author_id, published_at, first_published_at,
       created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [document.id, input.organizationId, input.kind, input.rowRole, document.root_id,
      input.rowRole === 'representation' ? 'root' : null, input.locale,
      input.title ?? null, input.slug ?? null, input.path ?? null, input.summary ?? null,
      input.seoKeywords ?? null, JSON.stringify(input.metadata ?? {}),
      input.createdBy ?? null, input.updatedBy ?? null,
      root?.locationId ?? null, root?.productId ?? null, root?.scopePath ?? null, root?.status ?? null, root?.visibility ?? null,
      root?.sortOrder ?? 0, root?.source ?? null, root?.authorId ?? null,
      root?.publishedAt ?? null, root?.firstPublishedAt ?? null, now, now],
  }

  const write = buildDocumentWriteBatch(document, blocks.map((block, index) => ({
    id: block.id, source_block_id: block.source_block_id ?? null, parent_block_id: block.parent_block_id ?? null, type: block.type,
    position: index, level: block.level ?? null, data: block.data,
  })), { bodyMarkdown: opts.bodyMarkdown, additionalQueriesAfter: opts.additionalQueriesAfter })
  return { document, ...write, queries: [...(opts.additionalQueriesBefore ?? []), documentInsert, ...write.queries] }
}

export async function createContentDocumentWithBlocks(
  db: DbClient,
  input: ContentDocumentInput,
  blocks: ContentBlockInput[],
  opts: Parameters<typeof prepareContentDocumentWithBlocks>[2] = {},
) {
  const prepared = prepareContentDocumentWithBlocks(input, blocks, opts)
  await executeBatch(db, [...prepared.queries, publicResourceCacheInvalidationQuery(input.organizationId, `${input.kind}-create`)])
  const document = await getContentDocumentById(db, prepared.document.id)
  if (!document) throw new HTTPError({ statusCode: 500, statusMessage: 'Content document disappeared after synchronization' })
  return { document, body_markdown: prepared.body_markdown, blocks: prepared.blocks }
}

export function formatBlockOutline(block: ContentBlockRow) {
  return {
    source_block_id: block.source_block_id,
    id: block.id,
    parent_block_id: block.parent_block_id,
    type: block.type,
    position: block.position,
    level: block.level,
    updated_at: block.updated_at,
    data: parseBlockData(block),
  }
}

export async function attachContentBlockMedia(db: DbClient, documentId: string, blocks: ReturnType<typeof formatBlockOutline>[]) {
  const media = await queryAll<ContentBlockMedia & { owner_id: string }>(
    db,
    `SELECT mp.owner_id, mp.asset_id, mp.slot, mp.sort_order,
            ma.alt_text,
            ma.public_url, ma.thumbnail_url, ma.kind, ma.width, ma.height
       FROM media_placements mp
       JOIN media_assets ma ON ma.id = mp.asset_id AND ma.status = 'active'
       JOIN content_blocks cb ON cb.id = mp.owner_id
      WHERE cb.document_id = ? AND mp.owner_type = 'content_block' AND mp.status = 'active'
      ORDER BY cb.position, mp.slot, mp.sort_order`,
    [documentId],
  ) ?? []
  const byBlock = new Map<string, ContentBlockMedia[]>()
  for (const item of media) {
    const items = byBlock.get(item.owner_id) ?? []
    const { owner_id: _ownerId, ...placement } = item
    items.push(placement)
    byBlock.set(item.owner_id, items)
  }
  return blocks.map(block => ({ ...block, media: byBlock.get(block.id) ?? [] }))
}

export async function getContentOutline(db: DbClient, documentId: string) {
  const blocks = await listBlocksForDocument(db, documentId)
  return await attachContentBlockMedia(db, documentId, blocks.map(formatBlockOutline))
}

export async function getContentBlock(db: DbClient, blockId: string) {
  const block = await queryFirst<ContentBlockRow | null>(
    db,
    `SELECT id, document_id, source_block_id, parent_block_id, type, position, level, data_json, created_at, updated_at
     FROM content_blocks
     WHERE id = ?
     LIMIT 1`,
    [blockId],
  )
  if (!block) notFound('Content block not found')
  const [outlined] = await attachContentBlockMedia(db, block.document_id, [formatBlockOutline(block)])
  return { ...block, data: outlined!.data, media: outlined!.media }
}

export async function listBlocksForDocument(db: DbClient, documentId: string) {
  return await queryAll<ContentBlockRow>(
    db,
    `SELECT id, document_id, source_block_id, parent_block_id, type, position, level, data_json, created_at, updated_at
     FROM content_blocks
     WHERE document_id = ?
     ORDER BY position ASC, created_at ASC`,
    [documentId],
  ) ?? []
}

export async function appendContentBlock(
  db: DbClient,
  documentId: string,
  input: ContentBlockInput & { after_block_id?: string | null },
  opts: Pick<ContentDocumentWriteOptions, 'additionalQueriesAfter'> = {},
) {
  const document = await getContentDocumentById(db, documentId)
  if (!document) notFound('Content document not found')

  const existing = await listBlocksForDocument(db, documentId)
  const afterIndex = input.after_block_id ? existing.findIndex(block => block.id === input.after_block_id) : existing.length - 1
  if (input.after_block_id && afterIndex === -1) badRequest('after_block_id was not found in this document')

  const newBlock: ContentBlockWriteInput = {
    // The caller's id when it has one, so the media placements it batches
    // alongside this write address the block that is actually inserted.
    id: input.id,
    source_block_id: input.source_block_id ?? null,
    parent_block_id: input.parent_block_id ?? null,
    type: assertBlockType(input.type),
    position: afterIndex + 1,
    level: input.level ?? null,
    data: asObject(input.data, 'content block data'),
  }
  const snapshots = [
    ...existing.slice(0, afterIndex + 1).map(block => ({
      id: block.id,

      source_block_id: block.source_block_id,
      parent_block_id: block.parent_block_id,
      type: block.type,
      position: block.position,
      level: block.level,
      data: parseBlockData(block),
      updated_at: block.updated_at,
    })),
    newBlock,
    ...existing.slice(afterIndex + 1).map(block => ({
      id: block.id,

      source_block_id: block.source_block_id,
      parent_block_id: block.parent_block_id,
      type: block.type,
      position: block.position,
      level: block.level,
      data: parseBlockData(block),
      updated_at: block.updated_at,
    })),
  ].map((block, index) => ({ ...block, position: index, updated_at: block.position === index ? block.updated_at : null }))

  return await writeDocumentBlocks(db, document, snapshots, opts)
}

export async function replaceContentBlock(
  db: DbClient,
  blockId: string,
  input: { data: Record<string, unknown>; expected_updated_at: string },
  opts: Pick<ContentDocumentWriteOptions, 'additionalQueriesAfter'> = {},
) {
  const current = await getContentBlock(db, blockId)
  const document = await getContentDocumentById(db, current.document_id)
  if (!document) notFound('Content document not found')

  const blocks = await listBlocksForDocument(db, document.id)
  if (blocks.find(block => block.id === blockId)?.updated_at !== input.expected_updated_at) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'Content block was updated by another writer' })
  }
  const snapshots = blocks.map((block) => ({
    id: block.id,

    source_block_id: block.source_block_id,
    parent_block_id: block.parent_block_id,
    type: block.type,
    position: block.position,
    level: block.level,
    data: block.id === blockId ? asObject(input.data, 'content block data') : parseBlockData(block),
    updated_at: block.id === blockId ? null : block.updated_at,
  }))

  return await writeDocumentBlocks(db, document, snapshots, opts)
}

export async function deleteContentBlock(
  db: DbClient,
  blockId: string,
  input: { expected_updated_at: string },
) {
  const current = await getContentBlock(db, blockId)
  const document = await getContentDocumentById(db, current.document_id)
  if (!document) notFound('Content document not found')

  const allBlocks = await listBlocksForDocument(db, document.id)
  if (allBlocks.find(block => block.id === blockId)?.updated_at !== input.expected_updated_at) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'Content block was updated by another writer' })
  }

  const removedIds = new Set<string>([blockId])
  let addedDescendant = true
  while (addedDescendant) {
    addedDescendant = false
    for (const block of allBlocks) {
      if (block.parent_block_id && removedIds.has(block.parent_block_id) && !removedIds.has(block.id)) {
        removedIds.add(block.id)
        addedDescendant = true
      }
    }
  }

  const snapshots = allBlocks
    .filter(block => !removedIds.has(block.id))
    .map((block, index) => ({
      id: block.id,

      source_block_id: block.source_block_id,
      parent_block_id: block.parent_block_id,
      type: block.type,
      position: index,
      level: block.level,
      data: parseBlockData(block),
      updated_at: block.updated_at,
    }))

  return await writeDocumentBlocks(db, document, snapshots)
}

export async function getContentEditorSnapshotForDocument(db: DbClient, document: ContentDocumentRow) {
  const blocks = await listBlocksForDocument(db, document.id)
  return { document, blocks: await attachContentBlockMedia(db, document.id, blocks.map(formatBlockOutline)) }
}

export async function getContentBlocksForDocument(db: DbClient, documentId: string) {
  const document = await getContentDocumentById(db, documentId)
  if (!document) return null
  const blocks = await listBlocksForDocument(db, document.id)
  const outlined = await attachContentBlockMedia(db, document.id, blocks.map(block => ({ ...formatBlockOutline(block), created_at: block.created_at })))
  return await resolveMcpDocumentationBlocks(db, document.id, outlined)
}


export async function updateContentDocument(
  db: DbClient,
  documentId: string,
  input: {
    expected_updated_at: string
    blocks?: ContentBlockInput[]
    changes?: ContentDocumentChanges
    additionalQueriesBefore?: BatchQuery[]
    additionalQueriesAfter?: BatchQuery[]
  },
) {
  const document = await getContentDocumentById(db, documentId)
  if (!document) notFound('Content document not found')
  if (document.updated_at !== input.expected_updated_at) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'Content document was updated by another writer' })
  }
  const snapshots = input.blocks?.map((block, index) => ({
    id: block.id, source_block_id: block.source_block_id ?? null, parent_block_id: block.parent_block_id ?? null,
    type: assertBlockType(block.type), position: index, level: block.level ?? null,
    data: asObject(block.data, `content block ${index} data`), updated_at: null,
  }))
  const result = await writeDocumentBlocks(db, document, snapshots, {
    changes: input.changes, expectedDocument: { id: document.id, updatedAt: input.expected_updated_at },
    additionalQueriesBefore: input.additionalQueriesBefore,
    additionalQueriesAfter: [...(input.additionalQueriesAfter ?? []), publicResourceCacheInvalidationQuery(document.organization_id, `${document.kind}-update`)],
  })
  return { updated_at: result.updated_at }
}

export function prepareContentDocumentUpdate(
  document: ContentDocumentRow,
  input: {
    expected_updated_at: string
    blocks?: ContentBlockInput[]
    changes?: ContentDocumentChanges
    additionalQueriesBefore?: BatchQuery[]
    additionalQueriesAfter?: BatchQuery[]
  },
) {
  if (document.updated_at !== input.expected_updated_at) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'Content document was updated by another writer' })
  }
  const snapshots = input.blocks?.map((block, index) => ({
    id: block.id, source_block_id: block.source_block_id ?? null, parent_block_id: block.parent_block_id ?? null, type: assertBlockType(block.type),
    position: index, level: block.level ?? null, data: asObject(block.data, `content block ${index} data`), updated_at: null,
  }))
  return buildDocumentWriteBatch(document, snapshots, {
    changes: input.changes, expectedDocument: { id: document.id, updatedAt: input.expected_updated_at },
    additionalQueriesBefore: input.additionalQueriesBefore, additionalQueriesAfter: input.additionalQueriesAfter,
  })
}
