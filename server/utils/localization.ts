import { HTTPError } from 'nitro'
import { platformLocale } from '~/shared/platform-locales'
import { parseSiteProductPath } from '~/utils/product-presentation'
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { getOrganizationEntitlements, isSubscriptionStateInvalid } from '~/server/utils/billing-access'
import type { CloudflareEnv } from '~/server/utils/auth'
import {
  createContentDocumentWithBlocks,
  getContentDocumentById,
  getContentEditorSnapshotForDocument,
  updateContentDocument,
  getContentRepresentation,
  prepareContentDocumentDeletion,
  type ContentDocumentChanges,
  type ContentDocumentKind,
  type ContentBlockInput,
} from '~/server/utils/content/documents'
import { localizationError } from '~/server/utils/localization-errors'
import {
  RESOURCE_LOCALIZATION_REGISTRY,
  parseLocalizedResourceType,
  validateLocalizedRoutePath,
  validateLocalizedValues,
  type LocalizedResourceType,
  type LocalizedValues,
} from '~/server/utils/localization-registry'
import { assertProductKind, validateProductDetails, validateStayAlarmDetails, ProductDetailError, type ProductKind } from '~/shared/product-details'
import { STAY_ALARM_AMENITIES, STAY_ALARM_DETAIL_KEYS, parseStayAmenityAnswers } from '~/shared/stay-listing'
import { isRecord } from '~/server/utils/type-guards'
import { PUBLIC_LOCATION_SECTIONS, type PublicLocaleRepresentation } from '~/utils/public-resource-contracts'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { isLegalPracticeSite } from '~/utils/template-registry'


export interface OrganizationLocaleRecord {
  id: string
  organization_id: string
  locale: string
  label: string | null
  is_source: boolean
  status: 'published' | 'disabled'
  created_at: string
  updated_at: string
}

export interface ResourceLocalizationRecord {
  id: string
  organization_id: string
  resource_type: LocalizedResourceType
  resource_id: string
  locale: string
  values: LocalizedValues
  route_path: string | null
  created_at: string
  created_by_user_id: string
  updated_at: string
  updated_by_user_id: string
}

export interface LocalizedPublicRoute {
  locale: string
  route_path: string
  platform_messages: Record<string, string>
  locale_representations: PublicLocaleRepresentation[]
  representation:
    | { kind: 'document'; document_kind: ContentDocumentKind; resource_type: 'content_document'; resource_id: string; document_id: string }
    | { kind: 'resource'; resource_type: LocalizedResourceType; resource_id: string; localization: ResourceLocalizationRecord }
}

interface OrganizationLocaleRow extends Omit<OrganizationLocaleRecord, 'is_source'> {
  is_source: number | boolean
}

interface ResourceLocalizationRow extends Omit<ResourceLocalizationRecord, 'values'> {
  values_json: string
}

interface EntitlementRow {
  locale_status: OrganizationLocaleRecord['status'] | null
}

export function canonicalizeLocale(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    localizationError(400, 'LOCALE_NOT_CANONICAL', 'Locale must be a canonical BCP 47 language tag')
  }
  try {
    const canonical = Intl.getCanonicalLocales(value.trim())
    if (canonical.length !== 1 || !canonical[0]) throw new RangeError('Expected one locale')
    return canonical[0]
  } catch {
    localizationError(400, 'LOCALE_NOT_CANONICAL', 'Locale must be a canonical BCP 47 language tag', { locale: value })
  }
}

export function assertExactCanonicalLocale(value: unknown): string {
  const canonical = canonicalizeLocale(value)
  if (value !== canonical) {
    localizationError(404, 'LOCALE_NOT_CANONICAL', 'Locale path must use the exact canonical language tag', {
      locale: value,
      canonical_locale: canonical,
    })
  }
  return canonical
}

export async function getPersistedSourceLocale(
  db: DbClient,
  organizationId: string,
): Promise<OrganizationLocaleRecord> {
  const rows = await queryAll<OrganizationLocaleRow>(db, `
    SELECT id, organization_id, locale, label, is_source, status, created_at, updated_at
      FROM organization_locales
     WHERE organization_id = ?  AND is_source = 1
     ORDER BY id
  `, [organizationId])
  const source = rows.length === 1 ? rows[0] : undefined
  if (!source || source.status !== 'published' || !platformLocale(source.locale)) {
    throw new HTTPError({
      statusCode: 500,
      statusMessage: 'Organization source locale integrity check failed',
      data: { code: 'ORGANIZATION_SOURCE_LOCALE_INTEGRITY', organization_id: organizationId },
    })
  }
  return { ...source, is_source: Boolean(source.is_source) }
}

export async function listOrganizationLocaleRecords(
  db: DbClient,
  organizationId: string,
): Promise<OrganizationLocaleRecord[]> {
  await getPersistedSourceLocale(db, organizationId)
  const rows = await queryAll<OrganizationLocaleRow>(db, `
    SELECT id, organization_id, locale, label, is_source, status, created_at, updated_at
      FROM organization_locales
     WHERE organization_id = ? 
     ORDER BY is_source DESC, locale ASC
  `, [organizationId])
  return rows.map(row => ({ ...row, is_source: Boolean(row.is_source) }))
}


function billingUrl(organizationSlug: string | null): string | null {
  if (!organizationSlug) return null
  return `/dashboard/${encodeURIComponent(organizationSlug)}/billing/upgrade`
}

