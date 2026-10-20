import { getSourceLocale } from '~/server/utils/organization-locales'
import { HTTPError } from 'nitro'

import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { slugifyTitle } from '~/utils/post-slugs'
import { loadExactPublicLocalizations, type ExactPublicLocalization } from '~/server/utils/public-localization'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { documentOfRootSql } from '~/server/utils/content/documents'
import { isArticleCollection, type ArticleCollection } from '~/utils/article-collections'

/**
 * An article's category: a named, ordered grouping the owner manages within
 * one of the site's article collections. Every surface — dashboard, MCP, the
 * public index, sidebar, breadcrumb and category page — reads and writes it
 * here. Categories nest up to MAX_DEPTH levels under a parent in the same
 * collection. A category that still has articles or subcategories is not
 * deleted; the caller is told to move them first.
 */

export const MAX_DEPTH = 3
const NAME_MAX = 100
const DESCRIPTION_MAX = 500
const SLUG_ATTEMPTS = 100

export interface ArticleCategory {
  id: string
  organization_id: string
  collection: ArticleCollection
  name: string
  slug: string
  description: string | null
  /** The category it sits under, or null at the top of the collection. */
  parent_id: string | null
  /** Its place among its siblings. */
  sort_order: number
  article_count: number
  child_count: number
  created_at: string
  updated_at: string
}

export interface PublicArticleCategory extends ArticleCategory {
  locales: string[]
}

type Row = Record<string, unknown>

function badRequest(message: string): never {
  throw new HTTPError({ statusCode: 400, statusMessage: message })
}

function notFound(message: string): never {
  throw new HTTPError({ statusCode: 404, statusMessage: message })
}

function isCategoryUniquenessConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /article_categories_name_unique|article_categories_slug_unique|UNIQUE constraint failed: article_categories\.organization_id, article_categories\.collection/.test(message)
}

function mapRow(row: Row): ArticleCategory {
  if (!isArticleCollection(row.collection)) throw new Error(`Article category ${String(row.id)} has no valid collection`)
  return {
    id: String(row.id), organization_id: String(row.organization_id), collection: row.collection,
    name: String(row.name), slug: String(row.slug),
    description: row.description === null ? null : String(row.description),
    parent_id: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
    sort_order: Number(row.sort_order), article_count: Number(row.article_count), child_count: Number(row.child_count ?? 0),
    created_at: String(row.created_at), updated_at: String(row.updated_at),
  }
}

function requireName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) badRequest('name is required')
  if (value.trim().length > NAME_MAX) badRequest(`name must be at most ${NAME_MAX} characters`)
  return value.trim()
}

function optionalDescription(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') badRequest('description must be a string or null')
  if (value.trim().length > DESCRIPTION_MAX) badRequest(`description must be at most ${DESCRIPTION_MAX} characters`)
  return value.trim() || null
}

function requireCollection(value: unknown): ArticleCollection {
  if (!isArticleCollection(value)) badRequest('collection must be blog or docs')
  return value
}

const SELECT_CATEGORY = `SELECT c.*, (SELECT COUNT(*) FROM article_category_articles m WHERE m.category_id = c.id) AS article_count,
  (SELECT COUNT(*) FROM article_categories k WHERE k.parent_id = c.id) AS child_count FROM article_categories c`

/**
 * A collection's categories as a tree read depth-first: each category, then its
 * subcategories in their order, so a list reads the way the sidebar does.
 */
export function orderCategoryTree<T extends { id: string; parent_id: string | null; sort_order: number; name: string }>(categories: readonly T[]): T[] {
  const byParent = new Map<string | null, T[]>()
  for (const category of categories) byParent.set(category.parent_id, [...(byParent.get(category.parent_id) ?? []), category])
  for (const siblings of byParent.values()) siblings.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const ordered: T[] = []
  const walk = (parentId: string | null) => {
    for (const category of byParent.get(parentId) ?? []) {
      ordered.push(category)
      walk(category.id)
    }
  }
  walk(null)
  return ordered
}

/** How deep a category sits: 1 at the top of its collection. */
function depthOf(categories: ReadonlyMap<string, { parent_id: string | null }>, id: string): number {
  let depth = 0
  for (let current: string | null = id; current; current = categories.get(current)?.parent_id ?? null) depth += 1
  return depth
}

