import { HTTPError } from 'nitro';
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { d1JsonStringSet } from '~/server/db/d1-limits'
import {
  contentBlocksQuery,
  formatBlockOutline,
  prepareContentDocumentDeletion,
  prepareContentDocumentUpdate,
  prepareContentDocumentWithBlocks,
  updateContentDocument,
  type ContentBlockInput,
  type ContentBlockRow,
  type ContentDocumentRow,
  type ContentDocumentInput } from '~/server/utils/content/documents'
import {
  normalizeTenantPageBlocks,
  normalizeTenantPagePath,
  blockDefinition,
  TENANT_PAGE_RECIPE_REGISTRY,
  TENANT_PAGE_TYPES,
  type TenantPageBlock,
  type TenantPageSnapshotMetadata,
  type TenantPageType,
} from '~/utils/tenant-page-blocks'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import type { CloudflareEnv } from '~/server/utils/auth'
import { refreshSocialCard } from '~/server/utils/social-card'
import { assertExactCanonicalLocale, getPersistedSourceLocale, sourceLocaleFromRows, sourceLocaleQuery } from '~/server/utils/localization'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { buildSingleMediaPlacementQueries, groupMediaPlacements, insertInitialMediaPlacements, hydrateMediaAssetRefs, mediaPlacementsQuery } from '~/server/utils/media-asset-manager'
import { isSingleMediaPlacement } from '~/shared/media-placement-contract'
import { getMediaPlacements } from '~/server/utils/media-placement'
import { assertLocationGridSupported, loadOrganizationSite } from '~/server/utils/content/publishing'
import { resolveSocialImageFromMedia } from '~/utils/social-metadata'
import { siteAllowsPageDocumentAt, sitePageDocumentPaths } from '~/shared/tenant-page-paths'
import { hasPublicLocationPages, isPublicLocationPath, resolvePublicSite, type PublicSiteDefinition } from '~/utils/site-routing'
import { CLAIMED_PUBLIC_ROUTES } from '#claimed-public-routes'
import { formatTenantLocalePath } from '~/utils/tenant-locale-path'
import { creationRequestHash, organizationEventQuery } from '~/server/utils/organization-events'
import { qaListQuery } from '~/server/utils/location-qa'
import type { QaDocument } from '~/server/utils/location-qa'
import { platformLocale } from '~/shared/platform-locales'

export interface TenantPageEditorInput {
  id?: string
  page_id?: string
  product_id?: string | null
  locale?: string
  path: string
  title: string
  summary?: string | null
  page_type?: TenantPageType
  recipe?: string | null
  sort_order?: number | null
  blocks: unknown
  updated_at?: string | null
}

export interface TenantPageDocument {
  id: string
  updated_at: string
}

export interface TenantPageDto {
  id: string
  page_id: string
  organization_id: string
  product_id: string | null
  locale: string
  path: string
  title: string
  summary: string | null
  page_type: TenantPageType
  recipe: string | null
  sort_order: number
  blocks: TenantPageBlock[]
  document: TenantPageDocument
  updated_at: string
}

interface PageRepresentationRow {
  id: string
  page_id: string
  organization_id: string
  product_id: string | null
  locale: string
  path: string
  title: string
  summary: string | null
  page_type: TenantPageType
  recipe: string | null
  sort_order: number
  updated_at: string
}


function badRequest(message: string): never {
  throw new HTTPError({ statusCode: 400, statusMessage: message })
}

function notFound(message: string): never {
  throw new HTTPError({ statusCode: 404, statusMessage: message })
}

function conflict(message: string): never {
  throw new HTTPError({ statusCode: 409, statusMessage: message })
}

function asString(value: unknown, field: string, required = false): string | null {
  if (value == null || value === '') {
    if (required) badRequest(field + ' is required')
    return null
  }
  if (typeof value !== 'string') badRequest(field + ' must be a string')
  return value.trim()
}

function metadataForInput(input: TenantPageEditorInput, locale: string, path: string): TenantPageSnapshotMetadata {
  const pageType = input.page_type ?? 'custom'
  if (!TENANT_PAGE_TYPES.includes(pageType)) badRequest('page_type is invalid')
  return {
    locale,
    path,
    title: asString(input.title, 'title', true)!,
    summary: asString(input.summary, 'summary'),
    pageType,
    recipe: asString(input.recipe, 'recipe'),
  }
}

/**
 * May this site hold a custom page?
 *
 * A custom page is a subscription feature a customer buys. Blawby's own site
 * is the seller, not a subscriber: the platform organization holds no
 * subscription and never will, so asking `custom_pages` of it refused every
 * page Blawby publishes about itself (#903).
 */
async function organizationMayHoldCustomPages(env: CloudflareEnv, db: DbClient, organizationId: string): Promise<boolean> {
  const { site } = await loadOrganizationSite(db, organizationId)
  if (site.slug === 'platform') return true
  return await hasOrganizationEntitlement(env, organizationId, 'custom_pages')
}

async function assertTenantPageSupport(env: CloudflareEnv, db: DbClient, organizationId: string, input: TenantPageEditorInput, blocks: TenantPageBlock[], options: { checkCustomPageEntitlement?: boolean } = {}) {
  const pageType = input.page_type ?? 'custom'
  if (!TENANT_PAGE_TYPES.includes(pageType)) badRequest('page_type is invalid')
  if (pageType === 'custom' && options.checkCustomPageEntitlement !== false && !(await organizationMayHoldCustomPages(env, db, organizationId))) {
    throw new HTTPError({ statusCode: 402, statusMessage: 'Custom tenant pages require the Growth plan or higher' })
  }
  await assertLocationGridSupported(db, organizationId, blocks)
  const recipe = input.recipe?.trim() || null
  if (pageType === 'recipe' && !recipe) badRequest('recipe is required for recipe pages')
  if (recipe && !TENANT_PAGE_RECIPE_REGISTRY.has(recipe)) badRequest(`Recipe "${recipe}" is not supported`)
  if (recipe) {
    for (const block of blocks) {
      const definition = blockDefinition(block.type)
      if (!definition.allowedPageTypes.includes(pageType)) {
        badRequest(`Block type "${block.type}" is not supported by page type "${pageType}"`)
      }
      if (!definition.allowedRecipes.includes(recipe)) {
        badRequest(`Block type "${block.type}" is not supported by recipe "${recipe}"`)
      }
    }
  } else {
    for (const block of blocks) {
      if (!blockDefinition(block.type).allowedPageTypes.includes(pageType)) {
        badRequest(`Block type "${block.type}" is not supported by page type "${pageType}"`)
      }
    }
  }
}

function blocksAsInputs(blocks: TenantPageBlock[]): ContentBlockInput[] {
  return blocks.map(block => ({ id: block.id, source_block_id: block.source_block_id, parent_block_id: block.parent_block_id, level: block.level, type: block.type, data: block.data }))
}