export async function assertOrganizationLanguageEntitlement(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
  localeInput: unknown,
  // Authoring needs the language to exist; the public site needs it published.
  // One question, one query, and the caller says which answer it needs.
  requires: 'plan' | 'exists' | 'published' = 'exists',
): Promise<{ locale: string; source: boolean; status: OrganizationLocaleRecord['status'] | null; platform_messages: Record<string, string> | null }> {
  const locale = assertExactCanonicalLocale(localeInput)
  const catalog = platformLocale(locale)
  if (!catalog) localizationError(403, 'PLATFORM_LOCALE_UNAVAILABLE', 'The platform locale is unavailable', { locale })
  const source = await getPersistedSourceLocale(db, organizationId)
  if (locale === source.locale) return { locale, source: true, status: source.status, platform_messages: { ...catalog.messages } }
  const row = await queryFirst<EntitlementRow & { organization_slug: string | null }>(db, `
    SELECT sl.status AS locale_status, o.slug AS organization_slug
      FROM organization o
      LEFT JOIN organization_locales sl ON sl.organization_id = o.id AND sl.locale = ?
     WHERE o.id = ?
     LIMIT 1
  `, [locale, organizationId])
  if (!row) localizationError(404, 'LOCALIZATION_NOT_FOUND', 'Organization was not found', { organization_id: organizationId })
  const entitlements = await getOrganizationEntitlements(env, organizationId)
  // Authoring only needs the language to exist on an entitled site. Requiring
  // `published` here made translate-before-publish impossible, which is why a
  // language went public with nothing in it. The public gate below is what
  // still insists on `published`.
  const satisfied = requires === 'plan' || (requires === 'published' ? row.locale_status === 'published' : Boolean(row.locale_status))
  if (entitlements.additional_languages !== true) {
    localizationError(402, 'LANGUAGE_ENTITLEMENT_REQUIRED', 'Publishing additional languages requires Growth or Business.', {
      organization_id: organizationId,
      locale,
      dashboard_url: billingUrl(row.organization_slug),
    })
  }
  if (!satisfied) {
    localizationError(409, requires === 'published' ? 'LANGUAGE_NOT_PUBLISHED' : 'LANGUAGE_NOT_ENABLED',
      requires === 'published' ? 'This website language is not published.' : 'Add this website language before authoring its translations.', {
      organization_id: organizationId,
      locale,
      dashboard_url: row.organization_slug ? `/dashboard/${encodeURIComponent(row.organization_slug)}/website/localization` : null,
    })
  }
  return { locale, source: false, status: row.locale_status, platform_messages: { ...catalog.messages } }
}

export async function assertPublicOrganizationLanguageEntitlement(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
  locale: string,
) {
  try {
    return await assertOrganizationLanguageEntitlement(env, db, organizationId, locale, 'published')
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error
      ? error.status
      : null
    const data = error && typeof error === 'object' && 'data' in error
      ? error.data
      : null
    const code = data && typeof data === 'object' && 'code' in data
      ? data.code
      : null
    if (isSubscriptionStateInvalid(error)) {
      console.error('organization_subscription_state_invalid', { organizationId, locale })
    }
    if (
      isSubscriptionStateInvalid(error)
      || status === 402
      || code === 'LANGUAGE_ENTITLEMENT_REQUIRED'
      || code === 'LANGUAGE_NOT_ENABLED'
      || code === 'LANGUAGE_NOT_PUBLISHED'
      || code === 'PLATFORM_LOCALE_UNAVAILABLE'
    ) {
      throw new HTTPError({ statusCode: 404, statusMessage: 'Localized route was not found' })
    }
    throw error
  }
}

function mapLocalization(row: ResourceLocalizationRow): ResourceLocalizationRecord {
  const parsed = JSON.parse(row.values_json) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HTTPError({ statusCode: 500, statusMessage: 'Stored resource localization is invalid', data: { code: 'INVALID_STORED_CONTENT' } })
  }
  const { values_json: _valuesJson, ...rest } = row
  return { ...rest, values: parsed as LocalizedValues }
}

/** The published, active Product a location-scoped route names, with the location that serves it. */
export async function findPublishedProductAtRoute(
  db: DbClient,
  organizationId: string,
  route: { locationSlug: string; productSlug: string },
): Promise<{ id: string; location_id: string } | null> {
  return await queryFirst<{ id: string; location_id: string }>(db, `
    SELECT p.id, l.id AS location_id FROM products p
      JOIN product_publications pub ON pub.product_id = p.id AND pub.organization_id = p.organization_id
        AND pub.published = 1
      JOIN product_locations pl ON pl.product_id = p.id AND pl.organization_id = p.organization_id
       AND pl.published = 1 AND pl.active = 1
      JOIN business_locations l ON l.id = pl.location_id AND l.organization_id = ? AND l.slug = ?
     WHERE p.organization_id = ? AND p.slug = ? AND p.active = 1 LIMIT 1
  `, [organizationId, route.locationSlug, organizationId, route.productSlug]) ?? null
}

/**
 * The location-scoped Product route this path names, or null when the path is
 * not one. The family segment follows the vertical, exactly as the English
 * route does.
 */
export function parseProductRouteSegments(path: string, vertical: string): { locationSlug: string; productSlug: string; sourcePath: string } | null {
  const segments = path.split('/').filter(Boolean)
  const family = vertical === 'restaurant' ? 'menu' : 'products'
  if (segments.length !== 4 || segments[0] !== 'locations' || segments[2] !== family) return null
  const locationSlug = segments[1]
  const productSlug = segments[3]
  if (!locationSlug || !productSlug) return null
  return { locationSlug, productSlug, sourcePath: `/locations/${locationSlug}/${family}/${productSlug}` }
}

export async function getOrganizationVertical(db: DbClient, organizationId: string): Promise<string> {
  const organization = await queryFirst<{ vertical: string }>(db, 'SELECT vertical FROM organization WHERE id = ? LIMIT 1', [organizationId])
  if (!organization) localizationError(404, 'LOCALIZATION_NOT_FOUND', 'Organization was not found', { organization_id: organizationId })
  return organization.vertical
}

/**
 * Does this site carry this resource? Every variant takes the same three
 * parameters — organization, site, resource — so the same SQL serves both the
 * existence check and the NOT EXISTS clause that clears a localization whose
 * canonical row has since gone.
 */
// Both forms take (organization_id); `one` takes the resource id as a second
// parameter. The set form exists because D1 binds at most 100 parameters per
// statement, so a batch is checked against the tenant's resources rather than
// against a placeholder list that grows with the batch.
function canonicalResourceQuery(resourceType: LocalizedResourceType, scope: 'one' | 'all'): string {
  const { table, tenantScope } = RESOURCE_LOCALIZATION_REGISTRY[resourceType]
  const one = scope === 'one'
  if (tenantScope === 'self') return `SELECT id, theme_id, vertical FROM ${table} WHERE id = ?${one ? ' AND id = ?' : ''}`
  return `SELECT id${resourceType === 'product' ? ', kind' : resourceType === 'business_location' ? ', slug' : ''} FROM ${table} WHERE organization_id = ?${one ? ' AND id = ?' : ''}`
}

