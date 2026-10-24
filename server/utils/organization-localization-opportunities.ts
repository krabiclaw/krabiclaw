import { queryAll, type DbClient } from '~/server/db'
import {
  articleCategoryEditorPath, blogEditorPath, brandEditorPath, collectionEditorPath, linksEditorPath,
  locationEditorPath, pageEditorPath, postEditorPath, productEditorPath, qaEditorPath,
} from '~/server/utils/dashboard-links'
import { getPersistedSourceLocale } from '~/server/utils/localization'

interface LocalizableRow {
  id: string
  values_json: string | null
  location_slug?: string | null
  product_id?: string | null
  [field: string]: unknown
}

export interface OrganizationLocalizationOpportunity {
  id: string
  label: string
  completed: number
  total: number
  path: string
}

export interface OrganizationLocalizationProgress {
  locale: string
  completed: number
  total: number
  opportunities: OrganizationLocalizationOpportunity[]
}

function meaningful(value: unknown): boolean {
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return false
    if (text.startsWith('[') || text.startsWith('{')) {
      try { return meaningful(JSON.parse(text)) } catch { return true }
    }
    return true
  }
  if (Array.isArray(value)) return value.some(meaningful)
  if (value && typeof value === 'object') return Object.values(value).some(meaningful)
  return false
}

function localizedValues(row: LocalizableRow): Record<string, unknown> {
  if (!row.values_json) return {}
  const value: unknown = JSON.parse(row.values_json)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Stored resource localization is invalid')
  return value as Record<string, unknown>
}

function fieldValue(record: Record<string, unknown>, field: string): unknown {
  return field.split('.').reduce<unknown>((value, key) => {
    const object = typeof value === 'string' ? JSON.parse(value) as unknown : value
    return object && typeof object === 'object' && !Array.isArray(object) ? (object as Record<string, unknown>)[key] : undefined
  }, record)
}

function progress(rows: readonly LocalizableRow[], fields: readonly string[]): { completed: number; total: number; first: LocalizableRow | null } {
  let completed = 0
  let total = 0
  let first: LocalizableRow | null = null
  for (const row of rows) {
    const values = localizedValues(row)
    for (const field of fields) {
      if (!meaningful(fieldValue(row, field))) continue
      total += 1
      if (meaningful(fieldValue(values, field))) completed += 1
      else if (!first) first = row
    }
  }
  return { completed, total, first }
}

/**
 * The first untranslated record's editor in its translations mode, in this
 * language: the record's own URL is the identity, and `editMode` and `locale`
 * are the mode `DashboardResourceLocalization` reconstructs from it.
 */
function opportunity(
  id: string,
  label: string,
  result: ReturnType<typeof progress>,
  path: (first: LocalizableRow) => string,
  locale: string,
): OrganizationLocalizationOpportunity | null {
  if (!result.first || result.completed === result.total) return null
  const query = new URLSearchParams({ editMode: 'translations', locale })
  return { id, label, completed: result.completed, total: result.total, path: `${path(result.first)}?${query}` }
}