/** How many levels a category and everything under it span: 1 for a category with no subcategories. */
function subtreeHeight(categories: readonly { id: string; parent_id: string | null }[], id: string): number {
  const children = categories.filter(category => category.parent_id === id)
  return 1 + Math.max(0, ...children.map(child => subtreeHeight(categories, child.id)))
}

export async function listArticleCategories(db: DbClient, organizationId: string, collection: ArticleCollection): Promise<ArticleCategory[]> {
  const rows = await queryAll<Row>(db, `${SELECT_CATEGORY} WHERE c.organization_id = ? AND c.collection = ?`, [organizationId, collection])
  return orderCategoryTree(rows.map(mapRow))
}

/**
 * The parent a category may sit under: a category of the same collection, not
 * the category itself or anything under it, and shallow enough that the
 * category and its subtree stay within MAX_DEPTH levels.
 */
function requireParent(categories: readonly ArticleCategory[], parentId: unknown, moving: { id: string } | null): string | null {
  if (parentId === null) return null
  if (typeof parentId !== 'string' || !parentId.trim()) badRequest('parent_id must be a category id or null')
  const byId = new Map(categories.map(category => [category.id, category]))
  if (!byId.has(parentId)) badRequest(`parent_id ${parentId} is not a category of this collection`)
  if (moving) {
    for (let current: string | null = parentId; current; current = byId.get(current)?.parent_id ?? null) {
      if (current === moving.id) badRequest('A category cannot sit under itself or one of its own subcategories')
    }
  }
  const height = moving ? subtreeHeight(categories, moving.id) : 1
  if (depthOf(byId, parentId) + height > MAX_DEPTH) badRequest(`Categories nest at most ${MAX_DEPTH} levels deep`)
  return parentId
}

export async function getArticleCategory(db: DbClient, organizationId: string, categoryId: string): Promise<ArticleCategory> {
  const row = await queryFirst<Row>(db, `${SELECT_CATEGORY} WHERE c.organization_id = ? AND c.id = ?`, [organizationId, categoryId])
  if (!row) notFound('Category not found')
  return mapRow(row)
}