async function assertCanonicalResourceExists(
  db: DbClient,
  organizationId: string,
  resourceType: LocalizedResourceType,
  resourceId: string,
): Promise<void> {
  const row = await queryFirst<{ id: string }>(db, canonicalResourceQuery(resourceType, 'one'), [organizationId, resourceId])
  if (!row) {
    localizationError(404, 'LOCALIZATION_NOT_FOUND', 'Canonical resource was not found', { resource_type: resourceType, resource_id: resourceId })
  }
}

// The existence read above happens before the write, so the resource can still
// be deleted in between. This runs inside the same batch and orphans the row
// rather than leaving it pointing at something that is gone.
function canonicalResourceGuard(
  organizationId: string,
  resourceType: LocalizedResourceType,
  resourceId: string,
): BatchQuery {
  const query = canonicalResourceQuery(resourceType, 'one')
  return {
    query: `UPDATE resource_localizations SET resource_id = NULL
      WHERE organization_id = ? AND resource_type = ? AND resource_id = ? AND NOT EXISTS (${query})`,
    params: [organizationId, resourceType, resourceId, organizationId, resourceId],
  }
}

export async function getResourceLocalization(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
  resourceTypeInput: unknown,
  resourceId: string,
  localeInput: unknown,
): Promise<ResourceLocalizationRecord> {
  const resourceType = parseLocalizedResourceType(resourceTypeInput)
  const { locale, source } = await assertOrganizationLanguageEntitlement(env, db, organizationId, localeInput)
  if (source) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'Primary-language content is not stored as a resource localization')
  const row = await queryFirst<ResourceLocalizationRow>(db, `
    SELECT id, organization_id, resource_type, resource_id, locale, values_json, route_path,
           created_at, created_by_user_id, updated_at, updated_by_user_id
      FROM resource_localizations
     WHERE organization_id = ?  AND resource_type = ? AND resource_id = ? AND locale = ?
     LIMIT 1
  `, [organizationId, resourceType, resourceId, locale])
  if (!row) localizationError(404, 'LOCALIZATION_NOT_FOUND', 'Localized representation was not found', { resource_type: resourceType, resource_id: resourceId, locale })
  return mapLocalization(row)
}

export async function getLocalizationForAuthoring(
  env: CloudflareEnv, db: DbClient, organizationId: string, resourceType: unknown, resourceId: string, localeInput: unknown,
) {
  if (resourceType !== 'content_document') return getResourceLocalization(env, db, organizationId, resourceType, resourceId, localeInput)
  const { locale, source } = await assertOrganizationLanguageEntitlement(env, db, organizationId, localeInput)
  if (source) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'Source content is edited through its document')
  const document = await getContentRepresentation(db, { rootId: resourceId, locale })
  if (!document || document.organization_id !== organizationId || document.organization_id !== organizationId) localizationError(404, 'LOCALIZATION_NOT_FOUND', 'Document representation was not found')
  const copy = await queryFirst<{ title: string | null; summary: string | null; slug: string | null; path: string | null;
    seo_keywords: string | null; metadata_json: string }>(db,
    'SELECT title, summary, slug, path, seo_keywords, metadata_json FROM content_documents WHERE id = ?', [document.id])
  if (!copy) throw new HTTPError({ statusCode: 500, statusMessage: 'Document representation disappeared during reading' })
  const { metadata_json, ...fields } = copy
  return { ...document, ...fields, metadata: JSON.parse(metadata_json) as Record<string, unknown>,
    content_blocks: (await getContentEditorSnapshotForDocument(db, document)).blocks }
}