async function tenantPagePlacementQueries(
  db: DbClient,
  organizationId: string,
  blocks: TenantPageBlock[],
  now?: string,
  saved?: readonly TenantPageBlock[],
): Promise<BatchQuery[]> {
  if (!blocks.length) return []
  const queries: BatchQuery[] = []
  const ids = blocks.map(block => block.id)
  const placementsByBlock = saved
    ? new Map(saved.map(block => [block.id, block.media]))
    : await getMediaPlacements(db, { organizationId, ownerType: 'content_block', ownerIds: ids })
  const existingBlockIds = new Set(saved ? saved.map(block => block.id) : (await queryAll<{ id: string }>(db, `
    SELECT id FROM content_blocks WHERE id IN (SELECT value FROM json_each(?))
  `, [d1JsonStringSet(ids)])).map(row => row.id))
  for (const block of blocks) {
    const bySlot = new Map<string, typeof block.media>()
    for (const item of block.media) {
      const slotMedia = bySlot.get(item.slot) ?? []
      slotMedia.push(item)
      bySlot.set(item.slot, slotMedia)
    }
    if (existingBlockIds.has(block.id)) {
      const currentBySlot = new Map<string, string[]>()
      for (const item of placementsByBlock.get(block.id) ?? []) {
        const ids = currentBySlot.get(item.slot) ?? []
        ids.push(item.asset_id)
        currentBySlot.set(item.slot, ids)
      }
      const slots = new Set([...currentBySlot.keys(), ...bySlot.keys()])
      for (const slot of slots) {
        const current = currentBySlot.get(slot) ?? []
        const requested = (bySlot.get(slot) ?? []).map(item => item.asset_id)
        if (current.length === requested.length && current.every((assetId, index) => assetId === requested[index])) continue
        if (!isSingleMediaPlacement({ owner_type: 'content_block', slot })) {
          badRequest(`blocks.${block.id}.media cannot replace an existing gallery; use attach/remove/reorder media operations`)
        }
        const media = await hydrateMediaAssetRefs(db, {
          organizationId,
          refs: (bySlot.get(slot) ?? []).map(item => ({ asset_id: item.asset_id })),
          allowedKinds: ['image', 'video'],
          fieldName: `blocks.${block.id}.media`,
        })
        queries.push(...buildSingleMediaPlacementQueries({
          organizationId,
          placement: { owner_type: 'content_block', owner_id: block.id, slot },
          media,
          now,
        }))
      }
      continue
    }
    const canonicalSlot = block.type === 'gallery' ? 'gallery' : ['hero', 'image'].includes(block.type) ? 'media' : null
    const slots = new Set([...bySlot.keys(), ...(canonicalSlot ? [canonicalSlot] : [])])
    for (const slot of slots) {
      const items = bySlot.get(slot) ?? []
      const media = await hydrateMediaAssetRefs(db, {
        organizationId,
        refs: items.map(item => ({ asset_id: item.asset_id })),
        allowedKinds: ['image', 'video'],
        fieldName: `blocks.${block.id}.media`,
      })
      queries.push(...insertInitialMediaPlacements({
        organizationId,
        placement: { owner_type: 'content_block', owner_id: block.id, slot },
        media,
        now,
      }))
    }
  }
  return queries
}

export function preserveOmittedBlockMedia(value: unknown, existingBlocks: TenantPageBlock[]): unknown {
  if (!Array.isArray(value)) return value
  const existingById = new Map(existingBlocks.map(block => [block.id, block.media]))
  return value.map((rawBlock) => {
    if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) return rawBlock
    if (Object.prototype.hasOwnProperty.call(rawBlock, 'media')) return rawBlock
    const id = 'id' in rawBlock && typeof rawBlock.id === 'string' ? rawBlock.id : null
    return id && existingById.has(id)
      ? { ...rawBlock, media: existingById.get(id) }
      : rawBlock
  })
}

export interface TenantPageScope {
  organizationId: string
}

function pageRepresentationQuery(
  target: string | (({ path: string } | { product_id: string }) & { locale: string | { sql: string; params?: unknown[] }; preview: boolean }),
  organization?: string | { sql: string }, editor = false,
): BatchQuery {
  const scope = typeof organization === 'string' ? '?' : organization?.sql
  const publication = editor ? `,
    CASE WHEN ${publicTenantPageSql('p')} AND EXISTS (SELECT 1 FROM organization_locales l
      WHERE l.organization_id = v.organization_id AND l.locale = v.locale
        AND (v.row_role = 'root' OR l.status = 'published'))
      THEN v.path END AS public_path` : ''
  const where = typeof target === 'string' ? 'v.id = ?'
    : `${'product_id' in target ? 'p.product_id' : 'v.path'} = ? AND v.locale = ${typeof target.locale === 'string' ? '?' : target.locale.sql}
        ${target.preview ? '' : `AND ${publicTenantPageSql('p')}`}`
  return {
    query: `SELECT v.id, COALESCE(v.root_id, v.id) AS page_id, v.organization_id, v.locale, v.path, p.path AS source_path,
      v.title, v.summary, p.product_id, v.kind, v.row_role, v.root_id, v.created_at,
      json_extract(p.metadata_json, '$.page_type') AS page_type, json_extract(p.metadata_json, '$.recipe') AS recipe, p.sort_order, v.updated_at${publication}
      FROM content_documents v JOIN content_documents p ON p.id = COALESCE(v.root_id, v.id)
        AND p.row_role = 'root' AND p.kind = 'page' AND p.organization_id = v.organization_id
      WHERE v.row_role IN ('root','representation') AND v.kind = 'page' AND ${where} ${scope ? `AND v.organization_id = ${scope}` : ''} LIMIT 1`,
    params: [...(typeof target === 'string' ? [target] : ['product_id' in target ? target.product_id : target.path, ...(typeof target.locale === 'string' ? [target.locale] : target.locale.params ?? [])]),
      ...(typeof organization === 'string' ? [organization] : [])],
  }
}

async function resolveLocale(db: DbClient, organizationId: string, locale?: string | null): Promise<string> {
  if (locale?.trim()) {
    const exactLocale = assertExactCanonicalLocale(locale)
    const row = await queryFirst<{ locale: string } | null>(
      db,
      // Authoring: a language being translated is `disabled` until it is
      // published, and its pages have to be writable before then.
      'SELECT locale FROM organization_locales WHERE organization_id = ? AND locale = ? LIMIT 1',
      [organizationId, exactLocale],
    )
    if (!row) notFound('Locale is not configured for this organization')
    return row.locale
  }
  return (await getPersistedSourceLocale(db, organizationId)).locale
}

