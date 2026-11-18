import { publicTenantVisibilitySql } from '~/server/utils/public-base'
import { HTTPError } from 'nitro'
import { ARTICLE_COLLECTIONS, collectionArticlePath, isArticleCollection } from '~/utils/article-collections'
import { tenantBlogPostPath } from '~/utils/tenant-blog-route'
import { queryAll, type DbClient } from '~/server/db'
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
import { markdownToPlainText } from '~/utils/markdown'
import { articleCategoryNameSql } from '~/server/utils/content/article-categories'

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

interface PlatformKnowledgeDocument {
  id: string
  type: PlatformKnowledgeResultType
  title: string
  path: string
  snippet: string
  section: string
  icon: string
  body: string
  surfaces: PlatformKnowledgeSurface[]
}

interface TenantBlogDocRow {
  id: string
  title: string
  slug: string
  excerpt: string | null
  category: string | null
  seo_keywords: string | null
  collection: string | null
}

interface ContentBlockBodyRow { id: string; type: string; position: number; level: number | null; data_json: string }

async function loadContentBodies(db: DbClient, organizationId: string) {
  const rows = await queryAll<ContentBlockBodyRow>(db, `
    SELECT cd.id, cb.type, cb.position, cb.level, cb.data_json
    FROM content_documents cd
    JOIN content_blocks cb ON cb.document_id = cd.id
    WHERE cd.row_role = 'root'
      AND cd.kind = 'article' AND cd.status = 'published' AND cd.visibility = 'listed'
      AND cd.organization_id = ?
    ORDER BY cd.id, cb.position
  `, [organizationId])
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
    markdownToPlainText(renderContentBlocksForLlm(await resolveMcpDocumentationBlocks(db, key, items))),
  ] as const)))
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

async function buildTenantBlogDocuments(db: DbClient, organizationId: string): Promise<PlatformKnowledgeDocument[]> {
  const [posts, contentBodies] = await Promise.all([queryAll<TenantBlogDocRow>(db, `
    SELECT d.id, d.title, d.slug, d.summary AS excerpt, ${articleCategoryNameSql('d.id')} AS category,
      d.metadata_json ->> '$.collection' AS collection, d.seo_keywords
    FROM content_documents d JOIN organization s ON s.id = d.organization_id
    WHERE d.kind = 'article' AND d.row_role = 'root' AND d.status = 'published' AND d.organization_id = ? AND d.visibility = 'listed' AND ${publicTenantVisibilitySql('s', false)}
    ORDER BY d.published_at DESC, d.updated_at DESC
  `, [organizationId]), loadContentBodies(db, organizationId)])

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
      canonicalBody,
    ].join('\n\n')
    return {
      id: `tenant-blog:${post.id}`,
      type: 'blog' as const,
      title: post.title,
      // Each template decides its blog prefix (/blog or /article); docs are at /docs.
      path: tenantBlogPostPath(post.slug, collection),
      snippet,
      section: post.category || ARTICLE_COLLECTIONS[collection].label,
      icon: 'newspaper',
      body,
      surfaces: ['tenant_blog' as const],
    }
  })
}


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
 * each, carrying the dashboard URL it opens at. Every read is scoped to the
 * authorized organization.
 *
 * Drafts, hidden rows and unpublished products are included: this is the
 * member's own search over their own things, not a public surface.
 */
