import { HTTPError } from 'nitro'
import { ARTICLE_COLLECTIONS, collectionArticlePath, isArticleCollection } from '~/utils/article-collections'
import { tenantBlogPostPath } from '~/utils/tenant-blog-route'
import { PLATFORM_TEMPLATE } from '~/utils/template-registry'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { queryAll, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { getPlatformOrganization } from '~/server/utils/platform-organization'
import { resolveMcpDocumentationBlocks } from '~/server/utils/mcp-documentation'
import {
  PLATFORM_KNOWLEDGE_FAQ_ENTRIES,
  PLATFORM_KNOWLEDGE_PAGE_ENTRIES,
  PLATFORM_KNOWLEDGE_ROUTE_ENTRIES,
  type PlatformKnowledgeResultType,
  type PlatformKnowledgeSurface,
} from '~/config/platform-knowledge'
import { resolveProductPresentation } from '~/utils/product-presentation'
import { blogEditorPath, brandEditorPath, collectionEditorPath, locationEditorPath, pageEditorPath, postEditorPath, productEditorPath, qaEditorPath } from '~/server/utils/dashboard-links'
import type { PublicSearchTypeFilter } from '~/server/utils/platform-search-types'
import { renderContentBlocksForLlm } from '~/server/utils/platform-llm'
import { articleCategoryNameSql } from '~/server/utils/content/article-categories'

const AI_SEARCH_CUSTOM_METADATA: AiSearchConfig['custom_metadata'] = [
  { field_name: 'record_id', data_type: 'text' },
  { field_name: 'type', data_type: 'text' },
  { field_name: 'surface', data_type: 'text' },
  { field_name: 'display', data_type: 'text' },
  { field_name: 'organization_id', data_type: 'text' },
]
// AI Search caps an instance at five declared custom metadata fields ("Too big: expected
// array to have <=5 items", returned by the config API), and all five above are read back
// or filtered on. The rebuild's `content_hash` is therefore written as undeclared item
// metadata: it is never filtered on, only compared after `items.list()` returns it.


export type PublicSearchType = PlatformKnowledgeResultType

export interface PublicSearchResult {
  id: string
  type: PublicSearchType
  title: string
  path: string
  snippet: string
  surface: PlatformKnowledgeSurface
  section: string
  icon: string
  score: number
}

interface SearchOptions {
  limit?: number
  type?: PublicSearchTypeFilter
  surface?: PlatformKnowledgeSurface
  organizationId?: string | null
}

interface PlatformDocSearchRow {
  id: string
  title: string
  slug: string
  category: string | null
  excerpt: string | null
  seo_keywords: string | null
}

interface PlatformBlogSearchRow {
  id: string
  title: string
  slug: string
  excerpt: string | null
  category: string | null
  seo_keywords: string | null
}

type TenantBlogSearchRow = PlatformBlogSearchRow

interface PlatformKnowledgeDocument {
  id: string
  key: string
  type: PlatformKnowledgeResultType
  title: string
  path: string
  snippet: string
  section: string
  icon: string
  body: string
  surfaces: PlatformKnowledgeSurface[]
  organizationId?: string | null
}

interface TenantBlogDocRow {
  theme_id: string | null
  vertical: string | null
  id: string
  organization_id: string
  title: string
  slug: string
  excerpt: string | null
  category: string | null
  seo_keywords: string | null
  collection: string | null
}

interface ContentBlockBodyRow { id: string; type: string; position: number; level: number | null; data_json: string }

async function loadContentBodies(db: DbClient, platformOrganizationId: string, platform: boolean, organizationId?: string | null) {
  const rows = await queryAll<ContentBlockBodyRow>(db, `
    SELECT cd.id, cb.type, cb.position, cb.level, cb.data_json
    FROM content_documents cd
    JOIN content_blocks cb ON cb.document_id = cd.id
    WHERE cd.row_role = 'root'
      AND cd.kind = 'article' AND cd.status = 'published' AND cd.visibility = 'listed'
      AND (cd.organization_id = ?) = ?${organizationId ? ' AND cd.organization_id = ?' : ''}
    ORDER BY cd.id, cb.position
  `, [platformOrganizationId, platform ? 1 : 0, ...(organizationId ? [organizationId] : [])])
  return await renderBodiesByDocument(db, rows)
}

async function renderBodiesByDocument(db: DbClient, rows: ContentBlockBodyRow[] | null | undefined) {
  const blocks = new Map<string, Array<{ type: string; position: number; level: number | null; data: Record<string, unknown>; media: [] }>>()
  for (const row of rows ?? []) {
    const key = row.id
    const items = blocks.get(key) ?? []
    items.push({ type: row.type, position: row.position, level: row.level, data: JSON.parse(row.data_json) as Record<string, unknown>, media: [] })
    blocks.set(key, items)
  }
  return new Map(await Promise.all([...blocks].map(async ([key, items]) => [key,
    renderContentBlocksForLlm(await resolveMcpDocumentationBlocks(db, key, items)),
  ] as const)))
}

function platformKnowledgeInstanceId(env: CloudflareEnv) {
  const value = env.AI_SEARCH_INSTANCE_ID
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw new Error('AI_SEARCH_INSTANCE_ID is not configured')
}

function normalizeQuery(query: string) {
  return query.trim()
}

// SQLite LIKE treats '%' and '_' as wildcards even inside a bound parameter, so a
// literal search term containing them (e.g. "50% off") must have those escaped —
// paired with `ESCAPE '\'` on every LIKE predicate that uses this. Exported so other
// LIKE-based search utils (e.g. server/utils/admin-org-search.ts) reuse this instead
// of reimplementing the same escaping.
export function escapeLikePattern(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

function searchNamespace(env: CloudflareEnv) {
  const binding = env.AI_SEARCH as AiSearchNamespace | undefined
  if (!binding) {
    throw new Error('Cloudflare AI Search binding is not available')
  }
  return binding
}

function stripMarkdown(value: string | null | undefined) {
  return (value ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/[*_#>-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncateSnippet(value: string, maxLength = 180) {
  const text = stripMarkdown(value)
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 3).trimEnd()}...`
}

function renderDocumentContent(record: PlatformKnowledgeDocument) {
  return [
    `# ${record.title}`,
    '',
    record.snippet,
    '',
    `Type: ${record.type}`,
    `Section: ${record.section}`,
    '',
    stripMarkdown(record.body),
  ].join('\n')
}

export function recordMetadata(record: PlatformKnowledgeDocument): Record<string, string> {
  return {
    record_id: record.id,
    type: record.type,
    surface: '',
    organization_id: record.organizationId ?? '',
    display: JSON.stringify({
      title: record.title,
      path: record.path,
      snippet: truncateSnippet(record.snippet),
      section: record.section,
      icon: record.icon,
    }),
  }
}

function resultTypeFilter(type: SearchOptions['type']) {
  return type && type !== 'all' ? type : undefined
}

// AI Search's `filters` field (typed as VectorizeVectorMetadataFilter — see
// node_modules/@cloudflare/workers-types, which declares it as a flat
// `{ [field]: value | { $eq/$gt/... } }` map) has no $and/$or grouping operator.
// Per Cloudflare's docs (developers.cloudflare.com/ai-search/configuration/retrieval/filtering/),
// multiple keys in the same object are implicitly ANDed — wrapping them in `{ $and: [...] }`
// (as this used to) sends a shape the type itself doesn't declare, which AI Search rejects
// at runtime with "AiSearchError: Invalid input". That previously broke every tenant_blog
// query (surface + organization_id is always 2 keys), while the single-key public/blog/docs surfaces
// happened to never hit the broken branch.
export function buildSearchFilters(surface: PlatformKnowledgeSurface, type?: PublicSearchType | 'all', organizationId?: string | null): VectorizeVectorMetadataFilter {
  const filters: VectorizeVectorMetadataFilter = {
    surface: { $eq: surface },
  }

  if (type && type !== 'all') {
    filters.type = { $eq: type }
  }

  // tenant_blog is one shared corpus across every tenant — the surface
  // filter alone isn't enough, results must also be pinned to one organization_id or
  // every tenant's posts would be searchable from every other tenant's blog.
  // A missing organizationId must exclude every tenant_blog document, not just skip
  // the predicate, or an unscoped request would search the entire corpus.
  if (surface === 'tenant_blog') {
    filters.organization_id = { $eq: organizationId || '__no_organization__' }
  }

  // The dashboard reads one business's own records plus the platform's guides
  // and help answers, which carry no organization. Both in one query: the filter is a
  // membership test, and a missing organizationId again matches no business at all.
  if (surface === 'dashboard') {
    filters.organization_id = { $in: [organizationId || '__no_organization__', ''] }
  }

  return filters
}

function normalizeSearchResults(
  chunks: AiSearchSearchResponse['chunks'],
  options: Required<Pick<SearchOptions, 'limit' | 'surface'>>,
) {
  const deduped = new Map<string, PublicSearchResult>()

  for (const chunk of chunks) {
    const metadata = chunk.item.metadata ?? {}
    const display = (() => {
      const raw = typeof metadata.display === 'string' ? metadata.display : ''
      if (!raw) return {}
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Search metadata.display must be an object')
      return parsed as Record<string, unknown>
    })()
    const id = String(metadata.record_id ?? chunk.item.key ?? chunk.id)
    const title = typeof display.title === 'string' && display.title.trim()
      ? display.title.trim()
      : chunk.text.replace(/^#\s+/u, '').split('\n')[0]?.trim()
        || chunk.item.key
    const type = String(metadata.type ?? 'route') as PublicSearchType
    const path = typeof metadata.path === 'string' && metadata.path.trim()
      ? metadata.path.trim()
      : typeof display.path === 'string' && display.path.trim()
        ? display.path.trim()
        : '/'
    const snippet = typeof display.snippet === 'string' && display.snippet.trim()
      ? display.snippet.trim()
      : truncateSnippet(chunk.text)
    const section = typeof display.section === 'string' && display.section.trim() ? display.section.trim() : 'Search'
    const icon = typeof display.icon === 'string' && display.icon.trim() ? display.icon.trim() : 'search'
    const next: PublicSearchResult = {
      id,
      type,
      title,
      path,
      snippet,
      surface: options.surface,
      section,
      icon,
      score: chunk.score,
    }

    const current = deduped.get(id)
    if (!current || current.score < next.score) {
      deduped.set(id, next)
    }
  }

  return [...deduped.values()]
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, options.limit)
}

function normalizeTenantBlogSearchResults(
  rows: TenantBlogSearchRow[],
  options: Required<Pick<SearchOptions, 'limit' | 'surface'>>,
) {
  return rows
    .slice(0, options.limit)
    .map((post, index) => ({
      id: `tenant-blog:${post.id}`,
      type: 'blog' as const,
      title: post.title,
      path: `/blog/${post.slug}`,
      snippet: truncateSnippet(post.excerpt || post.title),
      surface: options.surface,
      section: post.category || 'Blog',
      icon: 'newspaper',
      // These are plain SQL LIKE substring matches, not relevance-ranked — keep the
      // synthetic score modest (well under the platform instance's AI Search scores)
      // so keyword-only blog matches don't crowd out genuinely reranked results.
      score: Math.max(0.15, 0.5 - (index * 0.03)),
    }))
}

// Standard hybrid search (vector + keyword via RRF), no query_rewrite/reranking. Both were
// removed: they add a full extra model round-trip per search (the reported latency), and
// per Cloudflare's own docs, match_threshold/score_threshold filters on the raw vector
// score even when reranking is enabled — a semantic reranker also scores a single bare
// keyword poorly against paragraph-length content, so layering it on top didn't fix (and
// wasn't the tool for fixing) single-keyword queries returning nothing. The application
// layer already guards the actual symptom reranking was added for (nav/route results
// crowding out real content, issue #254) via balanceResultTypes/STATIC_NAV_TYPES below —
// that is the correct place for this, not an extra AI Search model pass.
function platformKnowledgeInstanceConfig(): Omit<AiSearchConfig, 'metadata'> {
  return {
    index_method: {
      vector: true,
      keyword: true,
    },
    fusion_method: 'rrf',
    indexing_options: {
      keyword_tokenizer: 'porter',
    },
    retrieval_options: {
      keyword_match_mode: 'or',
    },
    max_num_results: 20,
    custom_metadata: AI_SEARCH_CUSTOM_METADATA,
  }
}

// The instance itself is provisioned infrastructure (docs/ai-search.md), not something a
// blog write conjures into existence. This only re-asserts the retrieval configuration the
// code depends on, and lets the error through: an earlier `update()` / catch `create()`
// pair turned every real failure — a rate limit, a bad field — into "instance already
// exists" thrown from the create, which is what made issue #917 undiagnosable. `id` is not
// an updatable field and is already carried by the instance handle, so it is not sent.
//
// AI Search restarts a full resync on every configuration update, cancelling the
// one before it. Updating on every pass of a multi-pass rebuild therefore kept
// the queue from ever draining (2026-10-14: 271 items queued, some since August,
// and a sync that never reached zero pending). The configuration is written only
// when a value the code asserts differs from what the instance reports.
export async function ensurePlatformKnowledgeInstance(env: CloudflareEnv) {
  // The same transient connectivity failures withRetries absorbs per item hit
  // this call first: production reindexes on 2026-09-23 and 2026-09-24 died
  // here with `unable_to_connect_to_ai_search` before uploading anything.
  const instance = searchNamespace(env).get(platformKnowledgeInstanceId(env))
  const config = platformKnowledgeInstanceConfig()
  const current = await withRetries(() => instance.info())
  if (!assertedConfigMatches(config, current)) await withRetries(() => instance.update(config))
}

/** Every value `asserted` names is present and equal in `actual`; values only the instance sets are ignored. */
function assertedConfigMatches(asserted: unknown, actual: unknown): boolean {
  if (Array.isArray(asserted)) return Array.isArray(actual) && asserted.length === actual.length && asserted.every((value, index) => assertedConfigMatches(value, actual[index]))
  if (asserted && typeof asserted === 'object') {
    return Boolean(actual) && typeof actual === 'object' && Object.entries(asserted).every(([key, value]) => assertedConfigMatches(value, (actual as Record<string, unknown>)[key]))
  }
  return asserted === actual
}

export async function listAllItems(env: CloudflareEnv) {
  const instance = searchNamespace(env).get(platformKnowledgeInstanceId(env))
  const items: AiSearchItemInfo[] = []
  let page = 1

  while (true) {
    const response = await withRetries(() => instance.items.list({ page, per_page: 50 }))
    const pageItems = response.result ?? []
    items.push(...pageItems)
    if (!response.result_info || page * response.result_info.per_page >= response.result_info.total_count) break
    page += 1
  }

  return items
}

// AI Search has shown transient errors in production (DownstreamConfigApiError timeouts,
// AiSearchInternalError: unable_to_connect_to_ai_search) unrelated to the request's own
// validity — a brief retry absorbs those without masking a real, deterministic failure
// (which will still exhaust all attempts and throw).
// Backoff is exponential rather than linear because the error this most often absorbs is
// "AiSearchError: You are being rate limited" (issue #917): AI Search sheds load for a
// window, and retrying 500ms later inside that window just spends another token against
// it. 1s/2s/4s/8s clears a short window without turning a deterministic failure into a
// 15-second stall per item — that one still exhausts every attempt and throws.
async function withRetries<T>(fn: () => Promise<T>, attempts = 5, delayMs = 1000): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, delayMs * 2 ** (attempt - 1)))
    }
  }
  throw lastError
}

