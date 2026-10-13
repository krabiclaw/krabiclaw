import { getSourceLocale } from '~/server/utils/organization-locales'
import { blogEditorPath } from '~/server/utils/dashboard-links'
import { HTTPError } from 'nitro';

import { execute, executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import {
  attachContentBlockMedia,
  createContentDocumentWithBlocks,
  formatBlockOutline,
  prepareContentDocumentDeletion,
  getContentBlocksForDocument,
  listBlocksForDocument,
  updateContentDocument,
  type ContentDocumentChanges,
  renderContentBlocksToMarkdown,
  type ContentBlockInput,
  type ContentDocumentRow,
} from '~/server/utils/content/documents'
import {
  loadExactPublicLocalizations,
  projectLocalizedMediaAlt,
} from '~/server/utils/public-localization'
import { listPublicLocaleRepresentations } from '~/server/utils/public-locale-representations'
import { slugifyTitle } from '~/utils/post-slugs'
import { ARTICLE_COLLECTIONS, ARTICLE_COLLECTION_SLUGS, isArticleCollection, type ArticleCollection } from '~/utils/article-collections'
import { tenantBlogPostPath } from '~/utils/tenant-blog-route'
import { normalizeBlogSlug, resolveSlugMutation } from '~/utils/blog-editor'
import { creationDedupeKey, creationRequestHash, organizationEventQuery, readCreationRecord } from '~/server/utils/organization-events'
import { mcpPageInfo, type McpPageInfo } from '~/server/utils/mcp-pagination'
import { resolvePublicTemplate } from '~/utils/template-registry'
import { getConfig } from '~/server/utils/organization-config'
import { isPaletteTemplate, resolveSitePalette } from '~/shared/site-palette'
import { buildSingleMediaPlacementQueries, hydrateMediaPlacementRefs, insertInitialMediaPlacements } from '~/server/utils/media-asset-manager'
import { COVER_SELECT, attachCoverMedia, coverJoinSql } from '~/server/utils/content/cover'
import { attachPageQa } from '~/server/utils/location-qa'
import { isSingleMediaPlacement } from '~/shared/media-placement-contract'
import { getMediaPlacements } from '~/server/utils/media-placement'
import { d1JsonStringSet } from '~/server/db/d1-limits'
import { findAuthUsersByIds, type CloudflareEnv } from '~/server/utils/auth'
import { assertPublicOrganizationLanguageEntitlement } from '~/server/utils/localization'
import { findOrganizationById } from '~/server/utils/member-access'
import { refreshSocialCard } from '~/server/utils/social-card'
import { loadPublicSocialMedia } from '~/server/utils/public-social-image'
import { createPreviewToken, PREVIEW_TOKEN_QUERY, PREVIEW_TOKEN_TTL_MS } from '~/server/utils/preview-token'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { getPublishedTenantPage } from '~/server/utils/content/pages'
import { ARTICLE_CATEGORY_SELECT, articleCategoryJoinSql, articleCategoryMembershipQuery, attachArticleCategory, localizeArticleCategories } from '~/server/utils/content/article-categories'
import { renderContentBlocksForLlm } from '~/server/utils/platform-llm'

const BLOG_TITLE_MAX = 200
const BLOG_EXCERPT_MAX = 500
const BLOG_SEO_KEYWORDS_MAX = 500
const MAX_SLUG_ATTEMPTS = 8
export const BLOG_UPDATE_MUTATION_FIELDS: Array<keyof PlatformBlogUpdateInput> = [
  'title',
  'excerpt',
  'collection',
  'category_id',
  'seo_keywords',
  'visibility',
  'slug',
  'redirect_old_slug',
  'reset_slug_override',
  'content_blocks',
]





export interface BlogScope {
  organization_id?: string | null
}

export interface PlatformBlogCreateInput {
  title: string
  slug?: string | null
  content_blocks: Array<ContentBlockInput & { id?: string }>
  excerpt?: string | null
  /** Which of the site's collections the article belongs to. Defaults to the blog. */
  collection?: ArticleCollection | null
  /** The article's category, one of its collection's categories. Required before publishing. */
  category_id?: string
  seo_keywords?: string | null
  visibility?: 'listed' | 'unlisted'
}

export interface PlatformBlogUpdateInput {
  title?: string
  excerpt?: string | null
  collection?: ArticleCollection | null
  /** The article's category, one of its collection's categories. Required before publishing. */
  category_id?: string
  seo_keywords?: string | null
  visibility?: 'listed' | 'unlisted'
  slug?: string | null
  redirect_old_slug?: boolean
  reset_slug_override?: boolean
  content_blocks?: Array<ContentBlockInput & { id?: string }>
  expected_updated_at?: string
}

export interface PlatformBlogLifecycleInput {
  expected_updated_at: string
}

export interface PlatformBlogLifecycleState {
  id: string
  status: 'draft' | 'published'
  published_at: string | null
  updated_at: string
  /** False when the article was already published: nothing changed, and nothing is announced again. */
  changed: boolean
}

export function parseBlogLifecycleInput(body: unknown): PlatformBlogLifecycleInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) badRequest('Request body must be a valid object')
  const record = body as Record<string, unknown>
  const unknownField = Object.keys(record).find(key => key !== 'expected_updated_at')
  if (unknownField) badRequest(`Unknown request field: ${unknownField}`)
  if (typeof record.expected_updated_at !== 'string' || !record.expected_updated_at.trim()) badRequest('expected_updated_at is required')
  return { expected_updated_at: record.expected_updated_at }
}

function badRequest(message: string): never {
  throw new HTTPError({ statusCode: 400, statusMessage: message })
}

function notFound(message: string): never {
  throw new HTTPError({ statusCode: 404, statusMessage: message })
}