export async function assertTenantPagePathAvailable(
  db: DbClient,
  input: { organizationId: string; locale: string; path: string; site: PublicSiteDefinition; excludeVariantId?: string | null; allowOwnedRedirectVariantId?: string | null },
) {
  const sourceLocale = await resolveLocale(db, input.organizationId)
  const path = normalizeTenantPagePath(input.path)
  // One rule, from one declaration: the site renders a document here, or
  // nothing claims the path and the site's catch-all renders it. The hand
  // lists this replaced named routes that had been deleted and reserved routes
  // that do read a document.
  if (!siteAllowsPageDocumentAt(input.site, CLAIMED_PUBLIC_ROUTES, path)) {
    conflict('This path is reserved by a platform or product route')
  }
  // A venue's location overview may carry an authored page; it needs its location.
  const locationPath = (input.site.pageDocuments.patterns ?? []).includes('/locations/:slug()') ? /^\/locations\/([^/]+)$/.exec(path) : null
  if (isPublicLocationPath(path) && !hasPublicLocationPages((await loadOrganizationSite(db, input.organizationId)).vertical)) conflict('Lodging homes use /stays; location pages are not available')
  if (locationPath && !await queryFirst(db, 'SELECT id FROM business_locations WHERE organization_id = ? AND slug = ? LIMIT 1', [input.organizationId, locationPath[1]!])) {
    notFound('The location for this page was not found')
  }
  const row = await queryFirst<{ id: string } | null>(db, [
    'SELECT id FROM content_documents',
    `WHERE row_role IN ('root','representation') AND kind = 'page' AND organization_id = ? AND locale = ? AND path = ?`,
    '  AND (? IS NULL OR id <> ?) LIMIT 1',
  ].join('\n'), [input.organizationId, input.locale, path, input.excludeVariantId ?? null, input.excludeVariantId ?? null])
  if (row) conflict('A tenant page already uses this path for the selected locale')
  const redirect = await queryFirst<{ id: string } | null>(db, `
    SELECT id FROM organization_redirects
     WHERE organization_id = ? AND locale = ? AND from_path = ?
       AND (? IS NULL OR owner_id IS NULL OR owner_id <> ?)
     LIMIT 1
  `, [input.organizationId, input.locale, formatTenantLocalePath(path, input.locale, sourceLocale), input.allowOwnedRedirectVariantId ?? null, input.allowOwnedRedirectVariantId ?? null])
  if (redirect) conflict('A tenant redirect already owns this path')
  return path
}

/**
 * The identity an update writes: what the caller stated, checked against the
 * rule that a translated variant cannot diverge from its source.
 *
 * It used to inherit the stored row whenever the caller left a field out, which
 * meant the caller could not tell whether it was setting an identity or being
 * given one. The caller states both now, so this only has to agree or refuse.
 */
async function canonicalTenantPageIdentity(
  db: DbClient,
  row: Pick<PageRepresentationRow, 'organization_id' | 'locale' | 'page_type' | 'recipe'>,
  input: { pageType: TenantPageType; recipe: string | null },
): Promise<{ pageType: TenantPageType; recipe: string | null }> {
  const recipe = input.recipe?.trim() || null
  if (input.pageType === row.page_type && recipe === row.recipe) return { pageType: input.pageType, recipe }
  const source = await queryFirst<{ is_source: number } | null>(db, `
    SELECT is_source FROM organization_locales WHERE organization_id = ? AND locale = ? LIMIT 1
  `, [row.organization_id, row.locale])
  if (!source?.is_source) {
    badRequest('A translated tenant-page variant must use the source page identity')
  }
  return { pageType: input.pageType, recipe }
}

function pageDto(row: PageRepresentationRow, document: TenantPageDocument, blocks: TenantPageBlock[]): TenantPageDto {
  return {
    id: row.id,
    page_id: row.page_id,
    organization_id: row.organization_id,
    product_id: row.product_id,
    locale: row.locale,
    path: row.path,
    title: row.title,
    summary: row.summary,
    page_type: row.page_type,
    recipe: row.recipe,
    sort_order: row.sort_order,
    blocks,
    document,
    updated_at: row.updated_at,
  }
}

export interface PageTask {
  id: string
  page_id: string
  title: string
  headline: string
  reason: string
  action_label: string
  to: string
  image_url?: string | null
}

export async function listTenantPages(db: DbClient, organizationId: string, opts: { locale?: string | null } = {}) {
  const plan = prepareTenantPages(organizationId, opts.locale)
  return plan.read(await executeBatch(db, plan.queries, { operation: 'Read website pages and images' }), organizationId).pages
}

export function prepareTenantPages(organizationId: string | { sql: string }, requestedLocale?: string | null) {
  const org = typeof organizationId === 'string' ? '?' : organizationId.sql
  const orgParams = typeof organizationId === 'string' ? [organizationId] : []
  const locale = requestedLocale?.trim() ? assertExactCanonicalLocale(requestedLocale) : null
  const representations = `row_role IN ('root','representation') AND kind = 'page' AND organization_id = ${org}
    AND locale = ${locale ? '?' : `(SELECT locale FROM organization_locales WHERE organization_id = ${org} AND is_source = 1)`}`
  const params = [...orgParams, ...(locale ? [locale] : orgParams)]
  const pages = [
    'SELECT v.id, COALESCE(v.root_id, v.id) AS page_id, v.organization_id, v.locale, v.path,',
    '       v.title, v.summary, p.product_id,',
    `       json_extract(p.metadata_json, '$.page_type') AS page_type, json_extract(p.metadata_json, '$.recipe') AS recipe, p.sort_order, v.updated_at,`,
    '       (SELECT COUNT(*) FROM content_blocks cb WHERE cb.document_id = v.id) AS section_count',
    `  FROM content_documents v JOIN content_documents p ON p.id = COALESCE(v.root_id, v.id) AND p.row_role = 'root' AND p.kind = 'page'`,
    ` WHERE v.id IN (SELECT id FROM content_documents WHERE ${representations}) ORDER BY p.sort_order ASC, v.title ASC`,
  ].join('\n')
  const queries = [
    locale ? { query: `SELECT locale FROM organization_locales WHERE organization_id = ${org} AND locale = ?`, params: [...orgParams, locale] } : sourceLocaleQuery(organizationId),
    { query: `SELECT theme_id FROM organization WHERE id = ${org}`, params: orgParams },
    { query: pages, params },
    mediaPlacementsQuery({ organizationId, ownerType: 'content_document', owners: {
      sql: `SELECT id FROM content_documents WHERE ${representations} AND path <> '/'`, params,
    } }),
    mediaPlacementsQuery({ organizationId, ownerType: 'organization', owners: { sql: `SELECT ${org}`, params: orgParams } }),
  ]
  return { queries, read }

  function read([locales, organization, documents, placements, organizationPlacements]: D1Result[], id: string) {
    const source_locale = locale
      ? (locales!.results[0] as { locale: string } | undefined)?.locale ?? notFound('Locale is not configured for this organization')
      : sourceLocaleFromRows(id, locales!.results).locale
    const siteRow = organization!.results[0] as { theme_id: string } | undefined
    if (!siteRow) notFound('Organization not found')
    const fixedPaths = sitePageDocumentPaths(resolvePublicSite({ themeId: siteRow.theme_id }))
    const rows = documents!.results as (PageRepresentationRow & { section_count: number })[]
    const media = groupMediaPlacements(placements!.results)
    const orgMedia = groupMediaPlacements(organizationPlacements!.results).get(id) ?? []

    return { source_locale, pages: rows.map(row => ({
      id: row.id,
      page_id: row.page_id,
      locale: row.locale,
      path: row.path,
      title: row.title,
      page_type: row.page_type,
      recipe: row.recipe,
      sort_order: row.sort_order,
      updated_at: row.updated_at,
      section_count: row.section_count ?? 0,
      image_url: (row.path === '/'
        ? resolveSocialImageFromMedia('organization', orgMedia, orgMedia)
        : resolveSocialImageFromMedia('content_document', media.get(row.id) ?? [], orgMedia))?.url ?? null,
      product_id: row.product_id,
      removable: !fixedPaths.includes(normalizeTenantPagePath(row.path)),
    })) }
  }
}