async function deleteIndexItem(env: CloudflareEnv, itemId: string) {
  await withRetries(() => searchNamespace(env).get(platformKnowledgeInstanceId(env)).items.delete(itemId))
}

async function uploadIndexItem(env: CloudflareEnv, key: string, content: string, metadata: Record<string, string>) {
  await withRetries(() => searchNamespace(env).get(platformKnowledgeInstanceId(env)).items.upload(key, content, { metadata }))
}

export async function buildTenantBlogDocuments(db: DbClient, platformOrganizationId?: string, organizationId?: string | null): Promise<PlatformKnowledgeDocument[]> {
  const platformId = platformOrganizationId ?? (await getPlatformOrganization(db)).id
  const [posts, contentBodies] = await Promise.all([queryAll<TenantBlogDocRow>(db, `
    SELECT d.id, d.organization_id, d.title, d.slug, d.summary AS excerpt, ${articleCategoryNameSql('d.id')} AS category,
      d.metadata_json ->> '$.collection' AS collection, d.seo_keywords, s.theme_id, s.vertical
    FROM content_documents d JOIN organization s ON s.id = d.organization_id
    WHERE d.kind = 'article' AND d.row_role = 'root' AND d.status = 'published' AND d.organization_id <> ? AND d.visibility = 'listed'${organizationId ? ' AND d.organization_id = ?' : ''}
    ORDER BY d.organization_id, d.published_at DESC, d.updated_at DESC
  `, [platformId, ...(organizationId ? [organizationId] : [])]), loadContentBodies(db, platformId, false, organizationId)])

  return (posts ?? []).map((post) => {
    if (!isArticleCollection(post.collection)) throw new Error(`Article ${post.id} has no valid collection`)
    const collection = post.collection
    const canonicalBody = contentBodies.get(post.id) ?? ''
    const snippet = truncateSnippet(post.excerpt || canonicalBody || post.title)
    const body = [
      post.title,
      post.category ?? '',
      post.seo_keywords ?? '',
      post.excerpt ?? '',
      stripMarkdown(canonicalBody),
    ].join('\n\n')
    return {
      id: `tenant-blog:${post.id}`,
      // Keyed by id, not organization_id+slug: AI Search enforces a filename length limit
      // ("filename_exceeds_maximum_length"), and slugs are unbounded/human-authored —
      // post.id is a stable, already-unique primary key regardless of site scoping.
      key: `tenant-blog/${post.id}.md`,
      type: 'blog' as const,
      title: post.title,
      // Each template decides its blog prefix (/blog or /article); docs are at /docs.
      path: tenantBlogPostPath({ themeId: post.theme_id, vertical: post.vertical }, post.slug, collection),
      snippet,
      section: post.category || ARTICLE_COLLECTIONS[collection].label,
      icon: 'newspaper',
      body,
      surfaces: ['tenant_blog' as const],
      organizationId: post.organization_id,
    }
  })
}