async function uniqueSlug(db: DbClient, organizationId: string, collection: ArticleCollection, name: string): Promise<string> {
  const base = slugifyTitle(name)
  if (!base) badRequest('name must contain letters or numbers')
  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`
    const clash = await queryFirst<{ id: string }>(db, 'SELECT id FROM article_categories WHERE organization_id = ? AND collection = ? AND slug = ?', [organizationId, collection, candidate])
    if (!clash) return candidate
  }
  throw new HTTPError({ statusCode: 409, statusMessage: 'Could not derive a unique category slug' })
}

export async function createArticleCategory(db: DbClient, input: {
  organizationId: string; collection: unknown; name: unknown; description?: unknown; parentId?: unknown; actorId: string
}): Promise<ArticleCategory> {
  const collection = requireCollection(input.collection)
  const name = requireName(input.name)
  const description = optionalDescription(input.description)
  const parentId = input.parentId === undefined ? null : requireParent(await listArticleCategories(db, input.organizationId, collection), input.parentId, null)
  const clash = await queryFirst<{ id: string }>(db, 'SELECT id FROM article_categories WHERE organization_id = ? AND collection = ? AND lower(name) = lower(?)', [input.organizationId, collection, name])
  if (clash) throw new HTTPError({ statusCode: 409, statusMessage: `A ${collection} category named "${name}" already exists (${clash.id})` })
  const slug = await uniqueSlug(db, input.organizationId, collection, name)
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  try {
    await executeBatch(db, [{
      // A new category goes last among its siblings; the owner places it with reorder.
      query: `INSERT INTO article_categories (id, organization_id, collection, name, slug, description, parent_id, sort_order, created_at, updated_at, created_by, updated_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM article_categories WHERE organization_id = ? AND collection = ? AND parent_id IS ?), ?, ?, ?, ?)`,
      params: [id, input.organizationId, collection, name, slug, description, parentId, input.organizationId, collection, parentId, now, now, input.actorId, input.actorId],
    }, publicResourceCacheInvalidationQuery(input.organizationId, 'article_category_created')], { operation: 'Create article category' })
  } catch (error) {
    if (isCategoryUniquenessConflict(error)) throw new HTTPError({ statusCode: 409, statusMessage: 'A category with this name or slug was created. Reload and try again.', cause: error })
    throw error
  }
  return getArticleCategory(db, input.organizationId, id)
}

export async function updateArticleCategory(db: DbClient, input: {
  organizationId: string; categoryId: string; name?: unknown; description?: unknown; parentId?: unknown; actorId: string
}): Promise<ArticleCategory> {
  const existing = await getArticleCategory(db, input.organizationId, input.categoryId)
  if (input.name === undefined && input.description === undefined && input.parentId === undefined) badRequest('Provide name, description or parent_id')
  const name = input.name === undefined ? existing.name : requireName(input.name)
  const parentId = input.parentId === undefined ? existing.parent_id
    : requireParent(await listArticleCategories(db, input.organizationId, existing.collection), input.parentId, existing)
  const moved = parentId !== existing.parent_id
  // The slug is the category page's address; renaming or moving does not move the page.
  // A category moved under another parent goes last among its new siblings.
  try {
    const [updated] = await executeBatch(db, [{
      // Recheck the live tree in the write: concurrent moves can invalidate requireParent's snapshot.
      query: `WITH RECURSIVE
                collection_categories AS (SELECT id, parent_id FROM article_categories WHERE organization_id = ? AND collection = ?),
                ancestors AS (
                  SELECT id, parent_id, 1 AS depth FROM collection_categories WHERE id = ?
                  UNION ALL
                  SELECT c.id, c.parent_id, a.depth + 1 FROM collection_categories c JOIN ancestors a ON c.id = a.parent_id WHERE a.depth < ?
                ),
                subtree AS (
                  SELECT id, 1 AS height FROM collection_categories WHERE id = ?
                  UNION ALL
                  SELECT c.id, s.height + 1 FROM collection_categories c JOIN subtree s ON c.parent_id = s.id WHERE s.height <= ?
                )
              UPDATE article_categories SET name = ?, description = ?, parent_id = ?,
                sort_order = CASE WHEN ? THEN (SELECT COALESCE(MAX(s.sort_order) + 1, 0) FROM article_categories s WHERE s.organization_id = ? AND s.collection = ? AND s.parent_id IS ? AND s.id <> ?) ELSE sort_order END,
                updated_at = ?, updated_by = ? WHERE organization_id = ? AND id = ? AND parent_id IS ?
                AND (? IS NULL OR (EXISTS (SELECT 1 FROM ancestors WHERE parent_id IS NULL) AND NOT EXISTS (SELECT 1 FROM ancestors WHERE id = ?)))
                AND (SELECT COALESCE(MAX(depth), 0) FROM ancestors) + (SELECT MAX(height) FROM subtree) <= ?`,
      params: [input.organizationId, existing.collection, parentId, MAX_DEPTH, input.categoryId, MAX_DEPTH,
        name, input.description === undefined ? existing.description : optionalDescription(input.description), parentId,
        moved ? 1 : 0, input.organizationId, existing.collection, parentId, input.categoryId,
        new Date().toISOString(), input.actorId, input.organizationId, input.categoryId, existing.parent_id,
        parentId, input.categoryId, MAX_DEPTH],
    }, publicResourceCacheInvalidationQuery(input.organizationId, 'article_category_updated')], { operation: 'Update article category' })
    if (updated?.meta.changes !== 1) throw new HTTPError({ statusCode: 409, statusMessage: 'The category hierarchy changed. Reload and try again.' })
  } catch (error) {
    if (isCategoryUniquenessConflict(error)) throw new HTTPError({ statusCode: 409, statusMessage: 'A category with this name already exists. Reload and try again.', cause: error })
    throw error
  }
  return getArticleCategory(db, input.organizationId, input.categoryId)
}

export async function deleteArticleCategory(db: DbClient, input: { organizationId: string; categoryId: string }): Promise<void> {
  const existing = await getArticleCategory(db, input.organizationId, input.categoryId)
  // Deleting a category never decides where its articles go: the owner does.
  // The membership foreign key refuses it anyway; this says why.
  if (existing.child_count > 0) {
    throw new HTTPError({
      statusCode: 409,
      statusMessage: `Category "${existing.name}" still has ${existing.child_count} ${existing.child_count === 1 ? 'subcategory' : 'subcategories'}. Move or delete ${existing.child_count === 1 ? 'it' : 'them'} first, then delete this one.`,
      data: { code: 'ARTICLE_CATEGORY_HAS_SUBCATEGORIES', category_id: existing.id, child_count: existing.child_count },
    })
  }
  if (existing.article_count > 0) {
    throw new HTTPError({
      statusCode: 409,
      statusMessage: `Category "${existing.name}" still has ${existing.article_count} ${existing.article_count === 1 ? 'article' : 'articles'}. Move ${existing.article_count === 1 ? 'it' : 'them'} to another category first, then delete this one.`,
      data: { code: 'ARTICLE_CATEGORY_NOT_EMPTY', category_id: existing.id, article_count: existing.article_count },
    })
  }
  await executeBatch(db, [
    { query: "DELETE FROM resource_localizations WHERE organization_id = ? AND resource_type = 'article_category' AND resource_id = ?", params: [input.organizationId, input.categoryId] },
    { query: 'DELETE FROM article_categories WHERE organization_id = ? AND id = ?', params: [input.organizationId, input.categoryId] },
    publicResourceCacheInvalidationQuery(input.organizationId, 'article_category_deleted'),
  ], { operation: 'Delete article category' })
}

/**
 * Sets the order of one parent's subcategories, or of the collection's top
 * level when parent_id is null. The siblings are named whole: a partial order
 * would leave the unnamed ones wherever they were, which is not an order
 * anyone chose.
 */
export async function reorderArticleCategories(db: DbClient, input: {
  organizationId: string; collection: unknown; parentId?: unknown; categoryIds: unknown; actorId: string
}): Promise<ArticleCategory[]> {
  const collection = requireCollection(input.collection)
  if (!Array.isArray(input.categoryIds) || input.categoryIds.some(id => typeof id !== 'string')) badRequest('category_ids must be an array of ids')
  const ids = input.categoryIds as string[]
  const all = await listArticleCategories(db, input.organizationId, collection)
  const parentId = input.parentId === undefined || input.parentId === null ? null : String(input.parentId)
  if (parentId && !all.some(category => category.id === parentId)) badRequest(`parent_id ${parentId} is not a category of this collection`)
  const existing = all.filter(category => category.parent_id === parentId)
  const intended = new Set(ids)
  if (intended.size !== ids.length || intended.size !== existing.length || existing.some(category => !intended.has(category.id))) {
    badRequest(parentId
      ? `category_ids must list every subcategory of ${parentId} exactly once`
      : `category_ids must list every top-level ${collection} category exactly once`)
  }
  const now = new Date().toISOString()
  await executeBatch(db, [
    ...ids.map((id, index): BatchQuery => ({
      query: 'UPDATE article_categories SET sort_order = ?, updated_at = ?, updated_by = ? WHERE organization_id = ? AND id = ?',
      params: [index, now, input.actorId, input.organizationId, id],
    })),
    publicResourceCacheInvalidationQuery(input.organizationId, 'article_categories_reordered'),
  ], { operation: 'Reorder article categories' })
  return listArticleCategories(db, input.organizationId, collection)
}

/**
 * The write that puts an article in a category, for the article's own create
 * or update batch. The category must belong to the article's organization and
 * collection: a docs category cannot hold a blog post.
 */
export async function articleCategoryMembershipQuery(db: DbClient, input: {
  organizationId: string; articleId: string; collection: ArticleCollection; categoryId: unknown
}): Promise<BatchQuery> {
  if (typeof input.categoryId !== 'string' || !input.categoryId.trim()) badRequest('category_id is required')
  const category = await queryFirst<{ collection: string }>(db, 'SELECT collection FROM article_categories WHERE organization_id = ? AND id = ?', [input.organizationId, input.categoryId])
  if (!category) badRequest(`category_id ${input.categoryId} is not a category of this site`)
  if (category.collection !== input.collection) badRequest(`category_id ${input.categoryId} is a ${category.collection} category, not a ${input.collection} one`)
  return {
    query: `INSERT INTO article_category_articles (article_id, organization_id, category_id) VALUES (?, ?, ?)
            ON CONFLICT(article_id) DO UPDATE SET category_id = excluded.category_id, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    params: [input.articleId, input.organizationId, input.categoryId],
  }
}