// Lets every blog/doc tool accept either the row id or its public slug, so a
// model (or person) holding only a public URL doesn't need a separate
// list-then-match step before it can get/update/publish/delete a post or doc.
async function resolvePlatformContentId(
  db: DbClient,
  kind: 'article',
  identifier: string,
  notFoundMessage: string,
  organizationId: string,
): Promise<string> {
  const byId = await queryFirst<{ id: string }>(db, `SELECT id FROM content_documents WHERE kind = ? AND row_role = 'root' AND organization_id = ? AND id = ? LIMIT 1`, [kind, organizationId, identifier])
  const bySlug = await queryFirst<{ id: string }>(db, `SELECT id FROM content_documents WHERE kind = ? AND row_role = 'root' AND organization_id = ? AND slug = ? LIMIT 1`, [kind, organizationId, identifier])
  if (byId && bySlug && byId.id !== bySlug.id) {
    badRequest('Ambiguous platform content identifier; use the row id.')
  }
  const row = byId ?? bySlug
  if (!row) notFound(notFoundMessage)
  return row.id
}

function randomSlugSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}

function normalizeSlugFromTitle(title: string, fallbackPrefix: 'post') {
  const slug = slugifyTitle(title)
  return slug || `${fallbackPrefix}-${Date.now()}`
}