// ---------------------------------------------------------------------------
// A business's own records, for its dashboard's search
// ---------------------------------------------------------------------------

interface WorkspaceOrganizationRow {
  id: string
  slug: string
  subdomain: string
  vertical: string | null
}

const WORKSPACE_ORGANIZATION_SQL = `JOIN organization s ON s.status = 'active' AND s.subdomain IS NOT NULL`

function joinWords(...parts: Array<string | null | undefined>) {
  return parts.map(part => (part ?? '').trim()).filter(Boolean).join('\n\n')
}

/**
 * Every record a member can open from a business's dashboard, one document
 * each, carrying the dashboard URL it opens at. Filtered by `organization_id` at query
 * time, so one instance serves every business without one seeing another's.
 *
 * Drafts, hidden rows and unpublished products are included: this is the
 * member's own search over their own things, not a public surface.
 */
export async function buildWorkspaceDocuments(db: DbClient, organizationId?: string | null): Promise<PlatformKnowledgeDocument[]> {
  const organizationWhere = organizationId ? ' AND s.id = ?' : ''
  const organizationParams = organizationId ? [organizationId] : []
  const organizations = await queryAll<WorkspaceOrganizationRow>(db, `
    SELECT s.id, s.slug, s.subdomain, s.vertical
    FROM organization s
    WHERE s.status = 'active' AND s.subdomain IS NOT NULL${organizationWhere}
  `, organizationParams)
  if (!organizations?.length) return []
  const byOrganization = new Map(organizations.map(organization => [organization.id, organization]))
  const base = (organization: WorkspaceOrganizationRow) => `/dashboard/${organization.slug}`
  const segment = (organization: WorkspaceOrganizationRow) => resolveProductPresentation(organization.vertical)?.locationCollectionSegment ?? 'products'
  const doc = (organization: WorkspaceOrganizationRow, type: PlatformKnowledgeResultType, id: string, fields: { title: string; path: string; snippet: string; section: string; icon: string; body: string }): PlatformKnowledgeDocument => ({
    id: `dashboard:${type}:${organization.id}:${id}`,
    key: `workspace/${type}/${organization.id}/${id}`,
    type,
    title: fields.title,
    path: fields.path,
    snippet: truncateSnippet(fields.snippet || fields.title),
    section: fields.section,
    icon: fields.icon,
    body: fields.body,
    surfaces: ['dashboard'],
    organizationId: organization.id,
  })

  const [locations, products, collections, documents, blockRows, threads, members, media] = await Promise.all([
    queryAll<{ id: string; organization_id: string; slug: string; title: string; description: string | null; short_description: string | null; address: string | null }>(db, `
      SELECT bl.id, bl.organization_id, bl.slug, bl.title, bl.description, bl.short_description, bl.address
      FROM business_locations bl ${WORKSPACE_ORGANIZATION_SQL} AND s.id = bl.organization_id
      WHERE 1 = 1${organizationWhere}
    `, organizationParams),
    queryAll<{ id: string; organization_id: string; name: string; description: string | null; bookable: number }>(db, `
      SELECT p.id, pub.organization_id, p.name, p.description,
        EXISTS (SELECT 1 FROM product_booking_configs b WHERE b.product_id = p.id AND b.organization_id = p.organization_id) AS bookable
      FROM products p
      JOIN product_publications pub ON pub.product_id = p.id AND pub.organization_id = p.organization_id
      ${WORKSPACE_ORGANIZATION_SQL} AND s.id = pub.organization_id
      WHERE 1 = 1${organizationWhere}
    `, organizationParams),
    queryAll<{ id: string; organization_id: string; name: string; description: string | null; location_id: string | null; member_count: number; bookable_count: number }>(db, `
      SELECT c.id, c.organization_id, c.name, c.description, c.location_id,
        (SELECT COUNT(*) FROM collection_products cp WHERE cp.collection_id = c.id) AS member_count,
        (SELECT COUNT(*) FROM collection_products cp JOIN product_booking_configs b ON b.product_id = cp.product_id AND b.organization_id = cp.organization_id
          WHERE cp.collection_id = c.id) AS bookable_count
      FROM collections c ${WORKSPACE_ORGANIZATION_SQL} AND s.id = c.organization_id
      WHERE 1 = 1${organizationWhere}
    `, organizationParams),
    queryAll<{ id: string; organization_id: string; kind: string; title: string | null; summary: string | null; status: string | null; category: string | null; location_id: string | null; product_id: string | null }>(db, `
      SELECT d.id, d.organization_id, d.kind, d.title, d.summary, d.status, ${articleCategoryNameSql('d.id')} AS category, d.location_id, d.product_id
      FROM content_documents d ${WORKSPACE_ORGANIZATION_SQL} AND s.id = d.organization_id
      WHERE d.row_role = 'root' AND d.kind IN ('qa', 'social_post', 'page', 'article')${organizationWhere}
    `, organizationParams),
    queryAll<ContentBlockBodyRow>(db, `
      SELECT cb.document_id AS id, cb.type, cb.position, cb.level, cb.data_json
      FROM content_blocks cb
      JOIN content_documents d ON d.id = cb.document_id ${WORKSPACE_ORGANIZATION_SQL} AND s.id = d.organization_id
      WHERE d.row_role = 'root' AND d.kind IN ('social_post', 'page', 'article')${organizationWhere}
      ORDER BY cb.document_id, cb.position
    `, organizationParams),
    queryAll<{ id: string; organization_id: string; kind: string; payload_json: string; location_title: string | null; product_name: string | null }>(db, `
      SELECT r.id, r.organization_id, r.kind, r.payload_json, bl.title AS location_title,
        (SELECT p.name FROM bookings b JOIN products p ON p.id = b.product_id WHERE b.request_id = r.id LIMIT 1) AS product_name
      FROM requests r ${WORKSPACE_ORGANIZATION_SQL} AND s.id = r.organization_id
      LEFT JOIN business_locations bl ON bl.id = r.location_id
      WHERE 1 = 1${organizationWhere}
    `, organizationParams),
    queryAll<{ id: string; organization_id: string; role: string; name: string | null; email: string }>(db, `
      SELECT m.id, m."organizationId" AS organization_id, m.role, u.name, u.email
      FROM member m JOIN "user" u ON u.id = m."userId"
      WHERE m."organizationId" IN (SELECT s.id FROM organization s WHERE s.status = 'active' AND s.subdomain IS NOT NULL${organizationWhere})
    `, organizationParams),
    queryAll<{ id: string; organization_id: string; file_name: string | null; category: string | null; kind: string; location_slug: string | null }>(db, `
      SELECT ma.id, ma.organization_id, ma.file_name, ma.category, ma.kind,
        (SELECT bl.slug FROM media_placements mp JOIN business_locations bl ON bl.id = mp.owner_id
          WHERE mp.asset_id = ma.id AND mp.owner_type = 'business_location' AND mp.status = 'active' LIMIT 1) AS location_slug
      FROM media_assets ma ${WORKSPACE_ORGANIZATION_SQL} AND s.id = ma.organization_id
      WHERE ma.status = 'active'${organizationWhere}
    `, organizationParams),
  ])
  const bodies = await renderBodiesByDocument(db, blockRows)
  const records: PlatformKnowledgeDocument[] = []

  for (const row of locations ?? []) {
    const organization = byOrganization.get(row.organization_id)
    if (!organization) continue
    records.push(doc(organization, 'location', row.id, {
      title: row.title, path: locationEditorPath(organization.slug, row.slug), snippet: row.short_description || row.address || row.description || '',
      section: 'Locations', icon: 'map-pin', body: joinWords(row.title, row.short_description, row.description, row.address),
    }))
  }

  // Every product, collection, post and Q&A has one editor, shared by the
  // organization and scoped to a location by its id, so search opens it there.
  for (const row of products ?? []) {
    const organization = byOrganization.get(row.organization_id)
    if (!organization) continue
    const surface = row.bookable ? 'experiences' : segment(organization)
    const presentation = surface === 'experiences' ? null : resolveProductPresentation(organization.vertical)
    records.push(doc(organization, 'product', row.id, {
      title: row.name, path: productEditorPath(organization.slug, row.id), snippet: row.description || '',
      section: surface === 'experiences' ? 'Experiences' : presentation?.collectionLabel ?? 'Products', icon: 'utensils',
      body: joinWords(row.name, row.description),
    }))
  }

  for (const row of collections ?? []) {
    const organization = byOrganization.get(row.organization_id)
    if (!organization) continue
    const surface = row.member_count > 0 && row.bookable_count === row.member_count ? 'experiences' : segment(organization)
    records.push(doc(organization, 'collection', row.id, {
      title: row.name, path: collectionEditorPath(organization.slug, row.id, row.location_id), snippet: row.description || '',
      section: surface === 'experiences' ? 'Experiences' : resolveProductPresentation(organization.vertical)?.collectionLabel ?? 'Products', icon: 'layout-list',
      body: joinWords(row.name, row.description),
    }))
  }

  for (const row of documents ?? []) {
    const organization = byOrganization.get(row.organization_id)
    if (!organization) continue
    const title = row.title?.trim() || row.summary?.trim() || 'Untitled'
    const body = joinWords(row.title, row.summary, row.category, bodies.get(row.id))
    if (row.kind === 'qa') {
      records.push(doc(organization, 'qa', row.id, { title, path: qaEditorPath(organization.slug, row.id, row.location_id), snippet: row.summary || '', section: 'Q&A', icon: 'circle-help', body }))
    } else if (row.kind === 'social_post') {
      records.push(doc(organization, 'post', row.id, { title, path: postEditorPath(organization.slug, row.id, row.location_id), snippet: row.summary || '', section: 'Posts', icon: 'megaphone', body }))
    } else if (row.kind === 'page') {
      records.push(doc(organization, 'page', row.id, { title, path: pageEditorPath(organization.slug, row), snippet: row.summary || '', section: 'Pages', icon: 'file-text', body }))
    } else {
      records.push(doc(organization, 'blog', row.id, { title, path: blogEditorPath(organization.slug, row.id), snippet: row.summary || '', section: row.category || 'Blog', icon: 'newspaper', body }))
    }
  }

  for (const row of threads ?? []) {
    const organization = byOrganization.get(row.organization_id)
    if (!organization) continue
    const payload = JSON.parse(row.payload_json) as { participant?: { kind: 'channel'; title: string }; guest: { name: string | null; email: string | null }; message?: string; notes?: string | null }
    const guest = payload.guest
    // requests_guest_payload_check: a contact-backed conversation has its guest's
    // name; a channel conversation is labelled by its provider title.
    const label = payload.participant ? payload.participant.title : guest.name
    if (!label?.trim()) throw new HTTPError({ statusCode: 500, message: `Conversation ${row.id} has no participant label`, data: { code: 'REQUEST_PARTICIPANT_INVALID', field: 'guest.name', request_id: row.id } })
    const words = row.kind === 'contact' ? payload.message ?? '' : payload.notes ?? ''
    const about = row.product_name ?? row.location_title ?? ''
    records.push(doc(organization, 'thread', row.id, {
      title: label.trim(), path: `${base(organization)}/messages/${row.id}`, snippet: words || about,
      // Name and email find the thread; the phone number stays out of the index.
      section: 'Messages', icon: 'message-circle', body: joinWords(label, guest.name, guest.email, row.kind, about, words),
    }))
  }

  for (const row of members ?? []) {
    for (const organization of organizations) {
      if (organization.id !== row.organization_id) continue
      records.push(doc(organization, 'member', row.id, {
        title: row.name?.trim() || row.email, path: `${base(organization)}/team`, snippet: `${row.email} · ${row.role}`,
        section: 'Team', icon: 'users', body: joinWords(row.name, row.email, row.role),
      }))
    }
  }

  for (const row of media ?? []) {
    const organization = byOrganization.get(row.organization_id)
    if (!organization) continue
    // A location's photo opens that location's Photos; anything else is the
    // organization's, never a location guessed for it.
    records.push(doc(organization, 'media', row.id, {
      title: row.file_name?.trim() || `${row.kind} ${row.id.slice(0, 8)}`,
      path: row.location_slug ? `${locationEditorPath(organization.slug, row.location_slug)}/photos` : brandEditorPath(organization.slug), snippet: row.category || row.kind,
      section: 'Photos', icon: 'image', body: joinWords(row.file_name, row.category, row.kind),
    }))
  }

  return records
}