/**
 * The categories a public index shows: those with at least one published,
 * listed article, in the owner's order. In another language a category reads
 * its translation, and its own name until it has one: its articles are
 * published in that language, and an untranslated category would otherwise
 * leave them in no group and its breadcrumb pointing at no page.
 */
export async function listPublicArticleCategories(env: CloudflareEnv, db: DbClient, organizationId: string, collection: ArticleCollection, locale: string): Promise<PublicArticleCategory[]> {
  const direct = (await queryAll<Row>(db, `
    SELECT c.*, COUNT(DISTINCT root.id) AS article_count,
      json_group_array(DISTINCT p.locale) FILTER (WHERE p.locale IS NOT NULL) AS locales
      FROM article_categories c
      LEFT JOIN article_category_articles m ON m.category_id = c.id
      LEFT JOIN content_documents root ON root.id = m.article_id AND root.status = 'published' AND root.visibility = 'listed'
      LEFT JOIN content_documents p ON ${documentOfRootSql('p', 'root')}
     WHERE c.organization_id = ? AND c.collection = ?
     GROUP BY c.id
  `, [organizationId, collection])).map(row => ({ ...mapRow(row), locales: JSON.parse(String(row.locales ?? '[]')) as string[] }))
  // A category is public when it or anything under it holds a published
  // article, and it is read in every language anything under it is.
  const byId = new Map(direct.map(category => [category.id, { ...category, locales: new Set(category.locales), public: category.article_count > 0 }]))
  for (const category of direct) {
    if (category.article_count === 0) continue
    for (let current = byId.get(category.parent_id ?? ''); current; current = byId.get(current.parent_id ?? '')) {
      current.public = true
      for (const language of category.locales) current.locales.add(language)
    }
  }
  const rows = orderCategoryTree([...byId.values()].filter(category => category.public))
    .map(({ public: _public, locales, ...category }) => ({ ...category, locales: [...locales] }))
  if (locale === await getSourceLocale(db, organizationId)) return rows
  const translations = new Map((await loadExactPublicLocalizations(env, db, organizationId, locale))
    .filter(localization => localization.resourceType === 'article_category')
    .map(localization => [localization.resourceId, localization.values]))
  return rows.map((row) => {
    const values = translations.get(row.id)
    return values ? {
      ...row,
      name: typeof values.name === 'string' && values.name.trim() ? values.name : row.name,
      description: typeof values.description === 'string' && values.description.trim() ? values.description : row.description,
    } : row
  })
}