export function pageTasks(pages: Awaited<ReturnType<typeof listTenantPages>>): PageTask[] {
  const tasks: PageTask[] = []

  // Pages that are empty, or a main page without a photo.
  for (const page of pages) {
    if (page.section_count === 0) {
      tasks.push({
        id: `task-empty-${page.id}`,
        page_id: page.id,
        title: page.title,
        headline: `Add content: ${page.title}`,
        reason: `This page is empty. Add sections so visitors learn about your practice and offerings.`,
        action_label: 'Add sections',
        to: `/dashboard/[orgSlug]/website/pages/${page.id}`,
        image_url: page.image_url,
      })
    } else if (!page.image_url && ['/', '/about', '/services', '/contact'].includes(page.path)) {
      tasks.push({
        id: `task-photo-${page.id}`,
        page_id: page.id,
        title: page.title,
        headline: `Add photo: ${page.title}`,
        reason: `Pages with photos build client trust and appear in search result previews.`,
        action_label: 'Add photo',
        to: `/dashboard/[orgSlug]/website/pages/${page.id}`,
        image_url: null,
      })
    }
  }

  return tasks
}

// The representation row this page is built from IS its content document row,
// and TenantPageDocument is only {id, updated_at} — both already on the row.
function documentOf(row: PageRepresentationRow): TenantPageDocument {
  return { id: row.id, updated_at: row.updated_at }
}

function tenantPageBlockQueries(organizationId: string | { sql: string }, document: string | { sql: string }): BatchQuery[] {
  return [
    contentBlocksQuery(document),
    mediaPlacementsQuery({ organizationId, ownerType: 'content_block', owners: {
      sql: `SELECT id FROM content_blocks WHERE document_id = ${typeof document === 'string' ? '?' : document.sql}`,
      params: typeof document === 'string' ? [document] : [],
    } }),
  ]
}

// Blocks with the media shape the tenant page surfaces use.
function tenantPageBlocksFromRows([blocks, media]: Awaited<ReturnType<typeof executeBatch>>): TenantPageBlock[] {
  const placements = groupMediaPlacements(media!.results)
  return (blocks!.results as ContentBlockRow[]).map(row => ({
    ...formatBlockOutline(row),
    media: (placements.get(row.id) ?? []).map(({ asset_id, slot, sort_order, public_url, thumbnail_url, kind, alt_text, file_name, width, height }) => ({
      asset_id, slot, sort_order, public_url, thumbnail_url, kind, alt_text, file_name, width, height,
    })),
  })) as TenantPageBlock[]
}

export function prepareTenantPageEditorSnapshot(variantId: string, organization?: string | { sql: string }, editor = false) {
  return prepareTenantPageSnapshot(pageRepresentationQuery(variantId, organization, editor), editor)
}

export function prepareTenantPageAtPath(organization: string | { sql: string }, path: string, locale: string | { sql: string }, preview = false) {
  return prepareTenantPageSnapshot(pageRepresentationQuery({ path: normalizeTenantPagePath(path), locale, preview }, organization), false)
}

function prepareTenantPageSnapshot(page: BatchQuery, editor: boolean) {
  const scoped = { sql: '(SELECT organization_id FROM page_scope)' }
  const document = { sql: '(SELECT id FROM page_scope)' }
  const pageWithFaq = { sql: `(SELECT path FROM page_scope WHERE EXISTS (
    SELECT 1 FROM content_blocks b WHERE b.document_id = page_scope.id AND b.type = 'faq'
      AND json_extract(b.data_json, '$.source') = 'page_qa'))` }
  const locale = { sql: '(SELECT locale FROM page_scope)' }
  const material = tenantPageBlockQueries(scoped, document)
  if (editor) material.push(qaListQuery(scoped, null, locale, true, pageWithFaq))
  return {
    statement: page,
    queries: [
      page,
      ...material.map(query => ({
        query: `WITH page_scope AS (${page.query}) ${query.query}`,
        params: [...(page.params ?? []), ...(query.params ?? [])],
      })),
    ],
    read([result, ...related]: D1Result[]) {
      const row = result!.results[0] as (PageRepresentationRow & ContentDocumentRow & { public_path?: string | null; source_path: string | null }) | undefined
      if (!row) return null
      const blocks = tenantPageBlocksFromRows(related)
      const faq = related[2]?.results as QaDocument[] | undefined
      if (faq?.length) for (const block of blocks) {
        if (block.type === 'faq' && block.data.source === 'page_qa' && (!Array.isArray(block.data.items) || !block.data.items.length)) {
          block.data.items = faq.map(qa => ({ title: qa.question, description: qa.answer ?? '' }))
        }
      }
      const route = row.public_path && (row.id === row.page_id ? row.public_path : platformLocale(row.locale)
        ? `/${row.locale}${row.public_path === '/' ? '' : row.public_path}` : null)
      return { row, blocks, page: pageDto(row, documentOf(row), blocks), publicPath: route ?? null }
    },
  }
}

async function readTenantPageSnapshot(db: DbClient, variantId: string, scope?: TenantPageScope, editor = false) {
  const plan = prepareTenantPageEditorSnapshot(variantId, scope?.organizationId, editor)
  const snapshot = plan.read(await executeBatch(db, plan.queries, { operation: 'Read website page and blocks' }))
  return snapshot ?? notFound('Tenant page variant not found')
}

export async function getTenantPageById(db: DbClient, variantId: string, scope?: TenantPageScope): Promise<TenantPageDto> {
  return (await readTenantPageSnapshot(db, variantId, scope, true)).page
}

export async function getPublishedTenantPage(db: DbClient, organizationId: string, path: string, locale?: string | null): Promise<TenantPageDto | null> {
  const plan = prepareTenantPageAtPath(organizationId, path, await resolveLocale(db, organizationId, locale))
  return plan.read(await executeBatch(db, plan.queries, { operation: 'Read published page blocks' }))?.page ?? null
}

export function preparePublishedProductPage(organization: string | { sql: string }, productId: string) {
  const source = sourceLocaleQuery(organization)
  const page = pageRepresentationQuery({ product_id: productId,
    locale: { sql: `(SELECT locale FROM (${source.query}))`, params: source.params }, preview: false }, organization)
  return { queries: [source, page], read([language, identity]: D1Result[], organizationId: string, path: string) {
    const expectedPath = normalizeTenantPagePath(path)
    sourceLocaleFromRows(organizationId, language!.results)
    const page = identity!.results[0] as PageRepresentationRow | undefined
    return page?.path === expectedPath ? page : null
  } }
}

export async function resolvePublishedTenantPageIdentity(
  db: DbClient, organizationId: string, path: string, locale?: string | null,
) {
  const target = { path: normalizeTenantPagePath(path), locale: await resolveLocale(db, organizationId, locale), preview: false }
  const { query, params } = pageRepresentationQuery(target, organizationId)
  return queryFirst<PageRepresentationRow>(db, query, params)
}