/** Everything indexed under one business's `organization_id`: its public blog and its dashboard's records. */
export async function buildOrganizationDocuments(db: DbClient, organizationId: string): Promise<PlatformKnowledgeDocument[]> {
  const platformOrganizationId = (await getPlatformOrganization(db)).id
  const [blog, workspace] = await Promise.all([buildTenantBlogDocuments(db, platformOrganizationId, organizationId), buildWorkspaceDocuments(db, organizationId)])
  return [...blog, ...workspace]
}

export async function buildPlatformKnowledgeDocuments(db: DbClient): Promise<PlatformKnowledgeDocument[]> {
  const platformOrganizationId = (await getPlatformOrganization(db)).id
  const [docs, posts, tenantBlogRecords, contentBodies] = await Promise.all([
    queryAll<PlatformDocSearchRow>(db, `
      SELECT id, title, slug, ${articleCategoryNameSql('content_documents.id')} AS category, summary AS excerpt, seo_keywords
      FROM content_documents
      WHERE kind = 'article' AND row_role = 'root' AND status = 'published' AND visibility = 'listed'
        AND (metadata_json ->> '$.collection') = 'docs' AND organization_id = ?
      ORDER BY sort_order, title
    `, [platformOrganizationId]),
    queryAll<PlatformBlogSearchRow>(db, `
      SELECT id, title, slug, summary AS excerpt, ${articleCategoryNameSql('content_documents.id')} AS category, seo_keywords
      FROM content_documents
      WHERE kind = 'article' AND row_role = 'root' AND status = 'published' AND organization_id = ? AND visibility = 'listed'
        AND (metadata_json ->> '$.collection') = 'blog'
      ORDER BY category, published_at DESC, updated_at DESC
    `, [platformOrganizationId]),
    buildTenantBlogDocuments(db, platformOrganizationId),
    loadContentBodies(db, platformOrganizationId, true),
  ])

  const docRecords: PlatformKnowledgeDocument[] = (docs ?? []).flatMap((doc) => {
    const path = collectionArticlePath('docs', doc.slug)
    const canonicalBody = contentBodies.get(doc.id) ?? ''
    const snippet = truncateSnippet(doc.excerpt || canonicalBody || doc.title)
    const body = [
      doc.title,
      doc.seo_keywords ?? '',
      doc.excerpt ?? '',
      stripMarkdown(canonicalBody),
    ].join('\n\n')
    return [{
      id: `doc:${doc.id}`,
      // Keyed by id, not slug: AI Search enforces a filename length limit and
      // slugs are unbounded/human-authored — see tenant-blog's key above.
      key: `docs/${doc.id}.md`,
      type: 'doc',
      title: doc.title,
      path,
      snippet,
      section: (typeof doc.category === 'string' && doc.category.trim()) || 'Docs',
      icon: 'book',
      body,
      surfaces: ['public', 'docs', 'blog', 'help', 'chowbot', 'dashboard'],
    }]
  })

  const blogRecords: PlatformKnowledgeDocument[] = (posts ?? []).flatMap((post) => {
    const path = tenantBlogPostPath(PLATFORM_TEMPLATE, post.slug)
    const canonicalBody = contentBodies.get(post.id) ?? ''
    const snippet = truncateSnippet(post.excerpt || canonicalBody || post.title)
    const body = [
      post.title,
      post.category ?? '',
      post.seo_keywords ?? '',
      post.excerpt ?? '',
      stripMarkdown(canonicalBody),
    ].join('\n\n')
    return [{
      id: `blog:${post.id}`,
      // Keyed by id, not slug: AI Search enforces a filename length limit and
      // slugs are unbounded/human-authored — see tenant-blog's key above.
      key: `blog/${post.id}.md`,
      type: 'blog',
      title: post.title,
      path,
      snippet,
      section: post.category ?? 'Blog',
      icon: 'newspaper',
      body,
      surfaces: ['public', 'docs', 'blog', 'help', 'chowbot', 'dashboard'],
    }]
  })

  const faqRecords: PlatformKnowledgeDocument[] = PLATFORM_KNOWLEDGE_FAQ_ENTRIES.map((faq) => ({
    id: `faq:${faq.id}`,
    key: `faq/${faq.id}.md`,
    type: 'faq',
    title: faq.title,
    path: '/help',
    snippet: truncateSnippet(faq.answer),
    section: 'Support',
    icon: 'circle-help',
    body: `${faq.answer}\n\nKeywords: ${faq.keywords.join(', ')}`,
    surfaces: ['public', 'help', 'chowbot', 'dashboard'],
  }))

  const routeRecords: PlatformKnowledgeDocument[] = PLATFORM_KNOWLEDGE_ROUTE_ENTRIES.map((route) => ({
    id: `route:${route.id}`,
    key: `routes/${route.id}.md`,
    type: 'route',
    title: route.title,
    path: route.path,
    snippet: route.snippet,
    section: route.section,
    icon: route.icon,
    body: `${route.snippet}\n\nKeywords: ${route.keywords.join(', ')}`,
    surfaces: route.surfaces,
  }))

  const pageRecords: PlatformKnowledgeDocument[] = PLATFORM_KNOWLEDGE_PAGE_ENTRIES.map((page) => ({
    id: `page:${page.id}`,
    key: `platform/${page.id}.md`,
    type: 'platform_page',
    title: page.title,
    path: page.path,
    snippet: page.snippet,
    section: page.section,
    icon: page.icon,
    body: `${page.body}\n\nKeywords: ${page.keywords.join(', ')}`,
    surfaces: page.surfaces,
  }))

  return [
    ...docRecords,
    ...blogRecords,
    ...tenantBlogRecords,
    ...faqRecords,
    ...routeRecords,
    ...pageRecords,
  ]
}