export async function getOrganizationLocalizationProgress(
  db: DbClient,
  input: { organizationId: string; organizationSlug: string; locale: string },
): Promise<OrganizationLocalizationProgress> {
  const source = await getPersistedSourceLocale(db, input.organizationId)
  if (input.locale === source.locale) throw new Error('Localization progress requires an additional language')
  const params = [input.locale, input.organizationId]
  const [organization, locations, catalog, collections, posts, blog, categories, qa, links, pages] = await Promise.all([
    queryAll<LocalizableRow>(db, `SELECT s.id, s.name, s.vertical, s.brand_description, rl.values_json
      FROM organization s LEFT JOIN resource_localizations rl ON rl.resource_type = 'organization' AND rl.resource_id = s.id AND rl.locale = ?
        AND rl.organization_id = s.id
      WHERE s.id = ?`, params),
    queryAll<LocalizableRow>(db, `SELECT l.id, l.slug AS location_slug, l.title, l.address, l.description, l.short_description, rl.values_json
      FROM business_locations l LEFT JOIN resource_localizations rl ON rl.resource_type = 'business_location' AND rl.resource_id = l.id AND rl.locale = ?
        AND rl.organization_id = l.organization_id
      WHERE l.organization_id = ? AND l.status = 'active' ORDER BY l.id`, params),
    // One catalog, one row per product. There is no separate experience query
    // and no category query: an experience is a product, and a collection is a
    // site merchandising record localized in its own group below.
    queryAll<LocalizableRow>(db, `
      SELECT p.id, p.name, p.description, p.marketing_features, p.unit_label,
             p.details_json AS details,
             rl.values_json
        FROM products p
        JOIN product_publications pub ON pub.product_id = p.id AND pub.organization_id = p.organization_id
        LEFT JOIN resource_localizations rl ON rl.resource_type = 'product' AND rl.resource_id = p.id AND rl.locale = ?
          AND rl.organization_id = p.organization_id AND rl.organization_id = pub.organization_id
       WHERE p.organization_id = ? AND p.active = 1
       ORDER BY p.name, p.id`, params),
    queryAll<LocalizableRow>(db, `
      SELECT c.id, c.name, c.description, rl.values_json
        FROM collections c
        LEFT JOIN resource_localizations rl ON rl.resource_type = 'collection' AND rl.resource_id = c.id AND rl.locale = ?
          AND rl.organization_id = c.organization_id AND rl.organization_id = c.organization_id
       WHERE c.organization_id = ?
       ORDER BY c.sort_order, c.id`, params),
    // Every published post and Q&A, the site's own and each location's: one
    // list holds both, so neither is left out of what is left to translate.
    queryAll<LocalizableRow>(db, `SELECT p.id, p.summary, p.metadata_json AS metadata,
        CASE WHEN t.id IS NULL THEN NULL ELSE json_object('summary',t.summary,'metadata',json(t.metadata_json)) END AS values_json
      FROM content_documents p
      LEFT JOIN content_documents t ON t.root_id = p.id AND t.row_role = 'representation' AND t.locale = ?
      WHERE p.organization_id = ? AND p.kind = 'social_post' AND p.row_role = 'root' AND p.status = 'published' ORDER BY p.id`, params),
    queryAll<LocalizableRow>(db, `SELECT p.id, p.title, p.summary, p.metadata_json AS metadata,
        CASE WHEN t.id IS NULL THEN NULL ELSE json_object('title',t.title,'summary',t.summary,'metadata',json(t.metadata_json)) END AS values_json
      FROM content_documents p LEFT JOIN content_documents t ON t.root_id = p.id AND t.row_role = 'representation' AND t.locale = ?
      WHERE p.organization_id = ? AND p.kind = 'article' AND p.row_role = 'root' AND p.status = 'published' ORDER BY p.id`, params),
    queryAll<LocalizableRow>(db, `
      SELECT c.id, c.name, c.description, rl.values_json
        FROM article_categories c
        LEFT JOIN resource_localizations rl ON rl.resource_type = 'article_category' AND rl.resource_id = c.id AND rl.locale = ?
          AND rl.organization_id = c.organization_id
       WHERE c.organization_id = ?
       ORDER BY c.collection, c.sort_order, c.id`, params),
    queryAll<LocalizableRow>(db, `SELECT q.id, q.title, q.summary,
        CASE WHEN t.id IS NULL THEN NULL ELSE json_object('title',t.title,'summary',t.summary) END AS values_json
      FROM content_documents q
      LEFT JOIN content_documents t ON t.root_id = q.id AND t.row_role = 'representation' AND t.locale = ?
      WHERE q.organization_id = ? AND q.kind = 'qa' AND q.row_role = 'root' AND q.status = 'published' ORDER BY q.id`, params),
    queryAll<LocalizableRow>(db, `
      SELECT p.id, p.title, NULL AS label,
        CASE WHEN t.id IS NULL THEN NULL ELSE json_object('title',t.title) END AS values_json
      FROM content_documents p
      LEFT JOIN content_documents t ON t.root_id = p.id AND t.row_role = 'representation' AND t.locale = ?
      WHERE p.organization_id = ? AND p.row_role = 'root' AND p.kind = 'page' AND p.metadata_json ->> '$.recipe' = 'links'
      UNION ALL
      SELECT p.id, NULL AS title, b.data_json ->> '$.label' AS label,
        CASE WHEN tb.id IS NULL THEN NULL ELSE json_object('label',tb.data_json ->> '$.label') END AS values_json
      FROM content_documents p JOIN content_blocks b ON b.document_id = p.id AND b.type = 'cta'
      LEFT JOIN content_documents t ON t.root_id = p.id AND t.row_role = 'representation' AND t.locale = ?
      LEFT JOIN content_blocks tb ON tb.document_id = t.id AND tb.source_block_id = b.id
      WHERE p.organization_id = ? AND p.row_role = 'root' AND p.kind = 'page' AND p.metadata_json ->> '$.recipe' = 'links'
        AND b.data_json ->> '$.status' = 'active'`, [...params, ...params]),
    queryAll<LocalizableRow>(db, `SELECT source.id, source.product_id, source.title, source.summary,
        CASE WHEN translated.id IS NULL THEN NULL ELSE json_object(
          'title', translated.title, 'summary', translated.summary,
          'content', (SELECT json_group_array(json(block.data_json)) FROM content_blocks block WHERE block.document_id = translated.id)
        ) END AS values_json,
        (SELECT json_group_array(json(block.data_json)) FROM content_blocks block WHERE block.document_id = source.id) AS content
      FROM content_documents source
      LEFT JOIN content_documents translated ON translated.root_id = source.id AND translated.row_role = 'representation' AND translated.locale = ?
      WHERE source.organization_id = ? AND source.row_role = 'root' AND source.kind = 'page'
        AND (source.metadata_json ->> '$.recipe' IS NULL OR source.metadata_json ->> '$.recipe' <> 'links') ORDER BY source.id`, params),
  ])

  const slug = input.organizationSlug
  const groups = [
    { id: 'brand', label: 'Brand', result: progress(organization, ['name', 'brand_description']), path: () => brandEditorPath(slug) },
    { id: 'locations', label: organization[0]?.vertical === 'service' ? 'Offices' : 'Locations', result: progress(locations, ['title', 'address', 'description', 'short_description']), path: (row: LocalizableRow) => {
      if (!row.location_slug) throw new Error(`Location ${row.id} has no slug`)
      return `${locationEditorPath(slug, row.location_slug)}/settings`
    } },
    // Which product attributes are translatable is the definition's own
    // declaration, so the field list is the columns plus whatever the tenant
    // declared — not a list maintained here.
    { id: 'catalog', label: 'Catalog', result: progress(catalog, ['name', 'description', 'marketing_features', 'unit_label', 'details']), path: (row: LocalizableRow) => productEditorPath(slug, row.id) },
    // A collection translates on its Name, which is where its words are edited.
    { id: 'collections', label: 'Collections', result: progress(collections, ['name', 'description']), path: (row: LocalizableRow) => `${collectionEditorPath(slug, row.id)}/name` },
    { id: 'pages', label: 'Pages', result: progress(pages, ['title', 'summary', 'content']), path: (row: LocalizableRow) => pageEditorPath(slug, { id: row.id }) },
    { id: 'posts', label: 'Posts', result: progress(posts, ['summary', 'metadata.event.title', 'metadata.offer.terms_conditions']), path: (row: LocalizableRow) => postEditorPath(slug, row.id) },
    { id: 'blog', label: 'Blog', result: progress(blog, ['title', 'summary']), path: (row: LocalizableRow) => blogEditorPath(slug, row.id) },
    { id: 'article-categories', label: 'Article categories', result: progress(categories, ['name', 'description']), path: (row: LocalizableRow) => articleCategoryEditorPath(slug, row.id) },
    { id: 'qa', label: 'Q&A', result: progress(qa, ['title', 'summary']), path: (row: LocalizableRow) => qaEditorPath(slug, row.id) },
    { id: 'links', label: 'Links', result: progress(links, ['title', 'label']), path: () => linksEditorPath(slug) },
  ]
  const results = groups
    .map(group => opportunity(group.id, group.label, group.result, group.path, input.locale))
    .filter((item): item is OrganizationLocalizationOpportunity => item !== null)
  return {
    locale: input.locale,
    completed: groups.reduce((sum, group) => sum + group.result.completed, 0),
    total: groups.reduce((sum, group) => sum + group.result.total, 0),
    opportunities: results,
  }
}