export async function createTenantPagesBatch(
  db: DbClient,
  input: {
    env: CloudflareEnv
    organizationId: string
    userId?: string | null
    writeGuard?: BatchQuery
    pages: Array<{
      data: TenantPageEditorInput
      trustedSystemPage?: boolean
    }>
  },
) {
  const locale = await resolveLocale(db, input.organizationId)
  const { site } = await loadOrganizationSite(db, input.organizationId)
  const localeRow = await queryFirst<{ is_source: number } | null>(db, `
    SELECT is_source FROM organization_locales WHERE organization_id = ? AND locale = ? LIMIT 1
  `, [input.organizationId, locale])
  if (!localeRow?.is_source) badRequest('Translated tenant-page variants must reference an existing source page')

  const existingVariants = await queryAll<{ path: string; }>(db, `
    SELECT path
      FROM content_documents
     WHERE row_role IN ('root','representation') AND kind = 'page' AND organization_id = ? AND locale = ?
  `, [input.organizationId, locale])
  const existingPaths = new Set<string>()
  for (const row of existingVariants) {
    existingPaths.add(normalizeTenantPagePath(row.path))
  }
  const existingRedirects = await queryAll<{ from_path: string }>(db, `
    SELECT from_path
      FROM organization_redirects
      WHERE organization_id = ? AND locale = ?
  `, [ input.organizationId, locale])
  const redirectPaths = new Set(existingRedirects.map(row => normalizeTenantPagePath(row.from_path)))
  const requestedPaths = new Set<string>()
  const queries: BatchQuery[] = []
  let created = 0

  for (const pageInput of input.pages) {
    const data = pageInput.data
    if (data.page_id) badRequest('Batch tenant-page creation cannot include an existing page parent')
    if (data.locale !== undefined && data.locale !== locale) badRequest('Batch page creation uses the organization primary language')
    const path = normalizeTenantPagePath(data.path)
    if (existingPaths.has(path)) continue
    if (requestedPaths.has(path)) conflict('A batch contains duplicate tenant-page paths')
    requestedPaths.add(path)
    if (!siteAllowsPageDocumentAt(site, CLAIMED_PUBLIC_ROUTES, path)) {
      conflict('This path is reserved by a platform or product route')
    }
    if (redirectPaths.has(path)) conflict('A tenant redirect already owns this path')

    const pageType = data.page_type ?? 'custom'
    if (pageType === 'system' && pageInput.trustedSystemPage !== true) {
      badRequest('System pages are managed by the site')
    }
    const effectiveData: TenantPageEditorInput = { ...data, locale, path, page_type: pageType }
    const metadata = metadataForInput(effectiveData, locale, path)
    const blocks = normalizeTenantPageBlocks(effectiveData.blocks)
    await assertTenantPageSupport(input.env, db, input.organizationId, effectiveData, blocks)

    const pageId = effectiveData.id ?? crypto.randomUUID()
    const variantId = pageId
    const now = new Date().toISOString()
    const placementQueries = await tenantPagePlacementQueries(db, input.organizationId, blocks, now)
    const prepared = prepareContentDocumentWithBlocks({
      id: variantId, rowRole: 'root', locale, organizationId: input.organizationId, kind: 'page',
      metadata: { page_type: metadata.pageType, recipe: metadata.recipe }, source: 'pages',
      path, title: metadata.title, summary: metadata.summary, createdBy: input.userId, updatedBy: input.userId,
    }, blocksAsInputs(blocks), {
      additionalQueriesAfter: placementQueries,
    })
    queries.push(...prepared.queries)
    existingPaths.add(path)
    created += 1
  }

  if (created > 0) {
    queries.push(publicResourceCacheInvalidationQuery(input.organizationId, 'tenant-page-seed'))
    await executeBatch(db, [...(input.writeGuard ? [input.writeGuard] : []), ...queries])
  }
  return { created }
}

// Onboarding commit writes the whole page it collected. Every metadata field is
// stated, so an absent one is null rather than whatever the previous commit left
// behind — there is one source for this document and it is the draft.
export interface OnboardingTenantPageInput {
  path: string
  title: string
  summary: string | null
  pageType: TenantPageType
  recipe: string | null
  blocks: unknown
  trustedSystemPage?: boolean
}

interface OnboardingPageRepresentationRow extends PageRepresentationRow {
  created_at: string
}