export interface ExpandedPlatformKnowledgeDocument extends PlatformKnowledgeDocument {
  metadata: Record<string, string>
}

// AI Search enforces a filename length limit (AiSearchError: filename_exceeds_maximum_length),
// hit in production by a real, long, human-authored blog slug embedded directly in its DB
// primary key (blog_ncls_<full-descriptive-slug>, 129 chars once surface/type-prefixed) — so
// this can't be fixed by picking a "shorter" source field, since even a DB id can be long by
// design. The AI-Search-facing filename must be short and bounded independent of any record's
// id/slug/title length. A fixed-length hash of the pre-expansion key is deterministic (stable
// across rebuilds, so re-uploads correctly upsert rather than duplicate) and collision-resistant;
// all human-readable display data (title, path, section, icon) already lives in metadata, not
// parsed back out of the key, so this loses no information any reader depends on.
function shortItemKeyHash(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value))).slice(0, 24)
}

/**
 * The key segment that names a business's items: `items.list` can search by
 * key, and metadata is not on an item until Cloudflare has processed it, so
 * ownership lives in the key where it is readable from the first second.
 */
export function organizationKeySegment(organizationId: string) {
  return shortItemKeyHash(organizationId).slice(0, 12)
}

export function expandDocumentsForSurfaces(records: PlatformKnowledgeDocument[]): ExpandedPlatformKnowledgeDocument[] {
  return records.flatMap((record) =>
    record.surfaces.map((surface): ExpandedPlatformKnowledgeDocument => ({
      ...record,
      key: record.organizationId
        ? `${surface}/${organizationKeySegment(record.organizationId)}/${record.type}/${shortItemKeyHash(record.key)}.md`
        : `${surface}/${record.type}/${shortItemKeyHash(record.key)}.md`,
      metadata: {
        ...recordMetadata(record),
        surface,
      },
    })),
  )
}