function isUniqueConstraintError(err: unknown) {
  const message = String((err as ApiValue)?.message || err || '')
  const normalized = message.replace(/["'`]/g, '')
  return normalized.includes('content_documents.slug') && normalized.includes('content_documents.locale')
}

function assertStringLength(value: string | null | undefined, max: number, field: string) {
  if (value != null && value.length > max) {
    badRequest(`${field} exceeds maximum length (${max})`)
  }
}

function articleCollectionOf(value: unknown): ArticleCollection {
  if (value === undefined || value === null) return 'blog'
  if (!isArticleCollection(value)) badRequest(`collection must be one of: ${ARTICLE_COLLECTION_SLUGS.join(', ')}`)
  return value
}

/** The tenant's template and identity, which decide article URLs and editor chrome. */
export async function loadOrganizationTemplate(db: DbClient, organizationId: string) {
  const organization = await queryFirst<{ organization_id: string; theme_id: string | null; vertical: string | null; name: string }>(db, `
    SELECT o.id AS organization_id, o.theme_id, o.vertical, o.name
      FROM organization o
     WHERE o.id = ? LIMIT 1
  `, [organizationId])
  if (!organization) notFound('Organization not found')
  const template = resolvePublicTemplate({ themeId: organization.theme_id, vertical: organization.vertical })
  return { ...organization, template, isPlatform: template.slug === 'platform' }
}

type NormalizedEditorBlock = ContentBlockInput & { id: string; placement_media: Array<{ asset_id: string; slot: string }> }

async function normalizeEditorContentBlocks(
  db: D1Database,
  blocks: Array<ContentBlockInput & { id?: string }>,
  scope: { organizationId: string },
): Promise<NormalizedEditorBlock[]> {
  return await Promise.all(blocks.map(async (block): Promise<NormalizedEditorBlock> => {
    if (!block || typeof block !== 'object' || !block.data || typeof block.data !== 'object' || Array.isArray(block.data)) badRequest('Every content block requires an object data payload')
    if (block.type === 'heading' && (typeof block.data.text !== 'string' || !block.data.text.trim())) badRequest('Heading blocks require non-empty data.text')
    const id = block.id ?? crypto.randomUUID()
    const media = Array.isArray(block.media) ? block.media : []
    if (block.type === 'image' && media.length > 1) badRequest('Image blocks accept one media asset')
    const placementMedia = media.map((item, index) => {
      const assetId = typeof item?.asset_id === 'string' ? item.asset_id.trim() : ''
      if (!assetId) badRequest(`content_blocks media[${index}].asset_id is required`)
      return { asset_id: assetId, slot: typeof item.slot === 'string' && item.slot.trim() ? item.slot.trim() : block.type === 'gallery' ? 'gallery' : 'media' }
    })
    await hydrateMediaPlacementRefs(db, {
      ...scope,
      refs: placementMedia,
      allowedKinds: ['image', 'video'],
      fieldName: `content_blocks.${id}.media`,
    })
    // An image block with no image is nothing: it used to be written anyway,
    // and a post that took fifteen such blocks came back fifteen times from
    // the cover join.
    if (block.type === 'image' && !placementMedia.length) badRequest('Image blocks require one media asset')
    return { ...block, id, data: { ...block.data }, media: placementMedia, placement_media: placementMedia }
  }))
}

async function contentBlockPlacementQueries(
  db: DbClient,
  blocks: NormalizedEditorBlock[],
  scope: { organizationId: string },
  now?: string,
) {
  if (!blocks.length) return []
  const existingRows = await queryAll<{ id: string }>(db, `
    SELECT id FROM content_blocks WHERE id IN (SELECT value FROM json_each(?))
  `, [d1JsonStringSet(blocks.map(block => block.id))])
  const existingIds = new Set(existingRows.map(row => row.id))
  const existingPlacements = await getMediaPlacements(db, {
    organizationId: scope.organizationId,
    ownerType: 'content_block',
    ownerIds: blocks.map(block => block.id),
  })
  const queries: BatchQuery[] = []
  for (const block of blocks) {
    const bySlot = new Map<string, Array<{ asset_id: string }>>()
    for (const item of block.placement_media) {
      const items = bySlot.get(item.slot) ?? []
      items.push({ asset_id: item.asset_id })
      bySlot.set(item.slot, items)
    }
    if (existingIds.has(block.id)) {
      const currentBySlot = new Map<string, string[]>()
      for (const item of existingPlacements.get(block.id) ?? []) {
        const ids = currentBySlot.get(item.slot) ?? []
        ids.push(item.asset_id)
        currentBySlot.set(item.slot, ids)
      }
      for (const slot of new Set([...currentBySlot.keys(), ...bySlot.keys()])) {
        const current = currentBySlot.get(slot) ?? []
        const requested = (bySlot.get(slot) ?? []).map(item => item.asset_id)
        if (current.length === requested.length && current.every((assetId, index) => assetId === requested[index])) continue
        if (!isSingleMediaPlacement({ owner_type: 'content_block', slot })) {
          badRequest(`content_blocks.${block.id}.media cannot replace an existing gallery; use attach/remove/reorder media operations`)
        }
        queries.push(...buildSingleMediaPlacementQueries({
          ...scope,
          placement: { owner_type: 'content_block', owner_id: block.id, slot },
          media: bySlot.get(slot) ?? [],
          now,
        }))
      }
      continue
    }
    queries.push(...[...bySlot.keys()].flatMap(slot => insertInitialMediaPlacements({
        ...scope,
        placement: { owner_type: 'content_block', owner_id: block.id, slot },
        media: bySlot.get(slot) ?? [],
        now,
      })))
  }
  return queries
}

export async function prepareTenantBlogContentBlocks(
  db: D1Database,
  blocks: Array<ContentBlockInput & { id?: string }>,
  organizationId: string,
  now = new Date().toISOString(),
) {
  const normalizedBlocks = await normalizeEditorContentBlocks(db, blocks, { organizationId })
  const placementScope = { organizationId }
  return {
    blocks: normalizedBlocks,
    placementQueries: await contentBlockPlacementQueries(db, normalizedBlocks, placementScope, now),
  }
}

function renderCanonicalBlogBody(blocks: Array<ContentBlockInput & { id?: string }>) {
  return renderContentBlocksToMarkdown(blocks.map((block, position) => ({
    id: block.id ?? `pending-${position}`,
    type: block.type,
    position,
    level: block.level ?? null,
    data_json: JSON.stringify(block.data),
  })))
}

function attachPublished(record: ApiRecord, published: boolean) {
  return { ...record, published }
}

async function normalizeCanonicalBlogBlocks(
  db: D1Database,
  input: Pick<PlatformBlogCreateInput, 'content_blocks'>,
  scope: { organizationId: string },
) {
  if (!Array.isArray(input.content_blocks) || !input.content_blocks.length) badRequest('content_blocks are required')
  return await normalizeEditorContentBlocks(db, input.content_blocks, scope)
}


export interface ContentReviewContext { orgSlug: string }

async function contentReviewUrls(
  record: ApiRecord,
  publicPath: string | null,
  organizationId: string,
  context?: ContentReviewContext,
  env?: CloudflareEnv,
) {
  const id = String(record.id ?? '')
  // Every site's articles, Krabiclaw's included, are edited in the shared dashboard CMS.
  const adminEditUrl = context ? blogEditorPath(context.orgSlug, id) : null
  const isPublished = typeof record.status === 'string' ? record.status === 'published' : Boolean(record.published_at)

  // An unpublished article is previewed the same way everything unpublished is
  // previewed: the site's own preview token, which the tenant host turns into a
  // cookie so the rest of the visit stays authorized.
  let previewUrl: string | null = null
  if (!isPublished && publicPath) {
    if (!env?.PREVIEW_SECRET) throw new HTTPError({ statusCode: 500, statusMessage: 'Preview signing is not configured' })
    const token = await createPreviewToken(env.PREVIEW_SECRET, organizationId, Date.now() + PREVIEW_TOKEN_TTL_MS)
    previewUrl = `${publicPath}?${PREVIEW_TOKEN_QUERY}=${encodeURIComponent(token)}`
  }

  return {
    ...record,
    admin_edit_url: adminEditUrl,
    edit_url: adminEditUrl,
    public_path: publicPath,
    public_url: isPublished ? publicPath : null,
    preview_url: previewUrl,
  }
}

async function resolveTenantContext(db: DbClient, organizationId: string, env?: CloudflareEnv): Promise<ContentReviewContext | undefined> {
  if (!organizationId) return undefined
  if (!env) throw new Error('CloudflareEnv is required to resolve tenant organization context')
  // The dashboard addresses a site by its subdomain, not by `organization.slug`.
  const tenant = await queryFirst<{ subdomain: string | null }>(
    db,
    'SELECT subdomain FROM organization WHERE id = ? LIMIT 1',
    [organizationId],
  )
  if (!tenant?.subdomain) return undefined
  const organization = await findOrganizationById(env, organizationId)
  if (!organization) return undefined
  return { orgSlug: organization.slug }
}

function validateBlogCommon(input: Partial<PlatformBlogCreateInput>, operation: 'create' | 'update') {
  const writable = new Set<string>([...BLOG_UPDATE_MUTATION_FIELDS, ...(operation === 'create' ? [] : ['expected_updated_at'])])
  if (operation === 'create') { writable.delete('redirect_old_slug'); writable.delete('reset_slug_override') }
  const unknown = Object.keys(input).find(field => !writable.has(field))
  if (unknown) badRequest(unknown + ' is not writable through article ' + operation)
  if ('visibility' in input && input.visibility !== undefined && !['listed', 'unlisted'].includes(String(input.visibility))) badRequest('visibility must be listed or unlisted')
  if (input.title !== undefined) assertStringLength(input.title, BLOG_TITLE_MAX, 'title')
  if (input.excerpt !== undefined) assertStringLength(input.excerpt ?? null, BLOG_EXCERPT_MAX, 'excerpt')
  if (input.seo_keywords !== undefined) assertStringLength(input.seo_keywords ?? null, BLOG_SEO_KEYWORDS_MAX, 'seo_keywords')
}

/**
 * The order every article collection is read in, public and in the dashboard:
 * the order its owner set, and among articles never placed (a new one, or a
 * collection nobody has ordered) newest first.
 */
const ARTICLE_ORDER_SQL = (alias: string) => `${alias}.sort_order, ${alias}.published_at IS NULL, ${alias}.published_at DESC, ${alias}.created_at DESC, ${alias}.id DESC`

/**
 * A site's published, listed articles in one collection and one language — the
 * public read of what list_blog_posts returns, in the same order. A translated
 * article is read through its representation, so slug and title are the
 * representation's own; `id` is always the article's, the id MCP and the
 * dashboard name it by.
 */
export async function listPublishedArticles(db: DbClient, env: CloudflareEnv, organizationId: string, collection: ArticleCollection, locale: string) {
  // A language the site has not published is not readable, here or anywhere public.
  await assertPublicOrganizationLanguageEntitlement(env, db, organizationId, locale)
  const sql = `
    SELECT
      root.id, p.title, p.slug, p.summary AS excerpt, (root.metadata_json ->> '$.collection') AS collection,
      ${ARTICLE_CATEGORY_SELECT}, p.seo_keywords,
      root.published_at, p.updated_at, root.sort_order, ${COVER_SELECT}
    FROM content_documents root
    JOIN content_documents p ON COALESCE(p.root_id, p.id) = root.id AND p.locale = ?
    ${coverJoinSql('p')}
    ${articleCategoryJoinSql('root')}
    WHERE root.kind = 'article' AND root.row_role = 'root' AND root.status = 'published' AND root.organization_id = ? AND root.visibility = 'listed'
      AND (root.metadata_json ->> '$.collection') = ?
    ORDER BY ${ARTICLE_ORDER_SQL('root')}
    LIMIT 200
  `
  const rows = (await queryAll<ApiRecord>(db, sql, [locale, organizationId, collection])).map(row => attachArticleCategory(attachCoverMedia(row)))
  return localizeArticleCategories(env, db, organizationId, locale, rows)
}

/**
 * The languages a collection's index is read in: every language the site
 * publishes, at its locale prefix. The index lists that language's articles,
 * and its categories' pages follow the same prefix.
 */
export async function listArticleCollectionRepresentations(env: CloudflareEnv, db: DbClient, organizationId: string, collection: ArticleCollection) {
  return listPublicLocaleRepresentations(env, db, { organizationId, sourcePath: ARTICLE_COLLECTIONS[collection].pathPrefix, publishedLocaleRoute: true })
}

/**
 * What a collection's index says about itself: the title and summary of the
 * page the site publishes at the index's own path (/blog, /docs), when it
 * publishes one. A site that publishes none has an index titled by its
 * collection's name alone.
 */
export async function getArticleCollectionIndex(db: DbClient, organizationId: string, collection: ArticleCollection, locale: string) {
  const page = await getPublishedTenantPage(db, organizationId, ARTICLE_COLLECTIONS[collection].pathPrefix, locale)
  return page ? { title: page.title, summary: page.summary } : null
}

/**
 * Sets the order a collection is read in. It is chosen whole — every article
 * in the collection named once, drafts included, like a menu's collections: a
 * partial order would leave the unnamed articles wherever they were, which is
 * not an order anyone picked. Positions start at 1, so an article written
 * after the order was set (sort_order 0) leads until it is placed. Reordering
 * is not an edit to any article, so no article's updated_at — its published
 * "modified" date — moves.
 */
export async function reorderArticles(db: DbClient, organizationId: string, collection: ArticleCollection, postIds: string[]) {
  const existing = await queryAll<{ id: string }>(db, `SELECT id FROM content_documents
    WHERE kind = 'article' AND row_role = 'root' AND organization_id = ? AND (metadata_json ->> '$.collection') = ?`, [organizationId, collection])
  const intended = new Set(postIds)
  if (intended.size !== postIds.length || intended.size !== existing.length || existing.some(row => !intended.has(row.id))) {
    badRequest(`post_ids must list every ${collection} article exactly once`)
  }
  // One statement, so the order is applied whole or not at all: it changes no
  // row unless the ids are still exactly the collection's articles. An article
  // deleted or moved to the other collection since the check above leaves every
  // position as it was. Positions come from the JSON array, which keeps the bind
  // count constant however long the collection is.
  const order = JSON.stringify(postIds)
  const inCollection = `organization_id = ? AND kind = 'article' AND row_role = 'root' AND (metadata_json ->> '$.collection') = ?`
  const [result] = await executeBatch(db, [
    {
      query: `UPDATE content_documents SET sort_order = (SELECT j.key + 1 FROM json_each(?) j WHERE j.value = content_documents.id)
        WHERE ${inCollection}
          AND (SELECT COUNT(*) FROM content_documents WHERE ${inCollection}) = json_array_length(?)
          AND (SELECT COUNT(*) FROM content_documents d JOIN json_each(?) j ON j.value = d.id
                WHERE d.organization_id = ? AND d.kind = 'article' AND d.row_role = 'root' AND (d.metadata_json ->> '$.collection') = ?) = json_array_length(?)`,
      params: [order, organizationId, collection, organizationId, collection, order, order, organizationId, collection, order],
    },
    publicResourceCacheInvalidationQuery(organizationId, 'articles-reordered'),
  ])
  if (Number(result?.meta.changes ?? 0) !== postIds.length) {
    throw new HTTPError({ statusCode: 409, statusMessage: `The ${collection} changed while it was being reordered; reload and try again` })
  }
}

export async function listBlogPosts(
  db: DbClient, organizationId: string, status: string | null | undefined, env: CloudflareEnv | undefined,
  window: { limit: number; offset: number }, resource: { resource: string }, collection: ArticleCollection | null = null,
): Promise<{ posts: ApiRecord[]; page_info: McpPageInfo }> {
  if (status && status !== 'draft' && status !== 'published') badRequest('status must be draft or published')
  const rows = await queryAll<ApiRecord>(db, `SELECT
      p.id, p.title, p.slug, p.summary AS excerpt, (p.metadata_json ->> '$.collection') AS collection, ${ARTICLE_CATEGORY_SELECT}, p.status, p.visibility,
      p.seo_keywords, p.sort_order,
      ${COVER_SELECT},
      p.published_at, p.created_at, p.updated_at
    FROM content_documents p
    ${coverJoinSql('p')}
    ${articleCategoryJoinSql('p')}
    WHERE p.kind = 'article' AND p.row_role = 'root' AND p.organization_id = ? ${status ? 'AND p.status = ?' : ''}
      ${collection ? "AND (p.metadata_json ->> '$.collection') = ?" : ''}
    ORDER BY ${ARTICLE_ORDER_SQL('p')} LIMIT ? OFFSET ?`,
  [organizationId, ...(status ? [status] : []), ...(collection ? [collection] : []), window.limit + 1, window.offset])
  const page = rows.slice(0, window.limit)
  const [context, organization] = await Promise.all([resolveTenantContext(db, organizationId, env), loadOrganizationTemplate(db, organizationId)])
  const posts = await Promise.all(page.map((record) => {
    const slug = typeof record.slug === 'string' ? record.slug : ''
    const publicPath = slug ? tenantBlogPostPath(organization.template, slug, articleCollectionOf(record.collection)) : null
    return contentReviewUrls(attachArticleCategory(attachCoverMedia(attachPublished(record, Boolean(record.published_at)))), publicPath, organizationId, context, env)
  }))
  return { posts, page_info: mcpPageInfo(window, page.length, rows.length > window.limit, resource) }
}

export async function getBlogPost(db: DbClient, postIdOrSlug: string, organizationId: string, env?: CloudflareEnv) {
  const postId = await resolvePlatformContentId(db, 'article', postIdOrSlug, 'Post not found', organizationId)
  const post = await queryFirst<ApiRecord | null>(
    db,
    `SELECT
       p.id, p.title, p.slug, p.summary AS excerpt, (p.metadata_json ->> '$.collection') AS collection, ${ARTICLE_CATEGORY_SELECT}, p.status, p.visibility,
       p.first_published_at, (p.metadata_json ->> '$.slug_manually_overridden') AS slug_manually_overridden,
       p.seo_keywords, p.sort_order,
       ${COVER_SELECT},
       p.organization_id, p.kind, p.row_role, p.root_id, p.locale,
       p.published_at, p.created_at, p.updated_at
     FROM content_documents p
     ${coverJoinSql('p')}
     ${articleCategoryJoinSql('p')}
     WHERE p.kind = 'article' AND p.row_role = 'root' AND p.id = ?`,
    [postId],
  )
  if (!post) notFound('Post not found')
  // The row above IS the article's content document, and the blocks are read
  // once for both shapes the response needs: the outline the editor renders
  // and the raw rows the markdown body is built from. This used to re-read the
  // document and then the blocks a second time.
  const { organization_id, kind, row_role, root_id, locale, ...postFields } = post
  const document = {
    id: String(post.id), organization_id: String(organization_id),
    kind: String(kind), row_role: String(row_role),
    root_id: root_id === null || root_id === undefined ? null : String(root_id),
    locale: String(locale), created_at: String(post.created_at), updated_at: String(post.updated_at),
  } as ContentDocumentRow
  const rawBlocks = await listBlocksForDocument(db, document.id)
  const contentDocument = {
    document,
    blocks: await attachContentBlockMedia(db, document.id, rawBlocks.map(formatBlockOutline)),
  }
  const slug = typeof postFields.slug === 'string' ? postFields.slug : ''
  const [context, organization] = await Promise.all([resolveTenantContext(db, organizationId, env), loadOrganizationTemplate(db, organizationId)])
  const publicPath = slug ? tenantBlogPostPath(organization.template, slug, articleCollectionOf(postFields.collection)) : null
  // The canvas wears the site's light palette, so a draft reads as it will publish.
  const templateSlug = organization.template.slug
  const editorColors = isPaletteTemplate(templateSlug)
    ? resolveSitePalette(templateSlug, (await getConfig(db, organizationId)).palette).light
    : null
  return {
    ...await contentReviewUrls(attachArticleCategory(attachCoverMedia(attachPublished(postFields, Boolean(postFields.published_at)))), publicPath, organizationId, context, env),
    body: renderContentBlocksToMarkdown(rawBlocks),
    content_document: contentDocument,
    editor_template: organization.template.slug,
    editor_colors: editorColors,
    editor_organization_name: organization.name,
  }
}

async function getPublicOrganizationBlogPost(db: DbClient, organizationId: string, collection: ArticleCollection, slug: string, env: CloudflareEnv, previewAuthorized = false) {
  const post = await queryFirst<ApiRecord>(db, `
    SELECT
      p.id, p.title, p.slug, p.summary AS excerpt, ${ARTICLE_CATEGORY_SELECT}, p.seo_keywords, p.visibility,
      p.published_at, p.created_at, p.updated_at,
      p.author_id,
      ${COVER_SELECT}
    FROM content_documents p
    ${coverJoinSql('p')}
    ${articleCategoryJoinSql('p')}
    WHERE p.kind = 'article' AND p.row_role = 'root' AND p.slug = ? AND p.organization_id = ? AND (p.metadata_json ->> '$.collection') = ?
      ${previewAuthorized ? "AND p.status IN ('draft', 'published')" : "AND p.status = 'published'"}
    LIMIT 1
  `, [slug, organizationId, collection])

  if (!post) return null

  const [loadedBlocks, organization] = await Promise.all([
    getContentBlocksForDocument(db, String(post.id)),
    loadOrganizationTemplate(db, organizationId),
  ])
  if (!loadedBlocks) throw new HTTPError({ statusCode: 500, statusMessage: 'Blog content document is missing' })
  const articlePath = tenantBlogPostPath(organization.template, slug, collection)
  const contentBlocks = await attachPageQa(db, organizationId, articlePath, loadedBlocks)
  const socialMedia = (await loadPublicSocialMedia(db, organizationId, 'content_document', [String(post.id)])).get(String(post.id))
  const { author_id: authorId, ...postRecord } = post
  const authors = await findAuthUsersByIds(env, [authorId as string | null])
  const author = typeof authorId === 'string' ? authors.get(authorId) ?? null : null
  return {
    ...attachArticleCategory(attachCoverMedia({ ...postRecord, content_blocks: contentBlocks,
      body: renderContentBlocksForLlm(contentBlocks) })),
    media: socialMedia?.media ?? [],
    social_image: socialMedia?.social_image ?? null,
    author: author ? { id: author.id, name: author.name, image: author.image } : null,
  }
}

/**
 * One published article of a collection, by slug, in the locale asked for —
 * the read behind every article page on every template. An article is found
 * only in its own collection, so a doc is not also served under /blog.
 */
export async function getPublishedBlogPost(
  db: DbClient,
  organizationId: string,
  collection: ArticleCollection,
  slug: string,
  locale: string,
  env: CloudflareEnv,
  previewAuthorized = false,
) {
  const active = await queryFirst<{ id: string }>(db, `SELECT id FROM organization WHERE id = ? AND status = 'active' LIMIT 1`, [organizationId])
  if (!active) return null
  const { template } = await loadOrganizationTemplate(db, organizationId)
  const pathOf = (articleSlug: string) => tenantBlogPostPath(template, articleSlug, collection)
  if (locale === await getSourceLocale(db, organizationId)) {
    const post = await getPublicOrganizationBlogPost(db, organizationId, collection, slug, env, previewAuthorized)
    if (!post || typeof post.id !== 'string') return post
    return {
      ...post,
      localeRepresentations: await listPublicLocaleRepresentations(env, db, {
        organizationId,
        sourcePath: pathOf(slug),
        documentId: post.id,
      }),
    }
  }

  const localizations = await loadExactPublicLocalizations(env, db, organizationId, locale)
  const row = await queryFirst<{ id: string; root_id: string; title: string | null; summary: string | null;
    seo_keywords: string | null;
    source_slug: string; updated_at: string }>(db, `
    SELECT d.id, d.root_id, d.title, d.summary, d.seo_keywords,
           d.updated_at, root.slug AS source_slug
      FROM content_documents d JOIN content_documents root ON root.id = d.root_id
     WHERE d.organization_id = ? AND d.locale = ? AND d.path = ? AND d.row_role = 'representation'
       AND root.kind = 'article' AND root.row_role = 'root' AND (root.metadata_json ->> '$.collection') = ?
       ${previewAuthorized ? '' : "AND root.status = 'published'"} LIMIT 1
  `, [organizationId, locale, pathOf(slug), collection])
  if (!row) return null
  const canonical = await getPublicOrganizationBlogPost(db, organizationId, collection, row.source_slug, env, previewAuthorized)
  if (!canonical) return null
  const [outlineBlocks, social] = await Promise.all([
    getContentBlocksForDocument(db, row.id),
    loadPublicSocialMedia(db, organizationId, 'content_document', [row.id]),
  ])
  if (!outlineBlocks) throw new HTTPError({ statusCode: 500, statusMessage: 'Documentation content document is missing' })
  const contentBlocks = (await attachPageQa(db, organizationId, pathOf(row.source_slug), outlineBlocks, locale))
    .map(block => ({ ...block, media: projectLocalizedMediaAlt(block.media.map(item => ({ ...item, alt_text: item.alt_text ?? null })), localizations) }))
  return { ...canonical, id: row.id, title: row.title, excerpt: row.summary, slug,
    seo_keywords: row.seo_keywords,
    category: (await localizeArticleCategories(env, db, organizationId, locale, [canonical]))[0]!.category,
    updated_at: row.updated_at, body: renderContentBlocksForLlm(contentBlocks),
    content_blocks: contentBlocks,
    media: projectLocalizedMediaAlt(social.get(row.id)?.media ?? [], localizations),
    social_image: social.get(row.id)?.social_image ?? null,
    localeRepresentations: await listPublicLocaleRepresentations(env, db, { organizationId,
      sourcePath: pathOf(row.source_slug), documentId: row.root_id }),
  }
}

/**
 * Creates a draft article. Publication is `updateBlogLifecycle`'s alone. The
 * idempotency key makes a repeat of the same request return the article it
 * made; a different request under the key conflicts; a deleted one is gone.
 */
export async function createBlogPost(
  db: D1Database,
  authorId: string,
  input: PlatformBlogCreateInput & { idempotency_key?: string },
  scope: BlogScope = {},
  env?: CloudflareEnv,
) {
  const { idempotency_key: rawKey, ...article } = input
  const idempotencyKey = typeof rawKey === 'string' ? rawKey.trim() : ''
  if (!idempotencyKey || idempotencyKey.length > 200) badRequest('idempotency_key must be 1 to 200 characters')
  if (!article.title?.trim()) badRequest('title is required')
  const organizationId = scope.organization_id
  if (!organizationId) badRequest('organization_id is required')
  if (!env?.PREVIEW_SECRET) throw new HTTPError({ statusCode: 500, statusMessage: 'Article preview signing is not configured' })
  await loadOrganizationTemplate(db, organizationId)
  validateBlogCommon(article, 'create')
  const requestHash = await creationRequestHash(article)
  const dedupeKey = creationDedupeKey('article', organizationId, idempotencyKey)
  const replay = async () => {
    const record = await readCreationRecord(db, dedupeKey)
    if (!record) return null
    if (record.requestHash !== requestHash) throw new HTTPError({ statusCode: 409, statusMessage: 'This idempotency_key was already used for a different article' })
    const existing = await queryFirst<{ id: string }>(db, "SELECT id FROM content_documents WHERE id = ? AND kind = 'article' AND row_role = 'root'", [record.entityId])
    if (!existing) throw new HTTPError({ statusCode: 410, statusMessage: 'The article this idempotency_key created has been deleted; it is not created again' })
    return await createdArticleResult(db, record.entityId, organizationId, env)
  }
  const earlier = await replay()
  if (earlier) return earlier
  const collection = articleCollectionOf(article.collection)
  const placementScope = { organizationId }
  const id = crypto.randomUUID()
  const customSlug = typeof article.slug === 'string' && article.slug.trim()
    ? normalizeBlogSlug(article.slug)
    : null
  const slugBase = customSlug ?? normalizeSlugFromTitle(article.title, 'post')
  const now = new Date().toISOString()
  if (article.visibility && !['listed', 'unlisted'].includes(article.visibility)) badRequest('visibility must be listed or unlisted')
  const canonicalBlocks = await normalizeCanonicalBlogBlocks(db, article, placementScope)
  const canonicalBody = renderCanonicalBlogBody(canonicalBlocks)

  const slugAttempts = customSlug ? 1 : MAX_SLUG_ATTEMPTS
  for (let attempt = 0; attempt < slugAttempts; attempt++) {
    const slug = attempt === 0 ? slugBase : `${slugBase}-${randomSlugSuffix()}`
    try {
      await createContentDocumentWithBlocks(db, {
        id, rowRole: 'root', locale: await getSourceLocale(db, organizationId), kind: 'article', organizationId,
        title: article.title, slug, summary: article.excerpt ?? null, status: 'draft', visibility: article.visibility ?? 'listed',
        authorId, seoKeywords: article.seo_keywords,
        metadata: { collection, slug_manually_overridden: customSlug ? 1 : 0 },
      }, canonicalBlocks, { bodyMarkdown: canonicalBody,
        additionalQueriesAfter: [
          ...(article.category_id === undefined ? [] : [await articleCategoryMembershipQuery(db, { organizationId, articleId: id, collection, categoryId: article.category_id })]),
          ...await contentBlockPlacementQueries(db, canonicalBlocks, placementScope, now),
          organizationEventQuery({ organizationId, actorId: authorId, eventType: 'article.created', entityType: 'article', entityId: id,
            metadata: { request_hash: requestHash }, dedupeKey }),
        ],
      })
      await refreshSocialCard({ db, env, owner: { owner_type: 'content_document', owner_id: id }, actorId: authorId })
      return await createdArticleResult(db, id, organizationId, env)
    } catch (err) {
      if (/UNIQUE constraint failed: activity_entries\.dedupe_key/.test(String(err))) {
        const concurrent = await replay()
        if (concurrent) return concurrent
      }
      if (customSlug && isUniqueConstraintError(err)) badRequest('slug is already in use')
      if (isUniqueConstraintError(err) && attempt < slugAttempts - 1) continue
      throw err
    }
  }

  throw new HTTPError({ statusCode: 500, statusMessage: 'Failed to create post' })
}

async function createdArticleResult(db: DbClient, id: string, organizationId: string, env: CloudflareEnv) {
  const post = await getBlogPost(db, id, organizationId, env)
  return {
    success: true,
    id,
    slug: post.slug,
    published_at: null,
    admin_edit_url: post.admin_edit_url,
    edit_url: post.edit_url,
    public_path: post.public_path,
    public_url: post.public_url,
    preview_url: post.preview_url,
    post,
  }
}

/**
 * Publishes a draft article. Publishing one that is already published changes
 * nothing — not its date, not its announcement — and says so.
 */
export async function updateBlogLifecycle(
  db: D1Database,
  postIdOrSlug: string,
  input: PlatformBlogLifecycleInput,
  organizationId: string,
): Promise<PlatformBlogLifecycleState> {
  if (!input.expected_updated_at?.trim()) badRequest('expected_updated_at is required')
  const sourceId = await resolvePlatformContentId(db, 'article', postIdOrSlug, 'Post not found', organizationId)
  const source = await queryFirst<{ id: string; status: string; published_at: string | null; updated_at: string }>(db,
    "SELECT id, status, published_at, updated_at FROM content_documents WHERE id = ? AND row_role = 'root' AND kind = 'article'", [sourceId])
  if (!source) notFound('Post not found')
  if (source.status === 'published') return { id: source.id, status: 'published', published_at: source.published_at, updated_at: source.updated_at, changed: false }
  if (source.updated_at !== input.expected_updated_at) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'Article was updated by another writer' })
  }
  // A published article is always in a category: its index, sidebar and breadcrumb are built from them.
  const categorized = await queryFirst<{ category_id: string }>(db, 'SELECT category_id FROM article_category_articles WHERE article_id = ?', [source.id])
  if (!categorized) badRequest('Choose a category before publishing (category_id)')
  const committedAt = new Date(Math.max(Date.now(), Date.parse(source.updated_at) + 1)).toISOString()
  const [result] = await executeBatch(db, [{ query: `UPDATE content_documents SET
    published_at = COALESCE(published_at, ?), first_published_at = COALESCE(first_published_at, ?),
    status = 'published', updated_at = ? WHERE id = ? AND kind = 'article' AND row_role = 'root' AND updated_at = ? AND status = 'draft'`,
  params: [committedAt, committedAt, committedAt, source.id, input.expected_updated_at] },
  publicResourceCacheInvalidationQuery(organizationId, 'article-publication')])
  if (Number(result?.meta.changes ?? 0) !== 1) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'Article was updated by another writer' })
  }
  return { id: source.id, status: 'published', published_at: source.published_at ?? committedAt, updated_at: committedAt, changed: true }
}