export async function applyOnboardingTenantPages(
  db: DbClient,
  input: {
    env: CloudflareEnv
    organizationId: string
    userId: string | null
    pages: OnboardingTenantPageInput[]
    writeGuard?: BatchQuery
  },
) {
  if (!input.pages.length) return { updated: 0, created: 0 }

  const pages = input.pages.map(page => ({
    ...page,
    path: normalizeTenantPagePath(page.path),
  }))
  const paths = pages.map(page => page.path)
  if (new Set(paths).size !== paths.length) badRequest('Onboarding page paths must be unique')
  const locale = await resolveLocale(db, input.organizationId)
  const existingRows = await queryAll<OnboardingPageRepresentationRow>(db, `
    SELECT v.id, COALESCE(v.root_id, v.id) AS page_id, v.organization_id, v.locale,
           v.path, v.title, v.summary, json_extract(p.metadata_json, '$.page_type') AS page_type, json_extract(p.metadata_json, '$.recipe') AS recipe,
           p.sort_order, v.updated_at,
           v.created_at
      FROM content_documents v
      JOIN content_documents p ON p.id = COALESCE(v.root_id, v.id) AND p.row_role = 'root' AND p.kind = 'page'
     WHERE v.row_role IN ('root','representation') AND v.kind = 'page'  AND v.organization_id = ? AND v.locale = ?
       AND v.path IN (SELECT value FROM json_each(?))
  `, [ input.organizationId, locale, d1JsonStringSet(paths)])
  const existingByPath = new Map<string, OnboardingPageRepresentationRow>()
  for (const row of existingRows) {
    existingByPath.set(normalizeTenantPagePath(row.path), row)
  }

  const replacementQueries: BatchQuery[] = []
  const missingPages: OnboardingTenantPageInput[] = []
  let updated = 0
  for (const page of pages) {
    const row = existingByPath.get(page.path)
    if (!row) {
      missingPages.push(page)
      continue
    }
    // page_type and recipe are the page's identity and onboarding does not get
    // to change them; everything else is the document the draft states.
    const effectiveData: TenantPageEditorInput = {
      ...page,
      locale,
      page_type: row.page_type,
      recipe: row.recipe,
    }
    const metadata = metadataForInput(effectiveData, locale, page.path)
    const blocks = normalizeTenantPageBlocks(page.blocks)
    await assertTenantPageSupport(input.env, db, input.organizationId, effectiveData, blocks)

    const document = {
      id: row.id,
      organization_id: input.organizationId,
      kind: 'page' as const,
      row_role: row.id === row.page_id ? 'root' as const : 'representation' as const,
      root_id: row.id === row.page_id ? null : row.page_id,
      locale: row.locale,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
    const now = new Date().toISOString()
    const placementQueries = await tenantPagePlacementQueries(db, input.organizationId, blocks, now)
    const prepared = prepareContentDocumentUpdate(document, {
      blocks: blocksAsInputs(blocks), updated_at: row.updated_at,
      changes: { path: page.path, title: metadata.title, summary: metadata.summary,
        updated_by: input.userId,
        metadata: { page_type: metadata.pageType, recipe: metadata.recipe } },
      additionalQueriesAfter: placementQueries,
    })
    replacementQueries.push(...prepared.queries)
    updated += 1
  }

  if (replacementQueries.length) {
    replacementQueries.push(publicResourceCacheInvalidationQuery(input.organizationId, 'tenant-page-onboarding-import'))
    await executeBatch(db, [...(input.writeGuard ? [input.writeGuard] : []), ...replacementQueries])
  }

  let created = 0
  if (missingPages.length) {
    const result = await createTenantPagesBatch(db, {
      env: input.env,
      writeGuard: input.writeGuard,
      organizationId: input.organizationId,
      userId: input.userId,
      pages: missingPages.map(page => ({
        trustedSystemPage: page.trustedSystemPage,
        data: {
          locale,
          path: page.path,
          title: page.title,
          summary: page.summary,
          page_type: page.pageType,
          recipe: page.recipe,
          blocks: page.blocks,
        },
      })),
    })
    created = result.created
  }
  return { updated, created }
}

type TenantPageCreateInput = {
  organizationId: string
  userId: string | null
  data: TenantPageEditorInput
  trustedSystemPage?: boolean
  env: CloudflareEnv
  /**
   * The Product named by `data.product_id` is inserted earlier in the same
   * batch, so it cannot be read yet; its ownership is the caller's write and
   * the binding's foreign key, not a read here.
   */
  productInSameBatch?: boolean
  pathOwnerDeletedInSameBatch?: string
}

/**
 * Everything creating a page reads and validates, and the statements that
 * write it, without running them. Creating a page and creating a Product with
 * its page share this preparation, so there is one page writer whichever
 * commits it.
 *
 * A source page may be created already bound to a Product; the binding is the
 * root row's `product_id`, so it lands with the page or not at all. One page
 * per Product is the database's unique index, which a concurrent bind cannot
 * get past; the read here only turns the common case into a clear message.
 */
export async function prepareTenantPageCreate(db: DbClient, input: TenantPageCreateInput): Promise<{ variantId: string; path: string; queries: BatchQuery[] }> {
  const locale = await resolveLocale(db, input.organizationId, input.data.locale)
  const existingPage = input.data.page_id
    ? await queryFirst<{ id: string; organization_id: string; page_type: TenantPageType; recipe: string | null } | null>(db, `
        SELECT id, organization_id, json_extract(metadata_json, '$.page_type') AS page_type, json_extract(metadata_json, '$.recipe') AS recipe
          FROM content_documents
         WHERE row_role = 'root' AND kind = 'page' AND id = ? AND organization_id = ? 
         LIMIT 1
      `, [input.data.page_id, input.organizationId])
    : null
  if (input.data.page_id && !existingPage) notFound('Tenant page parent not found')
  const productId = input.data.product_id == null ? null : asString(input.data.product_id, 'product_id')
  if (productId && existingPage) badRequest('Bind the Product on the source page, not a translation')
  if (productId && !input.productInSameBatch) {
    if (!await queryFirst(db, 'SELECT id FROM products WHERE id = ? AND organization_id = ?', [productId, input.organizationId])) {
      badRequest('Product is not owned by this organization')
    }
    if (await queryFirst(db, "SELECT id FROM content_documents WHERE organization_id = ? AND product_id = ? AND row_role = 'root'", [input.organizationId, productId])) {
      conflict('Product already has a canonical page; unbind it there first')
    }
  }
  const localeRow = await queryFirst<{ is_source: number } | null>(db, `
    SELECT is_source FROM organization_locales WHERE organization_id = ? AND locale = ? LIMIT 1
  `, [input.organizationId, locale])
  if (!existingPage && !localeRow?.is_source) badRequest('Translated tenant-page variants must reference an existing source page')
  // A translated variant's identity is its source page's. The caller may state
  // it, but only to agree with the source; it does not get to pick a different
  // one, and omitting it does not mean "choose for me".
  if (existingPage) {
    if (input.data.sort_order !== undefined) badRequest('Set sort_order on the source page, not a translation')
    const statedRecipe = input.data.recipe === undefined ? undefined : input.data.recipe?.trim() || null
    if ((input.data.page_type !== undefined && input.data.page_type !== existingPage.page_type)
      || (statedRecipe !== undefined && statedRecipe !== existingPage.recipe)) {
      badRequest('A translated tenant-page variant must use the source page identity')
    }
  }
  const effectiveData: TenantPageEditorInput = {
    ...input.data,
    ...(existingPage ? { page_type: existingPage.page_type, recipe: existingPage.recipe } : {}),
  }
  const existingSystemPage = existingPage?.page_type === 'system'
  if (effectiveData.page_type === 'system' && !input.trustedSystemPage && !existingSystemPage) badRequest('System pages are managed by the site')
  const { site } = await loadOrganizationSite(db, input.organizationId)
  const path = await assertTenantPagePathAvailable(db, {
    organizationId: input.organizationId,
    locale,
    path: input.data.path,
    site,
    excludeVariantId: input.pathOwnerDeletedInSameBatch,
  })
  const metadata = metadataForInput(effectiveData, locale, path)
  const blocks = normalizeTenantPageBlocks(effectiveData.blocks)
  await assertTenantPageSupport(input.env, db, input.organizationId, effectiveData, blocks, { checkCustomPageEntitlement: !existingPage })
  const pageId = existingPage?.id ?? effectiveData.id ?? crypto.randomUUID()
  const variantId = existingPage ? effectiveData.id ?? crypto.randomUUID() : pageId
  const now = new Date().toISOString()
  const placementQueries = await tenantPagePlacementQueries(db, input.organizationId, blocks, now)
  const representation: ContentDocumentInput = {
    id: variantId, organizationId: input.organizationId, kind: 'page',
    // sort_order lives on the root document, so only the root branch states it.
    // It used to be accepted and dropped: a caller that asked for a position got
    // 0 and no error.
    ...(existingPage ? { rowRole: 'representation', rootId: pageId, locale } : {
      rowRole: 'root', locale, metadata: { page_type: metadata.pageType, recipe: metadata.recipe }, source: 'pages', productId,
      ...(typeof effectiveData.sort_order === 'number' ? { sortOrder: effectiveData.sort_order } : {}),
    }),
    path, title: metadata.title, summary: metadata.summary, createdBy: input.userId, updatedBy: input.userId,
  }
  const prepared = prepareContentDocumentWithBlocks(representation, blocksAsInputs(blocks), { additionalQueriesAfter: placementQueries })
  return { variantId, path, queries: [...prepared.queries,
    organizationEventQuery({ organizationId: input.organizationId, actorId: input.userId, eventType: 'content.updated', entityType: 'page', entityId: variantId,
      afterState: { updated_at: prepared.document.updated_at },
      metadata: { operation: 'created', changed_fields: ['title', 'summary', 'content_blocks'], evidence_basis: 'persisted_change', locale, page_id: pageId } }),
    publicResourceCacheInvalidationQuery(input.organizationId, 'tenant-page-create')] }
}

/** True when a batch failed on the one-page-per-Product index. */
export function isProductPageConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /UNIQUE constraint failed/.test(message) && /content_documents\.product_id/.test(message)
}

/**
 * The social card for a page that was just written. It runs after the commit,
 * so a failure here is reported as itself, never as a page that was not made.
 */
export async function refreshTenantPageCard(db: DbClient, env: CloudflareEnv, created: { variantId: string; path: string }, actorId: string | null) {
  // The home page has no card of its own, and the organization's card draws
  // the share image rather than anything on the page.
  if (created.path !== '/') {
    await refreshSocialCard({ db, env, owner: { owner_type: 'content_document', owner_id: created.variantId }, actorId })
  }
}