// The exact bytes a rebuild would upload for one expanded record, fingerprinted so the
// rebuild can recognise an item it has already uploaded unchanged. The hash covers the
// rendered body *and* the metadata, because a title or path edit changes only the latter
// and still has to reach the index.
export function indexItemPayload(record: ExpandedPlatformKnowledgeDocument) {
  const content = renderDocumentContent(record)
  const contentHash = shortItemKeyHash(`${content}\u0000${JSON.stringify(record.metadata)}`)
  return { content, metadata: { ...record.metadata, content_hash: contentHash }, contentHash }
}

// Records get expanded across every surface they support (a doc record alone spans 6:
// public/docs/blog/help/chowbot/dashboard), so the real upload count for the full
// corpus is a multiple of the base document count. Sequential uploads took about
// five minutes for production content. Bounded concurrency reduces the time spent
// waiting on AI Search without sending unbounded requests to one instance.
const UPLOAD_CONCURRENCY = 10

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (_item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0
  async function runNext(): Promise<void> {
    const current = nextIndex++
    if (current >= items.length) return
    await worker(items[current]!)
    await runNext()
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runNext))
}

/**
 * Bring one set of index items into line with the documents that should be there.
 *
 * Re-uploading everything each time is what exhausted AI Search's rate limit on every
 * tenant MCP blog write (issue #917) — a one-post edit was spending ~222 uploads. An item
 * whose stored content_hash still matches what we would send has already been accepted
 * for indexing, so sending it again buys nothing. Failed or outdated items are
 * re-sent regardless of their hash: the fingerprint describes what was uploaded,
 * not what was successfully indexed. An unchanged skipped item cannot be repaired
 * by resending the same payload and fails visibly. Items with no document behind
 * them are deleted.
 */