export async function updateBlogPost(
  db: D1Database, postIdOrSlug: string, input: PlatformBlogUpdateInput,
  organizationId: string, env?: CloudflareEnv,
) {
  if (!BLOG_UPDATE_MUTATION_FIELDS.some(field => input[field] !== undefined)) badRequest('At least one blog mutation field is required')
  const postId = await resolvePlatformContentId(db, 'article', postIdOrSlug, 'Post not found', organizationId)
  validateBlogCommon(input, 'update')
  const current = await queryFirst<{ organization_id: string; collection: string | null; title: string; slug: string;
    first_published_at: string | null; slug_manually_overridden: number; updated_at: string }>(db, `
    SELECT organization_id, metadata_json ->> '$.collection' AS collection, title, slug, first_published_at,
      metadata_json ->> '$.slug_manually_overridden' AS slug_manually_overridden, updated_at
    FROM content_documents WHERE id = ? AND kind = 'article' AND row_role = 'root'`, [postId])
  if (!current) notFound('Post not found')
  if (input.content_blocks !== undefined && !input.expected_updated_at) badRequest('expected_updated_at is required with content_blocks')
  const effectiveCollection = articleCollectionOf(input.collection === undefined ? current.collection : input.collection)
  // Its category belongs to its collection, so moving an article to the other
  // collection names the category it goes into there.
  if (effectiveCollection !== articleCollectionOf(current.collection) && input.category_id === undefined) {
    badRequest(`Moving an article to ${effectiveCollection} needs a category_id from ${effectiveCollection}`)
  }
  const categoryMembership = input.category_id === undefined ? [] : [await articleCategoryMembershipQuery(db, { organizationId, articleId: postId, collection: effectiveCollection, categoryId: input.category_id })]
  const placementScope = { organizationId }
  const normalizedBlocks = input.content_blocks === undefined ? undefined : await normalizeEditorContentBlocks(db, input.content_blocks, placementScope)
  const metadata: Record<string, unknown> = {}
  const changes: ContentDocumentChanges = { metadata }
  if (input.title !== undefined) {
    if (!input.title.trim()) badRequest('title cannot be blank')
    changes.title = input.title
    if (!current.first_published_at && !current.slug_manually_overridden && input.slug === undefined) changes.slug = normalizeBlogSlug(input.title)
  }
  if (input.reset_slug_override && input.slug !== undefined && input.slug !== null) badRequest('reset_slug_override cannot be combined with a manual slug')
  const slugMutation = resolveSlugMutation({ requestedSlug: input.reset_slug_override ? null : input.slug,
    title: input.title ?? current.title, currentSlug: current.slug, manuallyOverridden: Boolean(current.slug_manually_overridden) })
  const requestedSlug = input.slug !== undefined || input.reset_slug_override ? slugMutation.slug : changes.slug
  if (requestedSlug && requestedSlug !== current.slug) {
    const redirect = await queryFirst<{ id: string }>(db, `SELECT id FROM organization_redirects WHERE organization_id = ? AND locale = (SELECT locale FROM organization_locales WHERE organization_id = ? AND is_source = 1) AND from_path IN (?, ?, ?) LIMIT 1`,
      [organizationId, organizationId, `/blog/${requestedSlug}`, `/article/${requestedSlug}`, `/${requestedSlug}`])
    if (redirect) badRequest('Slug collides with redirect history')
    changes.slug = requestedSlug
    if (input.slug !== undefined || input.reset_slug_override) metadata.slug_manually_overridden = slugMutation.manuallyOverridden ? 1 : 0
  } else if (input.reset_slug_override) metadata.slug_manually_overridden = 0
  for (const field of ['seo_keywords', 'visibility'] as const) {
    if (input[field] !== undefined) changes[field] = input[field]
  }
  if (input.excerpt !== undefined) changes.summary = input.excerpt
  if (input.collection !== undefined) metadata.collection = effectiveCollection
  const now = new Date().toISOString()
  try {
    await updateContentDocument(db, postId, {
      expected_updated_at: input.expected_updated_at ?? current.updated_at, blocks: normalizedBlocks, changes,
      additionalQueriesAfter: [...(normalizedBlocks ? await contentBlockPlacementQueries(db, normalizedBlocks, placementScope, now) : []),
        ...categoryMembership,
        ...(input.visibility === undefined && input.category_id === undefined ? [] : [publicResourceCacheInvalidationQuery(organizationId, 'article-visibility')])],
    })
    if (requestedSlug && requestedSlug !== current.slug && current.first_published_at && input.redirect_old_slug !== false) {
      await createBlogRedirect(db, postId, organizationId, current.slug)
    }
    const post = await getBlogPost(db, postId, organizationId, env)
    // Title and excerpt are drawn on the card, and the blocks hold its leading
    // picture. Slug and visibility are not on it.
    const cardInputChanged = input.title !== undefined || input.excerpt !== undefined || normalizedBlocks !== undefined
    if (env && cardInputChanged) await refreshSocialCard({ db, env, owner: { owner_type: 'content_document', owner_id: postId } })
    return { success: true, admin_edit_url: post.admin_edit_url, edit_url: post.edit_url,
      public_path: post.public_path, public_url: post.public_url, preview_url: post.preview_url, post }
  } catch (error) {
    if (isUniqueConstraintError(error)) badRequest('Slug already in use')
    throw error
  }
}