export async function createTenantPage(db: DbClient, input: TenantPageCreateInput) {
  const prepared = await prepareTenantPageCreate(db, input)
  try {
    await executeBatch(db, prepared.queries, { operation: 'Create tenant page' })
  } catch (error) {
    if (isProductPageConflict(error)) conflict('Product already has a canonical page; unbind it there first')
    throw error
  }
  await refreshTenantPageCard(db, input.env, prepared, input.userId)
  return { page: await getTenantPageById(db, prepared.variantId) }
}

/**
 * Remove a tenant page, or one of its translations.
 *
 * Scope follows the row: deleting a translation removes that translation, and
 * deleting the source removes the page and every translation with it — the
 * content_documents_root_scope_fk cascade takes the representation rows, and
 * prepareContentDocumentDeletion clears the placements and redirects that point
 * at them by owner_id first, because those carry no foreign key of their own.
 *
 * A page the shared site renderer requires is not the owner's to remove: deleting it
 * would leave a route with nothing to show. That is the same declaration the
 * writer checks before creating a page, not a second rule about page_type — a
 * dead row the site no longer maps, like the /locations/main every site used
 * to be seeded with, is deletable precisely because nothing renders it.
 */
export async function prepareTenantPageDelete(db: DbClient, variantId: string, input: { scope: TenantPageScope; expectedUpdatedAt: string }) {
  const { query, params } = pageRepresentationQuery(variantId, input.scope.organizationId)
  const row = await queryFirst<PageRepresentationRow>(db, query, params)
  if (!row) notFound('Tenant page variant not found')
  if (row.updated_at !== input.expectedUpdatedAt) conflict('Tenant page content was updated by another writer')

  const { site } = await loadOrganizationSite(db, row.organization_id)
  // Only a page the site guarantees is refused. A subtree it serves as
  // documents, Blawby's /services/, holds pages an owner or a Product made,
  // and they delete like any other.
  if (sitePageDocumentPaths(site).includes(normalizeTenantPagePath(row.path))) {
    conflict("This page is one the organization's site renders, so it cannot be deleted")
  }

  // A page another page links to cannot simply go. `page_grid` renders its
  // cards from the referenced documents, and a reference to a page that is
  // gone is a 500 on the referring page, by design — "the editor chose it and
  // needs to know" (server/utils/public-tenant-pages.ts). The editor is told
  // here, before the delete, which page would break. The deleted page's own
  // translations are not referrers: they go with it.
  const referrers = await queryAll<{ path: string }>(db, `
    SELECT DISTINCT d.path
      FROM content_blocks b
      JOIN content_documents d ON d.id = b.document_id
      JOIN json_each(b.data_json, '$.page_ids') ref
     WHERE b.type = 'page_grid' AND d.organization_id = ? AND COALESCE(d.root_id, d.id) <> ? AND ref.value = ?
     ORDER BY d.path
  `, [row.organization_id, row.id, row.id])
  if (referrers.length > 0) {
    conflict(`${referrers.map(item => item.path).join(', ')} link${referrers.length === 1 ? 's' : ''} to this page; remove the link before deleting it`)
  }

  const sourceLocale = await resolveLocale(db, row.organization_id)
  const translations = row.id === row.page_id
    ? await queryAll<{ id: string; locale: string; path: string; updated_at: string }>(db, `
        SELECT id, locale, path, updated_at FROM content_documents
         WHERE root_id = ? AND row_role = 'representation'  AND organization_id = ?
         ORDER BY locale
      `, [row.id, row.organization_id])
    : []
  const removedLocales = translations.map(translation => translation.locale)

  // The same rule archiving applies: a redirect somebody else owns that lands
  // on a removed variant would land on nothing. The page's own redirects go
  // with it in the batch, so they are not counted.
  const removed = [{ locale: row.locale, path: row.path }, ...translations]
  const incoming = {
    sql: `FROM organization_redirects
         WHERE organization_id = ? AND behavior = 'redirect'
           AND NOT (owner_type = 'content_document' AND owner_id IN (
             SELECT id FROM content_documents WHERE (id = ? OR root_id = ?) AND organization_id = ?))
           AND (${removed.map(() => '(locale = ? AND to_path = ?)').join(' OR ')})`,
    params: [
      row.organization_id, row.id, row.id, row.organization_id,
      ...removed.flatMap(variant => [variant.locale, formatTenantLocalePath(variant.path, variant.locale, sourceLocale)]),
    ],
  }
  const pointedAt = await queryFirst<{ count: number }>(db, `SELECT count(*) AS count ${incoming.sql}`, incoming.params)
  if (pointedAt?.count) conflict('Cannot delete a page while another redirect points to it')

  // The timestamps, the translation set and the redirect rule are checked
  // again inside the batch. The reads above give the caller a clear conflict,
  // but queries run between them and this write, and a page changed in that
  // window must not be deleted on the strength of a snapshot taken before it.
  const now = new Date().toISOString()
  const queries: BatchQuery[] = [
    {
      query: `INSERT INTO content_blocks (id, document_id, parent_block_id, type, position, level, data_json, created_at, updated_at)
        SELECT NULL, ?, NULL, 'markdown', 0, NULL, '{}', ?, ? WHERE EXISTS (SELECT 1 ${incoming.sql})`,
      params: [row.id, now, now, ...incoming.params],
    },
    ...prepareContentDocumentDeletion({
      documentId: row.id,
      organizationId: row.organization_id,
      expectedUpdatedAt: input.expectedUpdatedAt,
      expectedRepresentations: row.id === row.page_id
        ? translations.map(translation => ({ id: translation.id, updatedAt: translation.updated_at }))
        : undefined,
    }),
  ]

  return { queries, deleted: { id: row.id, path: row.path, locale: row.locale, removed_locales: removedLocales } }
}

export async function deleteTenantPage(db: DbClient, variantId: string, input: { scope: TenantPageScope; expectedUpdatedAt: string; env: CloudflareEnv }) {
  const prepared = await prepareTenantPageDelete(db, variantId, input)
  await executeBatch(db, prepared.queries)
  return { deleted: prepared.deleted }
}