export async function resolveLocalizedPublicRoute(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
  routePathInput: unknown,
): Promise<LocalizedPublicRoute> {
  if (typeof routePathInput !== 'string' || !routePathInput.startsWith('/') || routePathInput.includes('?') || routePathInput.includes('#')) {
    localizationError(404, 'LOCALIZATION_NOT_FOUND', 'Localized route was not found')
  }
  const routePath = routePathInput.length > 1 ? routePathInput.replace(/\/+$/, '') : routePathInput
  const firstSegment = routePath.split('/')[1]
  const locale = assertExactCanonicalLocale(firstSegment)
  const entitlement = await assertPublicOrganizationLanguageEntitlement(env, db, organizationId, locale)
  if (entitlement.source) {
    localizationError(404, 'LOCALIZATION_NOT_FOUND', 'Primary-language routes are unprefixed', { locale, route_path: routePath })
  }
  if (!entitlement.platform_messages) {
    localizationError(500, 'PLATFORM_LOCALE_UNAVAILABLE', 'Published platform locale messages are unavailable', { locale })
  }
  const { listPublicLocaleRepresentations, listPublicResourceLocaleRepresentations } = await import('~/server/utils/public-locale-representations')

  const siteProduct = parseSiteProductPath(routePath.slice(locale.length + 1))
  if (siteProduct) {
    // Site-wide experiences and homes use the same published offer as their public page.
    const { loadPublicSiteProductDetail } = await import('~/server/utils/public-products')
    const detail = await loadPublicSiteProductDetail(env, db, organizationId, siteProduct.surface, false, siteProduct.slug, locale)
    if (!detail) localizationError(404, 'LOCALIZATION_NOT_FOUND', 'Localized route was not found', { locale, route_path: routePath })
    const localization = await getResourceLocalization(env, db, organizationId, 'product', detail.product.id, locale)
    return {
      locale,
      route_path: routePath,
      platform_messages: entitlement.platform_messages,
      locale_representations: detail.localeRepresentations,
      representation: { kind: 'resource', resource_type: 'product', resource_id: detail.product.id, localization },
    }
  }

  // A Product is addressed through a location that offers it, so its localized
  // route is read the way its English route is: by its segments. Nothing is
  // stored to match against, which is what lets one Product answer at every
  // location it is offered at.
  const productRoute = parseProductRouteSegments(routePath.slice(locale.length + 1),
    await getOrganizationVertical(db, organizationId))
  if (productRoute) {
    const product = await findPublishedProductAtRoute(db, organizationId, productRoute)
    if (!product) localizationError(404, 'LOCALIZATION_NOT_FOUND', 'Localized route was not found', { locale, route_path: routePath })
    const localized = await queryFirst<ResourceLocalizationRow>(db, `
      SELECT id, organization_id, resource_type, resource_id, locale, values_json, route_path,
             created_at, created_by_user_id, updated_at, updated_by_user_id
        FROM resource_localizations
       WHERE organization_id = ?  AND locale = ? AND resource_type = 'product' AND resource_id = ?
       LIMIT 1
    `, [organizationId, locale, product.id])
    if (!localized) localizationError(404, 'LOCALIZATION_NOT_FOUND', 'Localized route was not found', { locale, route_path: routePath })
    const localization = mapLocalization(localized)
    return {
      locale,
      route_path: routePath,
      platform_messages: entitlement.platform_messages,
      locale_representations: await listPublicLocaleRepresentations(env, db, {
        organizationId,
        sourcePath: productRoute.sourcePath,
        resource: { type: 'product', id: product.id },
      }),
      representation: { kind: 'resource', resource_type: 'product', resource_id: product.id, localization },
    }
  }

  // A location's section uses its location's saved representation, just as
  // the public page loader does. The section has no separate translation row.
  const locationChild = /^\/locations\/([^/]+)\/([^/]+)$/.exec(routePath.slice(locale.length + 1))
  if (locationChild) {
    const section = PUBLIC_LOCATION_SECTIONS.find(value => value === locationChild[2])
    if (!section && locationChild[2] !== 'contact') localizationError(404, 'LOCALIZATION_NOT_FOUND', 'Localized route was not found', { locale, route_path: routePath })
    const { publicLocationSql } = await import('~/server/utils/public-locations')
    const resource = await queryFirst<ResourceLocalizationRow>(db, `
      SELECT rl.id, rl.organization_id, rl.resource_type, rl.resource_id, rl.locale, rl.values_json, rl.route_path,
             rl.created_at, rl.created_by_user_id, rl.updated_at, rl.updated_by_user_id
        FROM resource_localizations rl
        JOIN business_locations l ON l.organization_id = rl.organization_id AND l.id = rl.resource_id
       WHERE rl.organization_id = ? AND rl.locale = ? AND rl.resource_type = 'business_location'
         AND rl.route_path = ? AND ${publicLocationSql('l')} LIMIT 1
    `, [organizationId, locale, `/${locale}/locations/${locationChild[1]}`])
    if (!resource) localizationError(404, 'LOCALIZATION_NOT_FOUND', 'Localized route was not found', { locale, route_path: routePath })
    if (section) {
      const { PUBLIC_CATALOG_SECTIONS_SQL, PUBLIC_CONTENT_SECTION_QUERIES, productCatalogRows, publicContentSectionRows, publicSections } = await import('~/server/utils/public-shell-query')
      const content = publicContentSectionRows(() => [])
      let catalog: import('~/server/utils/public-shell-query').PublicCatalogRow[] = []
      if (section === 'menu' || section === 'products') {
        catalog = await queryAll(db, PUBLIC_CATALOG_SECTIONS_SQL, [organizationId])
      } else if (section === 'experiences') {
        const { listOrganizationProducts } = await import('~/server/utils/product-management')
        catalog = productCatalogRows(await listOrganizationProducts(db, { organizationId, kind: 'experience', publishedOnly: true, env }))
      } else {
        content[section] = await queryAll(db, PUBLIC_CONTENT_SECTION_QUERIES[section], [organizationId])
      }
      if (!publicSections(await getOrganizationVertical(db, organizationId), catalog, content, false).location(resource.resource_id)[section]) {
        localizationError(404, 'LOCALIZATION_NOT_FOUND', 'Localized route was not found', { locale, route_path: routePath })
      }
    }
    const localization = mapLocalization(resource)
    return {
      locale, route_path: routePath, platform_messages: entitlement.platform_messages,
      locale_representations: await listPublicResourceLocaleRepresentations(env, db, {
        organizationId, resource: { type: 'business_location', id: resource.resource_id, routeSuffix: `/${locationChild[2]}` },
      }),
      representation: { kind: 'resource', resource_type: 'business_location', resource_id: resource.resource_id, localization },
    }
  }

  const resource = await queryFirst<ResourceLocalizationRow>(db, `
    SELECT id, organization_id, resource_type, resource_id, locale, values_json, route_path,
           created_at, created_by_user_id, updated_at, updated_by_user_id
      FROM resource_localizations
     WHERE organization_id = ?  AND locale = ? AND route_path = ?
     LIMIT 1
  `, [organizationId, locale, routePath])
  if (resource) {
    const localization = mapLocalization(resource)
    await assertCanonicalResourceExists(db, organizationId, localization.resource_type, localization.resource_id)
    return {
      locale,
      route_path: routePath,
      platform_messages: entitlement.platform_messages,
      locale_representations: await listPublicResourceLocaleRepresentations(env, db, {
        organizationId,
        resource: { type: localization.resource_type, id: localization.resource_id },
      }),
      representation: {
        kind: 'resource',
        resource_type: localization.resource_type,
        resource_id: localization.resource_id,
        localization,
      },
    }
  }
  const documentPath = routePath.slice(locale.length + 1) || '/'
  const document = await queryFirst<{ id: string; root_id: string; kind: ContentDocumentKind }>(db, `
    SELECT d.id, d.root_id, d.kind FROM content_documents d JOIN content_documents root ON root.id = d.root_id
     WHERE d.organization_id = ?  AND d.locale = ? AND d.path = ?
       AND d.row_role = 'representation' AND root.row_role = 'root'
       AND (root.kind NOT IN ('article','social_post') OR root.status = 'published') LIMIT 1
  `, [organizationId, locale, documentPath])
  if (!document) localizationError(404, 'LOCALIZATION_NOT_FOUND', 'Localized route was not found', { locale, route_path: routePath })
  const { resolvePublicDocumentSourcePath } = await import('~/server/utils/public-locale-representations')
  return { locale, route_path: routePath, platform_messages: entitlement.platform_messages,
    locale_representations: await listPublicLocaleRepresentations(env, db, { organizationId,
      sourcePath: await resolvePublicDocumentSourcePath(db, organizationId, document.root_id), documentId: document.root_id }),
    representation: { kind: 'document', document_kind: document.kind, resource_type: 'content_document',
      resource_id: document.root_id, document_id: document.id },
  }
}