export async function reconcileIndexItems(env: CloudflareEnv, existingItems: AiSearchItemInfo[], records: ExpandedPlatformKnowledgeDocument[], options: { maxUploads?: number } = {}) {
  const nextKeys = new Set(records.map(record => record.key))
  const existingByKey = new Map(existingItems.map(item => [item.key, item]))

  let unresolved = 0
  const outdated = records
    .map(record => ({ record, payload: indexItemPayload(record) }))
    .filter(({ record, payload }) => {
      const existing = existingByKey.get(record.key)
      if (existing?.status === 'skipped' && existing.metadata?.content_hash === payload.contentHash) {
        throw new Error(`AI Search skipped unchanged item "${record.key}": ${existing.error || 'indexing was skipped'}`)
      }
      // AI Search lists newly accepted items as queued before it exposes their
      // metadata. Their payload cannot be compared yet; re-uploading them here
      // keeps resetting the same first batch instead of advancing the index.
      if (existing && ['queued', 'running'].includes(existing.status)
        && (typeof existing.metadata?.content_hash !== 'string' || !existing.metadata.content_hash)) {
        unresolved += 1
        return false
      }
      if (!existing || !['completed', 'queued', 'running'].includes(existing.status)) return true
      // Once AI Search exposes the uploaded hash, a newer D1 payload must
      // overwrite the accepted item under the same key.
      return existing.metadata?.content_hash !== payload.contentHash
    })
  // An upload takes AI Search a few seconds, so a large business may need
  // multiple bounded batches. Report what is left for the caller's next pass.
  const changed = options.maxUploads ? outdated.slice(0, options.maxUploads) : outdated
  const pending = outdated.length - changed.length + unresolved

  await runWithConcurrency(changed, UPLOAD_CONCURRENCY, async ({ record, payload }) => {
    try {
      await uploadIndexItem(env, record.key, payload.content, payload.metadata)
    } catch (error) {
      // Name the specific failing item/key rather than failing generically — this is
      // what actually revealed the production filename_exceeds_maximum_length root
      // cause (a real blog slug embedded in its DB id), surfaced via the error-detail
      // passthrough in server/api/internal/search/reindex.post.ts.
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`uploadIndexItem failed for key "${record.key}" (length ${record.key.length}): ${message}`, { cause: error })
    }
  })

  const staleItems = existingItems.filter(item => !nextKeys.has(item.key))
  await runWithConcurrency(staleItems, UPLOAD_CONCURRENCY, (item) => deleteIndexItem(env, item.id))

  return { indexed: changed.length, unchanged: records.length - outdated.length - unresolved, pending, deleted: staleItems.length }
}

/** How many uploads one sync request sends before handing the rest to the next run. */
export const SYNC_UPLOADS_PER_RUN = 120

/** One business's items and nothing else's, named by the site segment of their key. */
export async function listOrganizationItems(env: CloudflareEnv, organizationId: string) {
  const instance = searchNamespace(env).get(platformKnowledgeInstanceId(env))
  const segment = organizationKeySegment(organizationId)
  const items: AiSearchItemInfo[] = []
  let page = 1
  while (true) {
    const response = await instance.items.list({ page, per_page: 50, search: segment })
    const pageItems = response.result ?? []
    items.push(...pageItems.filter(item => item.key.split('/')[1] === segment))
    if (!response.result_info || page * response.result_info.per_page >= response.result_info.total_count) break
    page += 1
  }
  return items
}

/**
 * One business's slice of the index, brought up to date with its rows.
 *
 * This is what a write costs: list the site's own items, build its documents,
 * upload the ones that changed, delete the ones that are gone. It runs from the
 * same durable queue that clears the site's caches, so every write path that
 * records a change — dashboard, MCP, intake, Better Auth — converges here.
 */