async function buildWorkspaceDocuments(db: DbClient, organizationId: string): Promise<PlatformKnowledgeDocument[]> {
  const organizationWhere = ' AND s.id = ?'
  const organizationParams = [organizationId]
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
    type,
    title: fields.title,
    path: fields.path,
    snippet: truncateSnippet(fields.snippet || fields.title),
    section: fields.section,
    icon: fields.icon,
    body: fields.body,
    surfaces: ['dashboard'],
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
        (SELECT p.name FROM bookings b JOIN products p ON p.id = b.product_id WHERE b.id = r.booking_id LIMIT 1) AS product_name
      FROM conversations r ${WORKSPACE_ORGANIZATION_SQL} AND s.id = r.organization_id
      LEFT JOIN business_locations bl ON bl.id = r.location_id
      WHERE r.kind IN ('contact', 'booking')${organizationWhere}
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
    // conversations_guest_payload_check: a contact-backed conversation has its guest's
    // name; a channel conversation is labelled by its provider title.
    const label = payload.participant ? payload.participant.title : guest.name
    if (!label?.trim()) throw new HTTPError({ statusCode: 500, message: `Conversation ${row.id} has no participant label`, data: { code: 'REQUEST_PARTICIPANT_INVALID', field: 'guest.name', request_id: row.id } })
    const words = row.kind === 'contact' ? payload.message ?? '' : payload.notes ?? ''
    const about = row.product_name ?? row.location_title ?? ''
    records.push(doc(organization, 'thread', row.id, {
      title: label.trim(), path: `${base(organization)}/messages/${row.id}`, snippet: words || about,
      // Name and email find the thread.
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

async function buildPlatformKnowledgeDocuments(db: DbClient): Promise<PlatformKnowledgeDocument[]> {
  const platformOrganizationId = (await getPlatformOrganization(db)).id
  const [docs, posts, contentBodies] = await Promise.all([
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
    loadContentBodies(db, platformOrganizationId),
  ])

  const docRecords: PlatformKnowledgeDocument[] = (docs ?? []).flatMap((doc) => {
    const path = collectionArticlePath('docs', doc.slug)
    const canonicalBody = contentBodies.get(doc.id) ?? ''
    const snippet = truncateSnippet(doc.excerpt || canonicalBody || doc.title)
    const body = [
      doc.title,
      doc.seo_keywords ?? '',
      doc.excerpt ?? '',
      canonicalBody,
    ].join('\n\n')
    return [{
      id: `doc:${doc.id}`,
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
    const path = tenantBlogPostPath(post.slug)
    const canonicalBody = contentBodies.get(post.id) ?? ''
    const snippet = truncateSnippet(post.excerpt || canonicalBody || post.title)
    const body = [
      post.title,
      post.category ?? '',
      post.seo_keywords ?? '',
      post.excerpt ?? '',
      canonicalBody,
    ].join('\n\n')
    return [{
      id: `blog:${post.id}`,
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
    ...faqRecords,
    ...routeRecords,
    ...pageRecords,
  ]
}

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

function computeLexicalBoost(query: string, result: Pick<PublicSearchResult, 'title' | 'section'>) {
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

function dedupeByPath(results: PublicSearchResult[]) {
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
function balanceResultTypes(results: PublicSearchResult[], limit: number) {
  const content = results.filter(result => !STATIC_NAV_TYPES.has(result.type))
  const nav = results.filter(result => STATIC_NAV_TYPES.has(result.type))
  const navSlots = Math.max(0, limit - Math.min(content.length, Math.ceil(limit / 2)))
  const cappedNav = nav
    .sort((a, b) => b.score - a.score)
    .slice(0, navSlots)

  return [...content, ...cappedNav]
}

const COMMON_WORDS = new Set('a an and are can do does for from how i in is it me my of on or the to was what when where which who will with would you your'.split(' '))

function searchText(value: string) {
  return value.normalize('NFKC').toLowerCase()
}

export async function searchPublicResources(
  db: DbClient,
  query: string,
  options: SearchOptions = {},
): Promise<PublicSearchResult[]> {
  const normalized = searchText(query.trim().slice(0, 512))
  if (!normalized) return []

  const surface = options.surface ?? 'public'
  const organizationId = options.organizationId
  let documents: PlatformKnowledgeDocument[]
  if (surface === 'tenant_blog') {
    if (!organizationId) throw new Error('An organization is required for tenant blog search')
    documents = await buildTenantBlogDocuments(db, organizationId)
  } else if (surface === 'dashboard') {
    if (!organizationId) throw new Error('An organization is required for dashboard search')
    const [platform, workspace] = await Promise.all([
      buildPlatformKnowledgeDocuments(db),
      buildWorkspaceDocuments(db, organizationId),
    ])
    documents = [...platform, ...workspace]
  } else {
    documents = await buildPlatformKnowledgeDocuments(db)
  }
  const phraseTerms = normalized.match(/[\p{L}\p{N}]+/gu) ?? []
  const meaningfulTerms = phraseTerms.filter(term => !COMMON_WORDS.has(term))
  const terms = [...new Set(meaningfulTerms.length ? meaningfulTerms : phraseTerms)]
  const candidates: PublicSearchResult[] = []
  for (const { surfaces, body, ...result } of documents) {
    if (!surfaces.includes(surface) || (options.type && options.type !== 'all' && result.type !== options.type)) continue

    const title = searchText(result.title)
    const content = searchText(body)
    const section = searchText(result.section)
    const matched = terms.filter(term => title.includes(term) || content.includes(term) || section.includes(term))
    const phrase = title.includes(normalized) || content.includes(normalized) || section.includes(normalized)
    if (!phrase && (!matched.length || (surface === 'tenant_blog' && matched.length < terms.length))) continue

    const titleMatches = matched.filter(term => title.includes(term)).length
    const score = (phrase ? 1 : 0) + (matched.length + titleMatches) / Math.max(terms.length, 1)
      + computeLexicalBoost(normalized, result)
    const snippet = surface === 'help' || surface === 'chowbot'
      ? helpSearchExcerpt(body, matched, result.snippet)
      : result.snippet
    candidates.push({ ...result, surface, score, snippet })
  }

  const limit = Math.max(1, Math.min(options.limit ?? 8, 20))
  candidates.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
  return balanceResultTypes(dedupeByPath(candidates), limit)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit)
}

function helpSearchExcerpt(body: string, terms: string[], snippet: string) {
  const ranked = body.split(/\n+/).filter(paragraph => paragraph.trim()).map(paragraph => {
    const text = searchText(paragraph)
    return { paragraph, matches: terms.filter(term => text.includes(term)).length }
  }).sort((a, b) => b.matches - a.matches)
  const passages = ranked.filter(entry => entry.matches > 0).slice(0, 2).map(({ paragraph }) => {
    const text = searchText(paragraph)
    const first = Math.min(...terms.map(term => text.indexOf(term)).filter(index => index >= 0))
    const start = first > 175 ? Math.max(paragraph.lastIndexOf(' ', first - 110), 0) : 0
    return truncateSnippet(paragraph.slice(start), 210)
  })
  return [...new Set([snippet, ...passages])].filter(Boolean).join(' ')
}

export function formatPublicSearchResultsForPrompt(results: PublicSearchResult[]) {
  return results.map((result, index) =>
    `${index + 1}. [${result.type}] ${result.title} (${result.path}) - ${result.snippet}`,
  ).join('\n')
}