interface PriorLocalization {
  id: string
  route_path?: string | null
  created_at: string
  created_by_user_id: string
}

/**
 * The statements that write one localized representation at its saved route.
 *
 * One resource and a batch of them differ only in how many of these they
 * accumulate, so they share this rather than each holding a copy of the SQL.
 */
function resourceLocalizationWriteQueries(input: {
  organizationId: string
  resourceType: LocalizedResourceType
  resourceId: string
  locale: string
  values: LocalizedValues
  routePath: string | null
  userId: string
  id: string
  prior?: PriorLocalization | null
  now: string
}): BatchQuery[] {
  const statements: BatchQuery[] = []
  statements.push({
    query: `INSERT INTO resource_localizations
      (id, organization_id, resource_type, resource_id, locale, values_json, route_path,
       created_at, created_by_user_id, updated_at, updated_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(organization_id, resource_type, resource_id, locale) DO UPDATE SET
        values_json = excluded.values_json, route_path = excluded.route_path,
        updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id`,
    params: [input.id, input.organizationId, input.resourceType, input.resourceId, input.locale,
      JSON.stringify(input.values), input.routePath,
      input.prior?.created_at ?? input.now, input.prior?.created_by_user_id ?? input.userId, input.now, input.userId],
  })
  statements.push(canonicalResourceGuard(input.organizationId, input.resourceType, input.resourceId))
  if (input.resourceType === 'product' && isRecord(input.values.details)) {
    const alarmDetails = STAY_ALARM_AMENITIES.filter(code => Object.hasOwn(input.values.details as object, STAY_ALARM_DETAIL_KEYS[code])).map(code => ({ code, key: STAY_ALARM_DETAIL_KEYS[code] }))
    if (alarmDetails.length) statements.push({
      query: `UPDATE resource_localizations AS localized SET values_json = NULL
        WHERE organization_id = ? AND resource_type = 'product' AND resource_id = ? AND locale = ? AND EXISTS (
          SELECT 1 FROM json_each(?) alarm WHERE NOT EXISTS (
            SELECT 1 FROM products p JOIN product_stay_configs c ON c.organization_id = p.organization_id AND c.product_id = p.id, json_each(c.amenities) answer
            WHERE p.organization_id = localized.organization_id AND p.id = localized.resource_id
              AND answer.value ->> '$.code' = alarm.value ->> '$.code' AND answer.value ->> '$.available' = 1
              AND json_type(p.details_json, '$.' || (alarm.value ->> '$.key')) = 'text'))`,
      params: [input.organizationId, input.resourceId, input.locale, JSON.stringify(alarmDetails)],
    })
  }
  return statements
}

export async function putResourceLocalization(
  env: CloudflareEnv,
  db: DbClient,
  input: {
    organizationId: string
    resourceType: unknown
    resourceId: string
    locale: unknown
    values: unknown
    routePath?: unknown
    userId: string
  },
): Promise<ResourceLocalizationRecord> {
  const resourceType = parseLocalizedResourceType(input.resourceType)
  const { locale, source, status } = await assertOrganizationLanguageEntitlement(env, db, input.organizationId, input.locale)
  if (source) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'English source content must be edited through its canonical resource')
  const canonical = await queryFirst<{ id: string; kind?: string; slug?: string; theme_id?: string; vertical?: string }>(db, canonicalResourceQuery(resourceType, 'one'), [input.organizationId, input.resourceId])
  if (!canonical) localizationError(404, 'LOCALIZATION_NOT_FOUND', 'Canonical resource was not found', { resource_type: resourceType, resource_id: input.resourceId })
  const values = validateLocalizedValues(resourceType, input.values, resourceType === 'product' ? assertProductKind(canonical.kind) : undefined,
    status === 'published' && resourceType === 'organization' ? { publishedLegalPractice: isLegalPracticeSite({ themeId: canonical.theme_id, vertical: canonical.vertical }) } : undefined)
  if (resourceType === 'product' && canonical.kind === 'stay' && isRecord(values.details) && STAY_ALARM_AMENITIES.some(code => Object.hasOwn(values.details as object, STAY_ALARM_DETAIL_KEYS[code]))) {
    const source = await queryFirst<{ amenities: string; details_json: string }>(db, 'SELECT c.amenities, p.details_json FROM products p JOIN product_stay_configs c ON c.organization_id = p.organization_id AND c.product_id = p.id WHERE p.organization_id = ? AND p.id = ?', [input.organizationId, input.resourceId])
    if (!source) localizationError(409, 'LOCALIZATION_VALIDATION_FAILED', 'The source home is no longer available', { field: 'details' })
    try { validateStayAlarmDetails(values.details, parseStayAmenityAnswers(JSON.parse(source.amenities))) }
    catch (error) { if (!(error instanceof ProductDetailError)) throw error; localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', error.message, { field: 'details' }) }
    const sourceDetails = validateProductDetails('stay', JSON.parse(source.details_json))
    for (const code of STAY_ALARM_AMENITIES) if (Object.hasOwn(values.details, STAY_ALARM_DETAIL_KEYS[code]) && typeof sourceDetails[STAY_ALARM_DETAIL_KEYS[code]] !== 'string') localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', `Write source details.${STAY_ALARM_DETAIL_KEYS[code]} before translating it`, { field: `details.${STAY_ALARM_DETAIL_KEYS[code]}` })
  }
  const existing = await queryFirst<{ id: string; route_path: string | null; created_at: string; created_by_user_id: string }>(db, `
    SELECT id, route_path, created_at, created_by_user_id
      FROM resource_localizations
     WHERE organization_id = ?  AND resource_type = ? AND resource_id = ? AND locale = ?
     LIMIT 1
  `, [input.organizationId, resourceType, input.resourceId, locale])
  const routePath = validateLocalizedRoutePath(resourceType, locale, input.routePath, canonical.slug, existing?.route_path)
  const id = existing?.id ?? crypto.randomUUID()
  const now = new Date().toISOString()
  const statements: BatchQuery[] = resourceLocalizationWriteQueries({
    organizationId: input.organizationId, resourceType, resourceId: input.resourceId,
    locale, values, routePath, userId: input.userId, id, prior: existing, now,
  })
  statements.push(publicResourceCacheInvalidationQuery(input.organizationId, 'resource-localization-put'))
  try {
    await executeBatch(db, statements, { operation: 'replace resource localization' })
  } catch (error) {
    if (error instanceof Error && /NOT NULL constraint failed: resource_localizations\.values_json/.test(error.message)) localizationError(409, 'LOCALIZATION_VALIDATION_FAILED', 'The source alarm details changed while translating; read the home again before saving', { field: 'details' })
    if (error instanceof Error && /resource_localizations_organization_locale_route_unique|UNIQUE constraint failed: resource_localizations\.organization_id/.test(error.message)) {
      localizationError(409, 'LOCALIZED_ROUTE_CONFLICT', 'Localized route path is already owned by another resource', { route_path: routePath })
    }
    throw error
  }
  return await getResourceLocalization(env, db, input.organizationId, resourceType, input.resourceId, locale)
}