export async function deleteBlogPost(db: D1Database, postIdOrSlug: string, organizationId: string) {
  const postId = await resolvePlatformContentId(db, 'article', postIdOrSlug, 'Post not found', organizationId)
  const document = await getContentDocumentById(db, postId)
  if (!document) notFound('Document not found')
  await executeBatch(db, prepareContentDocumentDeletion({ documentId: document.id,
    organizationId: document.organization_id }))
  return { success: true }
}

/**
 * The permanent redirect a published article's old address keeps when its slug
 * changes. It lives beside the slug change that needs it.
 */
async function createBlogRedirect(db: D1Database, postId: string, organizationId: string, oldSlug: string) {
  const now = new Date().toISOString()
  const post = await queryFirst<{ id: string; organization_id: string; slug: string; theme_id: string | null }>(db, `
    SELECT p.id, p.organization_id, p.slug, s.theme_id
      FROM content_documents p JOIN organization s ON s.id = p.organization_id
     WHERE p.kind = 'article' AND p.row_role = 'root' AND p.id = ? AND p.organization_id = ? LIMIT 1
  `, [postId, organizationId])
  if (!post) throw new HTTPError({ statusCode: 400, statusMessage: 'Blog redirect scope must match its post' })
  const oldPath = tenantBlogPostPath({ themeId: post.theme_id }, oldSlug)
  const newPath = tenantBlogPostPath({ themeId: post.theme_id }, post.slug)
  // The scope check is the SELECT above: the post was read under the caller's
  // organization, so the redirect cannot be written against another tenant's.
  await execute(db, `INSERT INTO organization_redirects
    (id, organization_id, locale, owner_type, owner_id, from_path, to_path, status_code, behavior, reason, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 301, 'redirect', ?, ?, ?, ?)
    ON CONFLICT(organization_id, locale, from_path) DO UPDATE SET owner_type = excluded.owner_type, owner_id = excluded.owner_id,
      to_path = excluded.to_path, status_code = 301, behavior = 'redirect', reason = excluded.reason, source = excluded.source, updated_at = excluded.updated_at`,
  [crypto.randomUUID(), post.organization_id, await getSourceLocale(db, post.organization_id), 'content_document', postId, oldPath, newPath, 'blog_slug_change', 'blog', now, now])
}