export async function syncOrganizationSearchIndex(env: CloudflareEnv, db: DbClient, organizationId: string) {
  const startedAt = Date.now()
  // Platform guides live in the shared public corpus, alongside the site's
  // organization-scoped dashboard records. A platform write updates both.
  const platformId = (await getPlatformOrganization(db)).id
  const publicCorpus = organizationId === platformId ? await rebuildPlatformKnowledgeIndex(env, db) : null
  const [existingItems, baseRecords] = await Promise.all([listOrganizationItems(env, organizationId), buildOrganizationDocuments(db, organizationId)])
  const records = expandDocumentsForSurfaces(baseRecords)
  const result = await reconcileIndexItems(env, existingItems, records, { maxUploads: SYNC_UPLOADS_PER_RUN })
  console.warn(`[ai-search] organization ${organizationId}: uploaded ${result.indexed}, unchanged ${result.unchanged}, pending ${result.pending}, deleted ${result.deleted} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
  return {
    indexed: result.indexed + (publicCorpus?.indexed ?? 0),
    unchanged: result.unchanged + (publicCorpus?.unchanged ?? 0),
    pending: result.pending + (publicCorpus?.pending ?? 0),
    deleted: result.deleted + (publicCorpus?.deleted ?? 0),
  }
}

/**
 * The platform's own corpus — docs, articles, FAQ, static pages — and the
 * cleanup of anything in the instance that belongs to no business. Each
 * business's slice is a request of its own (`syncOrganizationSearchIndex`).
 * The caller takes the site ids returned here and syncs them one at a time.
 */
export async function rebuildPlatformKnowledgeIndex(
  env: CloudflareEnv,
  db: DbClient,
) {
  const rebuildStartedAt = Date.now()
  const elapsed = () => `${((Date.now() - rebuildStartedAt) / 1000).toFixed(1)}s`

  await ensurePlatformKnowledgeInstance(env)

  const [existingItems, baseRecords, organizations] = await Promise.all([
    listAllItems(env),
    buildPlatformKnowledgeDocuments(db),
    queryAll<{ id: string }>(db, "SELECT id FROM organization WHERE status = 'active' AND subdomain IS NOT NULL ORDER BY id"),
  ])
  // Items a live business owns are its own sync's to keep; everything else — the
  // platform's items and any orphan from an earlier key format — is reconciled here.
  const liveOrganizations = new Set((organizations ?? []).map(organization => organization.id))
  const liveSegments = new Set([...liveOrganizations].map(organizationKeySegment))
  const platformItems = existingItems.filter(item => !liveSegments.has(item.key.split('/')[1] ?? ''))
  const platformRecords = expandDocumentsForSurfaces(baseRecords).filter(record => !liveOrganizations.has(record.organizationId ?? ''))

  const result = await reconcileIndexItems(env, platformItems, platformRecords, { maxUploads: SYNC_UPLOADS_PER_RUN })
  console.warn(`[ai-search] rebuild uploaded ${result.indexed}/${platformRecords.length} records, pending ${result.pending}, deleted ${result.deleted} stale items in ${elapsed()}`)

  return {
    instanceId: platformKnowledgeInstanceId(env),
    ...result,
    organizations: [...liveOrganizations],
  }
}

// Static navigation records (nav shortcuts, not authored content) must never crowd out
// docs/articles/support answers just because they happen to score marginally higher —
// see issue #254. Every other indexed type is treated as "content" and is never
// candidate-starved by the nav cap below.
const STATIC_NAV_TYPES = new Set<PublicSearchType>(['route', 'platform_page'])

// When two records resolve to the same path (e.g. a `route` and a `platform_page` entry
// both pointing at /pricing), keep the richer content record. A business's own records
// each have their own URL and are never collapsed.
const PATH_DEDUP_TYPES = new Set<PublicSearchType>(['route', 'platform_page', 'doc', 'blog', 'faq'])
const TYPE_RICHNESS: Partial<Record<PublicSearchType, number>> = {
  doc: 4,
  blog: 4,
  faq: 3,
  platform_page: 2,
  route: 1,
}

// Reward exact/partial lexical matches against the title and section so a query that
// matches a doc/article's own words outranks a generic static page that only matched on
// a loosely related embedding. This runs on top of (not instead of) the AI Search hybrid
// score, which already handles semantic/multi-word concept queries.
export function computeLexicalBoost(query: string, result: Pick<PublicSearchResult, 'title' | 'section'>) {
  const q = query.toLowerCase().trim()
  if (!q) return 0

  const title = result.title.toLowerCase()
  const section = result.section.toLowerCase()
  let boost = 0

  if (title === q) {
    boost += 0.5
  } else if (title.includes(q)) {
    boost += 0.3
  } else {
    const queryWords = q.split(/\s+/).filter(Boolean)
    const titleWords = new Set(title.split(/\s+/).filter(Boolean))
    const overlap = queryWords.filter(word => titleWords.has(word)).length
    if (queryWords.length > 0) {
      boost += 0.15 * (overlap / queryWords.length)
    }
  }

  if (section && q && section.includes(q)) {
    boost += 0.1
  }

  return boost
}

export function dedupeByPath(results: PublicSearchResult[]) {
  const deduped: PublicSearchResult[] = []
  const indexByPath = new Map<string, number>()

  for (const result of results) {
    if (!PATH_DEDUP_TYPES.has(result.type)) {
      deduped.push(result)
      continue
    }

    const existingIndex = indexByPath.get(result.path)
    if (existingIndex === undefined) {
      indexByPath.set(result.path, deduped.length)
      deduped.push(result)
      continue
    }

    const current = deduped[existingIndex]!
    const currentRank = TYPE_RICHNESS[current.type] ?? 0
    const nextRank = TYPE_RICHNESS[result.type] ?? 0
    if (nextRank > currentRank || (nextRank === currentRank && result.score > current.score)) {
      deduped[existingIndex] = result
    }
  }

  return deduped
}

// Guarantees static nav records (routes/platform pages) can fill at most half of the
// result slots whenever there's enough non-nav content to fill the other half — so a
// broad query like "google" can't come back as all static pages/links when matching
// docs or articles exist, but a query that genuinely only matches nav destinations still
// returns them instead of an artificially short list.
export function balanceResultTypes(results: PublicSearchResult[], limit: number) {
  const content = results.filter(result => !STATIC_NAV_TYPES.has(result.type))
  const nav = results.filter(result => STATIC_NAV_TYPES.has(result.type))
  const navSlots = Math.max(0, limit - Math.min(content.length, Math.ceil(limit / 2)))
  const cappedNav = nav
    .sort((a, b) => b.score - a.score)
    .slice(0, navSlots)

  return [...content, ...cappedNav]
}

export async function searchPublicResources(
  env: CloudflareEnv,
  query: string,
  options: SearchOptions = {},
): Promise<PublicSearchResult[]> {
  const normalized = normalizeQuery(query)
  if (!normalized) return []

  const surface = options.surface ?? 'public'
  const limit = Math.max(1, Math.min(options.limit ?? 8, 20))
  // Pull a wider candidate pool than the final result limit so dedup and type-balancing
  // below have real docs/articles to promote instead of operating on an already-truncated,
  // nav-heavy top-N.
  const candidateLimit = Math.min(50, Math.max(limit * 4, 24))
  const typeFilter = resultTypeFilter(options.type ?? 'all')
  const instance = searchNamespace(env).get(platformKnowledgeInstanceId(env))

  const [response, tenantBlogRows] = await Promise.all([
    instance.search({
      query: normalized,
      ai_search_options: {
        retrieval: {
          retrieval_type: 'hybrid',
          // Standard hybrid retrieval, no reranking/query_rewrite (see
          // platformKnowledgeInstanceConfig above for why). match_threshold filters on the
          // raw vector score per Cloudflare's docs, so it's left at 0 — a single generic
          // keyword ("menu") has weak vector similarity to a whole document embedding even
          // when it's a perfect keyword match; any non-zero threshold here would discard
          // that before RRF fusion ever combines it with the (strong) keyword-side score.
          match_threshold: 0,
          max_num_results: candidateLimit,
          keyword_match_mode: 'or',
          return_on_failure: true,
          filters: buildSearchFilters(surface, typeFilter, options.organizationId),
        },
      },
    }),
    (async () => {
      // The public blog's keyword fallback, for that surface only: the dashboard
      // reads the article's editor entry from the index, not its public page.
      if (surface !== 'tenant_blog' || !options.organizationId || !env.db || (typeFilter && typeFilter !== 'blog')) {
        return [] as TenantBlogSearchRow[]
      }
      const likePattern = `%${escapeLikePattern(normalized)}%`
      return await queryAll<TenantBlogSearchRow>(
          env.db,
          `SELECT DISTINCT p.id, p.title, p.slug, p.summary AS excerpt, ${articleCategoryNameSql('p.id')} AS category, p.seo_keywords
           FROM content_documents p
           LEFT JOIN content_blocks cb ON cb.document_id = p.id
           WHERE p.kind = 'article' AND p.row_role = 'root' AND p.status = 'published'
             AND p.organization_id = ?
             AND p.visibility = 'listed'
             AND (
               lower(p.title) LIKE lower(?) ESCAPE '\\'
               OR lower(COALESCE(cb.data_json, '')) LIKE lower(?) ESCAPE '\\'
               OR lower(COALESCE(p.summary, '')) LIKE lower(?) ESCAPE '\\'
               OR lower(COALESCE(${articleCategoryNameSql('p.id')}, '')) LIKE lower(?) ESCAPE '\\'
               OR lower(COALESCE(p.seo_keywords, '')) LIKE lower(?) ESCAPE '\\'
             )
           ORDER BY p.published_at DESC, p.updated_at DESC
           LIMIT ?`,
          [
            options.organizationId,
            likePattern,
            likePattern,
            likePattern,
            likePattern,
            likePattern,
            candidateLimit,
          ],
      )
    })(),
  ])

  const platformResults = normalizeSearchResults(response.chunks ?? [], {
    limit: candidateLimit,
    surface,
  })
  const tenantResults = normalizeTenantBlogSearchResults(tenantBlogRows ?? [], {
    limit: candidateLimit,
    surface,
  })

  const merged = new Map<string, PublicSearchResult>()
  for (const result of [...tenantResults, ...platformResults]) {
    const key = `${result.type}:${result.id}:${result.path}`
    const current = merged.get(key)
    const boosted: PublicSearchResult = { ...result, score: result.score + computeLexicalBoost(normalized, result) }
    if (!current || current.score < boosted.score) merged.set(key, boosted)
  }

  const candidates = [...merged.values()].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
  const deduped = dedupeByPath(candidates)
  const balanced = balanceResultTypes(deduped, limit)

  return balanced
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit)
}

export function formatPublicSearchResultsForPrompt(results: PublicSearchResult[]) {
  return results.map((result, index) =>
    `${index + 1}. [${result.type}] ${result.title} (${result.path}) - ${result.snippet}`,
  ).join('\n')
}