function remapNewLocalizedBlockIds(blocks: ContentBlockInput[]): ContentBlockInput[] {
  const ids = new Map<string, string>()
  for (const block of blocks) {
    if (block.id) ids.set(block.id, crypto.randomUUID())
  }
  return blocks.map(block => ({
    ...block,
    id: block.id ? ids.get(block.id) : crypto.randomUUID(),
    parent_block_id: block.parent_block_id ? ids.get(block.parent_block_id) ?? null : null,
  }))
}

const DOCUMENT_LOCALIZED_METADATA: Record<ContentDocumentKind, readonly string[]> = {
  page: [], article: [],
  social_post: ['call_to_action'], qa: [],
}

export async function putLocalizationForAuthoring(env: CloudflareEnv, db: D1Database,
  input: Parameters<typeof putResourceLocalization>[2] & { contentBlocks?: unknown; expectedUpdatedAt?: unknown },
) {
  if (input.resourceType !== 'content_document') return putResourceLocalization(env, db, input)
  const { locale, source } = await assertOrganizationLanguageEntitlement(env, db, input.organizationId, input.locale)
  if (source) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'Source content is edited through its document')
  const root = await getContentDocumentById(db, input.resourceId)
  if (!root || root.row_role !== 'root' || root.organization_id !== input.organizationId || root.organization_id !== input.organizationId) localizationError(404, 'LOCALIZATION_NOT_FOUND', 'Source document was not found')
  if (root.kind === 'qa') {
    const authored = await queryFirst(db, "SELECT id FROM content_documents WHERE id = ? AND organization_id = ? AND row_role = 'root' AND source = 'manual'", [root.id, input.organizationId])
    if (!authored) localizationError(403, 'LOCALIZATION_READ_ONLY', 'Only authored Q&A can be translated')
    if (input.routePath != null || (Array.isArray(input.contentBlocks) && input.contentBlocks.length)) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'Q&A translations contain a question and answer, without a route or content blocks')
  }
  if (!input.values || typeof input.values !== 'object' || Array.isArray(input.values)) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'values must be an object')
  const copy = input.values as Record<string, unknown>
  const textFields = root.kind === 'qa' ? ['title', 'summary'] as const : ['title', 'summary', 'seo_keywords'] as const
  if (Object.keys(copy).some(key => key !== 'metadata' && !(root.kind !== 'qa' && key === 'slug') && !textFields.some(field => field === key))) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'Unknown translated document field')
  // A key a translation leaves out is removed, not stored as JSON null: a
  // social post's translation carries a call to action label or none.
  const clearedMetadata = DOCUMENT_LOCALIZED_METADATA[root.kind]
  const changes: ContentDocumentChanges = { updated_by: input.userId }
  for (const field of textFields) {
    if (copy[field] == null) { changes[field] = null; continue }
    if (typeof copy[field] !== 'string') localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', field + ' must be a string')
    changes[field] = copy[field]
  }
  if (root.kind === 'qa' && !changes.title?.trim()) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'Translated question is required')
  if (copy.metadata !== undefined) {
    if (!copy.metadata || typeof copy.metadata !== 'object' || Array.isArray(copy.metadata)) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'metadata must be an object')
    const metadata = copy.metadata as Record<string, unknown>
    for (const [key, value] of Object.entries(metadata)) {
      if (!DOCUMENT_LOCALIZED_METADATA[root.kind].includes(key)) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'Unknown translated metadata field: ' + key)
      if (key === 'call_to_action') {
        // A translation says the button's words; where it goes is the post's.
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(field => field !== 'label') || typeof (value as Record<string, unknown>).label !== 'string' || !((value as Record<string, unknown>).label as string).trim()) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'call_to_action carries only a label')
      } else if (typeof value !== 'string') localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', key + ' must be a string')
    }
    changes.metadata = metadata
  }
  const provided = new Set(Object.keys(changes.metadata ?? {}))
  const removeMetadata = clearedMetadata.filter(key => !provided.has(key))
  const existing = await queryFirst<{ id: string; path: string | null; slug: string | null }>(db,
    "SELECT id, path, slug FROM content_documents WHERE organization_id = ? AND root_id = ? AND row_role = 'representation' AND locale = ?",
    [input.organizationId, root.id, locale])
  if (root.kind !== 'qa') {
    const { resolvePublicDocumentSourcePath } = await import('~/server/utils/public-locale-representations')
    const path = existing ? existing.path : await resolvePublicDocumentSourcePath(db, input.organizationId, root.id)
    if (!path) throw new HTTPError({ statusCode: 500, statusMessage: 'Document representation route is missing' })
    const routePath = path === '/' ? `/${locale}` : `/${locale}${path}`
    const slug = existing ? existing.slug : root.kind === 'page' ? null : path.split('/').at(-1)!
    if (input.routePath !== undefined && input.routePath !== routePath) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'A translation keeps its canonical path')
    if (copy.slug !== undefined && copy.slug !== slug) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'A translation keeps its canonical slug')
    if (!existing) {
      changes.path = path
      changes.slug = slug
      if (root.kind === 'page') {
        const [{ assertTenantPagePathAvailable }, { loadOrganizationTemplate }] = await Promise.all([
          import('~/server/utils/content/pages'), import('~/server/utils/content/publishing'),
        ])
        const { template } = await loadOrganizationTemplate(db, input.organizationId)
        await assertTenantPagePathAvailable(db, { organizationId: input.organizationId, locale, path, template })
      }
    }
  }
  const blocks = input.contentBlocks
  if (blocks !== undefined && !Array.isArray(blocks)) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'content_blocks must be an array')
  if ((root.kind === 'article' || root.kind === 'page') && !existing && (!Array.isArray(blocks) || !blocks.length)) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'Translated content blocks are required')
  const requested = blocks === undefined ? undefined : existing ? blocks as ContentBlockInput[] : remapNewLocalizedBlockIds(blocks as ContentBlockInput[])
  const { prepareTenantBlogContentBlocks } = await import('~/server/utils/content/publishing')
  const prepared = requested ? await prepareTenantBlogContentBlocks(db, requested, input.organizationId, new Date().toISOString()) : null
  const after = [...(prepared?.placementQueries ?? []), publicResourceCacheInvalidationQuery(input.organizationId, 'document-localization-put')]
  const removal = (documentId: string): BatchQuery[] => removeMetadata.length
    ? [{ query: `UPDATE content_documents SET metadata_json = json_remove(metadata_json, ${removeMetadata.map(() => '?').join(', ')}) WHERE id = ?`,
        params: [...removeMetadata.map(key => '$.' + JSON.stringify(key)), documentId] }]
    : []
  if (existing) {
    if (typeof input.expectedUpdatedAt !== 'string') localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'expected_updated_at is required')
    await updateContentDocument(db, existing.id, { expected_updated_at: input.expectedUpdatedAt, changes,
      blocks: prepared?.blocks, additionalQueriesAfter: [...removal(existing.id), ...after] })
  } else {
    await createContentDocumentWithBlocks(db, { organizationId: input.organizationId,
      kind: root.kind, rowRole: 'representation', rootId: root.id, locale,
      title: changes.title, summary: changes.summary, slug: changes.slug, path: changes.path,
      seoKeywords: changes.seo_keywords,
      metadata: changes.metadata, createdBy: input.userId, updatedBy: input.userId,
    }, prepared?.blocks ?? [], { additionalQueriesAfter: after })
  }
  return getLocalizationForAuthoring(env, db, input.organizationId, 'content_document', root.id, locale)
}