export async function updateTenantPage(db: DbClient, variantId: string, input: { userId: string | null; data: TenantPageEditorInput; scope: TenantPageScope; env: CloudflareEnv; snapshot?: Awaited<ReturnType<typeof readTenantPageSnapshot>> }) {
  // A complete editor snapshot states the saved path and the title to write.
  if (typeof input.data.path !== 'string' || !input.data.path.trim()) badRequest('path is required')
  if (typeof input.data.title !== 'string' || !input.data.title.trim()) badRequest('title is required')
  // sortOrder is the page's position in its site's page list. An update writes
  // the position the caller states; it used to be COALESCE(?, sort_order), which
  // is the same read-the-row-back fallback wearing SQL.
  if (typeof input.data.sort_order !== 'number') badRequest('sort_order is required')
  const sortOrder = input.data.sort_order
  // Identity is stated, not inherited. Leaving it out used to mean "keep what is
  // stored" in one function and "clear it" in the next, which turned an omitted
  // recipe into `recipe is required for recipe pages`.
  if (!input.data.page_type) badRequest('page_type is required')
  if (input.data.recipe === undefined) badRequest('recipe is required, and may be null')
  const { row, blocks: currentBlocks } = input.snapshot ?? await readTenantPageSnapshot(db, variantId, input.scope)
  if (row.id !== variantId || row.organization_id !== input.scope.organizationId) notFound('Tenant page variant not found')
  if (input.data.path !== row.path) badRequest('A page keeps its saved path')
  if (!input.data.updated_at || row.updated_at !== input.data.updated_at) conflict('Tenant page content was updated by another writer')
  const identity = await canonicalTenantPageIdentity(db, row, {
    pageType: input.data.page_type,
    recipe: input.data.recipe ?? null,
  })
  const pageType = identity.pageType
  if (pageType === 'system' && row.page_type !== 'system') badRequest('Only an existing system page may remain a system page')
  // An update writes the document the caller sent. It does not read the stored
  // row back in for the fields the caller left out: doing that turned "change
  // one block" into a silent full-document rewrite, and made the update reject
  // a path the caller never named. pageType and recipe are the page's identity,
  // resolved above against the source-locale rule, not content the caller omits.
  const effectiveInput = { ...input.data, summary: input.data.summary === undefined ? row.summary : input.data.summary, page_type: pageType, recipe: identity.recipe }
  const path = row.path
  const metadata = metadataForInput(effectiveInput, row.locale, path)
  const blocks = normalizeTenantPageBlocks(preserveOmittedBlockMedia(input.data.blocks, currentBlocks))
  await assertTenantPageSupport(input.env, db, row.organization_id, effectiveInput, blocks, { checkCustomPageEntitlement: row.page_type !== 'custom' && pageType === 'custom' })
  const bindingQueries: BatchQuery[] = []
  if (input.data.product_id !== undefined && input.data.product_id !== row.product_id) {
    if (row.id !== row.page_id) badRequest('Change the Product binding on the source page, not a translation')
    const productId = asString(input.data.product_id, 'product_id')
    if (productId) {
      if (!await queryFirst(db, 'SELECT id FROM products WHERE id = ? AND organization_id = ?', [productId, row.organization_id])) {
        badRequest('Product is not owned by this organization')
      }
      if (await queryFirst(db, "SELECT id FROM content_documents WHERE organization_id = ? AND product_id = ? AND row_role = 'root' AND id <> ?", [row.organization_id, productId, row.page_id])) {
        conflict('Product already has a canonical page; unbind it there first')
      }
    }
    bindingQueries.push({ query: "UPDATE content_documents SET product_id = ? WHERE id = ? AND organization_id = ? AND row_role = 'root'", params: [productId, row.page_id, row.organization_id] })
  }
  const now = new Date().toISOString()
  const placementQueries = await tenantPagePlacementQueries(db, input.scope.organizationId, blocks, now, currentBlocks)
  const blockValues = (items: TenantPageBlock[]) => blocksAsInputs(items).map(block => ({
    id: block.id, source_block_id: block.source_block_id ?? null, parent_block_id: block.parent_block_id ?? null,
    level: block.level ?? null, type: block.type, data: block.data,
  }))
  const blocksChanged = placementQueries.length > 0 || await creationRequestHash(blockValues(blocks)) !== await creationRequestHash(blockValues(currentBlocks))
  const changedFields = [
    ...(metadata.title !== row.title ? ['title'] : []),
    ...(metadata.summary !== row.summary ? ['summary'] : []),
    ...(pageType !== row.page_type ? ['page_type'] : []),
    ...(metadata.recipe !== row.recipe ? ['recipe'] : []),
    ...(sortOrder !== row.sort_order ? ['sort_order'] : []),
    ...(bindingQueries.length ? ['product_id'] : []),
    ...(blocksChanged ? ['content_blocks'] : []),
  ]
  if (!changedFields.length) {
    if (path !== '/') await refreshSocialCard({ db, env: input.env, owner: { owner_type: 'content_document', owner_id: variantId }, actorId: input.userId })
    return { page: await getTenantPageById(db, variantId, input.scope) }
  }
  const updateVariant: BatchQuery = {
    query: 'UPDATE content_documents SET path = ?, title = ?, summary = ?, updated_by = ? WHERE id = ? AND organization_id = ?',
    params: [path, metadata.title, metadata.summary, input.userId, variantId, input.scope.organizationId],
  }
  const updatePage: BatchQuery = {
    query: `UPDATE content_documents SET metadata_json = json_set(metadata_json, '$.page_type', ?, '$.recipe', ?),
      sort_order = ?, updated_by = ?
      WHERE row_role = 'root' AND kind = 'page' AND id = ? AND organization_id = ? AND id = ?`,
    params: [metadata.pageType, metadata.recipe, sortOrder, input.userId,
      row.page_id, input.scope.organizationId, variantId],
  }
  await updateContentDocument(db, row, {
    blocks: blocksChanged ? blocksAsInputs(blocks) : undefined, updated_at: input.data.updated_at,
    actorId: input.userId, changedFields,
    additionalQueriesAfter: [...placementQueries, updateVariant, updatePage, ...bindingQueries],
  })
  // The home page has no card of its own, and the organization's card draws
  // the share image rather than anything on the page.
  if (path !== '/') {
    await refreshSocialCard({ db, env: input.env, owner: { owner_type: 'content_document', owner_id: variantId }, actorId: input.userId })
  }
  return { page: await getTenantPageById(db, variantId, input.scope) }
}

/**
 * Whether a page is public, as SQL over its root row. A page a Product owns is
 * shown while that Product is published on the site — the Product's
 * publication is its visibility, so a new, unpublished service's page stays
 * private — and any other page always is. Public reads, lists, page grids and
 * the sitemap all ask this; a preview, which is authorized, does not.
 */
export function publicTenantPageSql(root: string): string {
  return `(${root}.product_id IS NULL OR EXISTS (SELECT 1 FROM product_publications pub WHERE pub.organization_id = ${root}.organization_id AND pub.product_id = ${root}.product_id AND pub.published = 1))`
}

export async function listPublishedTenantPagePaths(db: DbClient, organizationId: string, locale?: string | null) {
  return readPublishedTenantPagePaths(db, organizationId, await resolveLocale(db, organizationId, locale))
}

export function readPublishedTenantPagePaths(db: DbClient, organizationId: string, locale: string) {
  const { query, params } = publishedTenantPagePathsQuery(organizationId, locale)
  return queryAll<PublishedTenantPagePath>(db, query, params)
}

type PublishedTenantPagePath = { id: string; path: string; title: string; summary: string | null; sort_order: number; updated_at: string }

export function publishedTenantPagePathsQuery(organizationId: string | { sql: string }, locale: string | { sql: string }) {
  return { query: `
    SELECT v.id, v.path, v.title, v.summary, p.sort_order, v.updated_at
      FROM content_documents v JOIN content_documents p ON p.id = COALESCE(v.root_id, v.id)
     WHERE v.row_role IN ('root','representation') AND v.kind = 'page'
       AND v.organization_id = ${typeof organizationId === 'string' ? '?' : organizationId.sql} AND v.locale = ${typeof locale === 'string' ? '?' : locale.sql}
       AND ${publicTenantPageSql('p')}
     ORDER BY v.path ASC
  `, params: [...(typeof organizationId === 'string' ? [organizationId] : []), ...(typeof locale === 'string' ? [locale] : [])] }
}