/** An article's category as every reader returns it. */
export interface ArticleCategoryRef { id: string; name: string; slug: string }

/** Joins an article's category onto a query whose article root is `rootAlias`. */
export const articleCategoryJoinSql = (rootAlias: string) =>
  `LEFT JOIN article_category_articles acm ON acm.article_id = ${rootAlias}.id LEFT JOIN article_categories ac ON ac.id = acm.category_id`

export const ARTICLE_CATEGORY_SELECT = 'ac.id AS category_id, ac.name AS category_name, ac.slug AS category_slug'

/** Folds the joined category columns into `category`. */
export function attachArticleCategory<T extends Record<string, unknown>>(record: T): T & { category: ArticleCategoryRef | null } {
  const { category_id, category_name, category_slug, ...rest } = record
  return {
    ...rest as T,
    category: typeof category_id === 'string' ? { id: category_id, name: String(category_name), slug: String(category_slug) } : null,
  }
}

/** Articles read in a language other than the source name their category in it. */
export async function localizeArticleCategories<T extends { category: ArticleCategoryRef | null }>(env: CloudflareEnv, db: DbClient, organizationId: string, locale: string, records: T[], loaded?: ExactPublicLocalization[]): Promise<T[]> {
  if (locale === await getSourceLocale(db, organizationId)) return records
  const names = new Map((loaded ?? await loadExactPublicLocalizations(env, db, organizationId, locale))
    .filter(localization => localization.resourceType === 'article_category' && typeof localization.values.name === 'string')
    .map(localization => [localization.resourceId, String(localization.values.name)]))
  return records.map(record => record.category
    ? { ...record, category: { ...record.category, name: names.get(record.category.id) ?? record.category.name } }
    : record)
}

/** The name of an article's category, as a scalar for readers that want the word, not the record. */
export const articleCategoryNameSql = (articleIdExpr: string) =>
  `(SELECT ac2.name FROM article_category_articles acm2 JOIN article_categories ac2 ON ac2.id = acm2.category_id WHERE acm2.article_id = ${articleIdExpr})`