export function resourceLocalizationDeletionQueries(resourceType: LocalizedResourceType, resourceIds: BatchQuery, locale?: string): BatchQuery[] {
  const owners = `SELECT id FROM resource_localizations WHERE resource_type = ? AND resource_id IN (${resourceIds.query})${locale === undefined ? '' : ' AND locale = ?'}`
  const params = [resourceType, ...(resourceIds.params ?? []), ...(locale === undefined ? [] : [locale])]
  return [
    { query: `DELETE FROM organization_redirects WHERE owner_type = 'resource_localization' AND owner_id IN (${owners})`, params },
    { query: `DELETE FROM resource_localizations WHERE id IN (${owners})`, params },
  ]
}

export async function deleteLocalization(
  env: CloudflareEnv,
  db: DbClient,
  input: { organizationId: string; resourceType: unknown; resourceId: string; locale: unknown },
): Promise<{ deleted: true; resource_type: LocalizedResourceType | 'content_document'; resource_id: string; locale: string }> {
  if (input.resourceType === 'content_document') {
    const { locale, source } = await assertOrganizationLanguageEntitlement(env, db, input.organizationId, input.locale)
    if (source) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'English source content cannot be deleted through localization')
    const document = await getContentRepresentation(db, { rootId: input.resourceId, locale })
    if (!document || document.organization_id !== input.organizationId) localizationError(404, 'LOCALIZATION_NOT_FOUND', 'Document representation was not found')
    if (document.kind === 'qa') {
      const authored = await queryFirst(db, "SELECT id FROM content_documents WHERE id = ? AND organization_id = ? AND row_role = 'root' AND source = 'manual'", [input.resourceId, input.organizationId])
      if (!authored) localizationError(403, 'LOCALIZATION_READ_ONLY', 'Only authored Q&A translations can be deleted')
    }
    await executeBatch(db, [...prepareContentDocumentDeletion({ documentId: document.id, organizationId: input.organizationId }), publicResourceCacheInvalidationQuery(input.organizationId, 'document-localization-delete')])
    return { deleted: true, resource_type: 'content_document', resource_id: input.resourceId, locale }
  }
  const resourceType = parseLocalizedResourceType(input.resourceType)
  const { locale, source, status } = await assertOrganizationLanguageEntitlement(env, db, input.organizationId, input.locale)
  if (source) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'English source content cannot be deleted through localization')
  const row = await queryFirst<{ id: string }>(db, `
    SELECT id FROM resource_localizations
     WHERE organization_id = ?  AND resource_type = ? AND resource_id = ? AND locale = ? LIMIT 1
  `, [input.organizationId, resourceType, input.resourceId, locale])
  if (!row) localizationError(404, 'LOCALIZATION_NOT_FOUND', 'Localized representation was not found', { resource_type: resourceType, resource_id: input.resourceId, locale })
  if (status === 'published' && resourceType === 'organization') {
    const canonical = await queryFirst<{ theme_id: string; vertical: string }>(db, canonicalResourceQuery(resourceType, 'one'), [input.organizationId, input.resourceId])
    if (!canonical) localizationError(404, 'LOCALIZATION_NOT_FOUND', 'Canonical organization was not found', { organization_id: input.organizationId })
    if (isLegalPracticeSite({ themeId: canonical.theme_id, vertical: canonical.vertical })) {
      localizationError(409, 'LOCALIZATION_VALIDATION_FAILED', 'Disable the language before deleting its organization translation', { locale })
    }
  }
  const statements = resourceLocalizationDeletionQueries(resourceType, {
    query: 'SELECT resource_id FROM resource_localizations WHERE id = ?', params: [row.id],
  }, locale)
  statements.push(publicResourceCacheInvalidationQuery(input.organizationId, 'resource-localization-delete'))
  await executeBatch(db, statements, { operation: 'delete resource localization' })
  return { deleted: true, resource_type: resourceType, resource_id: input.resourceId, locale }
}

export function projectExactLocalizedValues<T extends Record<string, unknown>>(
  canonical: T,
  localization: ResourceLocalizationRecord,
): T {
  return { ...canonical, ...localization.values, locale: localization.locale, route_path: localization.route_path }
}

export async function getProductCatalogLocalization(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
  localeInput: unknown,
) {
  const { locale, source } = await assertOrganizationLanguageEntitlement(env, db, organizationId, localeInput)
  if (source) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'Product catalog localization requires a secondary locale')
  const [rows, collectionRows] = await Promise.all([queryAll<{
    id: string
    kind: string
    name: string
    description: string
    marketing_features: string
    unit_label: string | null
    details_json: string
    localization_id: string | null
    values_json: string | null
    route_path: string | null
  }>(db, `
    SELECT p.id, p.kind, p.name, p.description, p.marketing_features, p.unit_label, p.details_json,
           rl.id AS localization_id, rl.values_json, rl.route_path
      FROM products p
      LEFT JOIN resource_localizations rl
        ON rl.organization_id = p.organization_id
       AND rl.resource_type = 'product' AND rl.resource_id = p.id AND rl.locale = ?
     WHERE p.organization_id = ?
     ORDER BY p.name, p.id
  `, [ locale, organizationId]), queryAll<{
    id: string
    location_id: string | null
    name: string
    description: string | null
    localization_id: string | null
    values_json: string | null
  }>(db, `
    SELECT c.id, c.location_id, c.name, c.description, rl.id AS localization_id, rl.values_json
      FROM collections c
      LEFT JOIN resource_localizations rl
        ON rl.organization_id = c.organization_id AND rl.organization_id = c.organization_id
       AND rl.resource_type = 'collection' AND rl.resource_id = c.id AND rl.locale = ?
     WHERE c.organization_id = ? 
     ORDER BY c.sort_order, c.id
  `, [locale, organizationId])])
  return {
    locale,
    collections: collectionRows.map(row => ({
      id: row.id,
      location_id: row.location_id,
      source: { name: row.name, description: row.description },
      localization: row.localization_id ? { values: JSON.parse(row.values_json!) } : null,
    })),
    products: rows.map(row => ({
      id: row.id,
      kind: assertProductKind(row.kind),
      source: { name: row.name, description: row.description, marketing_features: JSON.parse(row.marketing_features) as string[], unit_label: row.unit_label,
        details: validateProductDetails(assertProductKind(row.kind), JSON.parse(row.details_json)) },
      localization: row.localization_id
        ? { values: JSON.parse(row.values_json!), route_path: row.route_path }
        : null,
    })),
  }
}

export async function replaceResourceLocalizations(
  env: CloudflareEnv,
  db: DbClient,
  input: {
    organizationId: string
    resourceType: unknown
    locale: unknown
    items: unknown
    userId: string
  },
) {
  const resourceType = parseLocalizedResourceType(input.resourceType)
  const { locale, source, status } = await assertOrganizationLanguageEntitlement(env, db, input.organizationId, input.locale)
  if (source) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'Localization requires a secondary locale')
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 250) {
    localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'items must contain 1 to 250 localizations')
  }
  const canonical = await queryAll<{ id: string; kind?: ProductKind; slug?: string; theme_id?: string; vertical?: string }>(db, canonicalResourceQuery(resourceType, 'all'), [input.organizationId])
  const canonicalById = new Map(canonical.map(row => [row.id, row]))
  const parsed = input.items.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', `items[${index}] must be an object`, { index })
    }
    const item = value as Record<string, unknown>
    const unknown = Object.keys(item).filter(key => !['resource_id', 'values', 'route_path'].includes(key))
    if (unknown.length || typeof item.resource_id !== 'string' || !item.resource_id.trim()) {
      localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', `items[${index}] is invalid`, { index, fields: unknown })
    }
    return {
      resourceId: item.resource_id.trim(),
      values: item.values,
      routePath: item.route_path,
    }
  })
  const ids = parsed.map(item => item.resourceId)
  if (new Set(ids).size !== ids.length) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'Resource IDs must be unique')
  const missing = ids.filter(id => !canonicalById.has(id))
  if (missing.length) localizationError(404, 'LOCALIZATION_NOT_FOUND', 'One or more canonical resources were not found', { resource_type: resourceType, resource_ids: missing })
  const existing = await queryAll<PriorLocalization & { resource_id: string }>(db, `
    SELECT id, resource_id, route_path, created_at, created_by_user_id
      FROM resource_localizations
     WHERE organization_id = ?  AND resource_type = ? AND locale = ?
  `, [input.organizationId, resourceType, locale])
  const byResource = new Map(existing.map(row => [row.resource_id, row]))
  const validated = parsed.map((item) => {
    const resource = canonicalById.get(item.resourceId)!
    return {
      resourceId: item.resourceId,
      values: validateLocalizedValues(resourceType, item.values, resource.kind,
        status === 'published' && resourceType === 'organization' ? { publishedLegalPractice: isLegalPracticeSite({ themeId: resource.theme_id, vertical: resource.vertical }) } : undefined),
      routePath: validateLocalizedRoutePath(resourceType, locale, item.routePath, resource.slug, byResource.get(item.resourceId)?.route_path),
    }
  })
  const now = new Date().toISOString()
  const statements: BatchQuery[] = []
  for (const item of validated) {
    const prior = byResource.get(item.resourceId)
    statements.push(...resourceLocalizationWriteQueries({
      organizationId: input.organizationId, resourceType, resourceId: item.resourceId,
      locale, values: item.values, routePath: item.routePath, userId: input.userId,
      id: prior?.id ?? crypto.randomUUID(), prior, now,
    }))
  }
  statements.push(publicResourceCacheInvalidationQuery(input.organizationId, 'resource-localizations-replace'))
  try {
    await executeBatch(db, statements, { operation: 'replace resource localizations' })
  } catch (error) {
    if (error instanceof Error && /NOT NULL constraint failed: resource_localizations\.values_json/.test(error.message)) localizationError(409, 'LOCALIZATION_VALIDATION_FAILED', 'The source alarm details changed while translating; read the home again before saving', { field: 'details' })
    if (error instanceof Error && /resource_localizations_organization_locale_route_unique|UNIQUE constraint failed: resource_localizations\.organization_id/.test(error.message)) {
      localizationError(409, 'LOCALIZED_ROUTE_CONFLICT', 'A localized route path is already owned by another resource')
    }
    throw error
  }
  return { locale, resource_type: resourceType, updated_resource_ids: ids }
}
