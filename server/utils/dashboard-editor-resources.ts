import type { CloudflareEnv } from '~/server/utils/auth'
import { roleMatchesSql, rolesAllowing } from '~/utils/organization-access'
import { prepareDashboardOffering } from '~/server/utils/dashboard-offering'
import { publishedHostProfilesQuery } from '~/server/utils/public-provider'
import { mcpPageWindow } from '~/server/utils/mcp-pagination'
import { HTTPError } from 'nitro';

import type { H3Event } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { qaEditQuery, updateQa } from '~/server/utils/location-qa'
import { jsonResponse } from '~/server/utils/api-response'
import { executeBatch, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { requireOrganizationAccess, type OrganizationAccessRow } from '~/server/utils/location-access'
import {
  BATCH_VIEWER,
  assignedOfferingCondition,
  assertRoleAllows,
  withViewer,
  type ResolvedMembership,
  resourceLocationScopeSql,
  assertLocationAccess,
  assertResourceAccess,
  memberAccessPrincipal,
  isOrganizationWideRole,
  roleAllows,
} from '~/server/utils/member-access'
import { getMediaAsset, listMediaAssets } from '~/server/utils/media-asset-manager'
import { getDashboardLocationContext } from '~/server/utils/dashboard-context'
import { loadPublicSocialMedia, preparePublicSocialMedia } from '~/server/utils/public-social-image'
import { parseLocationPayload } from '~/server/utils/location-payload'
import type { Product } from '~/server/types/products'
import { hydrateProductMedia, prepareOrganizationProduct, prepareProductPublicPresentation, summarizeLocationProducts } from '~/server/utils/product-management'
import { readWebsiteMember, requireWebsiteAccess } from '~/server/utils/tenant-pages-api'
import { prepareBlogList } from '~/server/utils/content/publishing'
import { isArticleCollection } from '~/utils/article-collections'
import { createPreviewToken, PREVIEW_TOKEN_QUERY, PREVIEW_TOKEN_TTL_MS } from '~/server/utils/preview-token'
import { catalogLabel, catalogSummary, presentationForProduct } from '~/utils/product-presentation'
import { tenantOrganizationOrigin } from '~/utils/tenant-organization-origin'
import { resolveOrganizationCmsCapabilities } from '~/server/utils/cms-capabilities'

import { catalogPath, locationEditorPath } from '~/server/utils/dashboard-links'
import { formatPostalAddress } from '~/utils/postal-address'
import { formatPhone } from '~/utils/phone'
import { getTodayHoursLabel } from '~/shared/reservation-hours'
import type { CatalogRow } from '~/shared/catalog-screen'

async function editorPreviewToken(secret: unknown, organizationId: string) {
  if (typeof secret !== 'string' || !secret) {
    throw new HTTPError({ statusCode: 500, statusMessage: 'PREVIEW_SECRET is required for editor previews' })
  }
  return await createPreviewToken(secret, organizationId, Date.now() + PREVIEW_TOKEN_TTL_MS)
}

export async function saveDashboardQa(event: H3Event) {
  const organizationId = getRouterParam(event, 'organization_id')
  const qaId = getRouterParam(event, 'qa_id')
  const locationId = getRouterParam(event, 'location_id') ?? null
  if (!organizationId || !qaId) throw new HTTPError({ statusCode: 400, message: 'Missing params' })
  const raw = await readBody<Record<string, unknown>>(event)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HTTPError({ statusCode: 400, message: 'Invalid request body' })
  const { page_path: pagePath = null, ...changes } = raw
  if (locationId && pagePath !== null) throw new HTTPError({ statusCode: 400, message: 'Pass location_id or page_path, not both' })
  if (pagePath !== null && typeof pagePath !== 'string') throw new HTTPError({ statusCode: 400, message: 'page_path must be a string or null' })
  const snapshot = qaEditQuery({ sql: BATCH_VIEWER.organization }, qaId, locationId, pagePath)
  snapshot.query += ` AND ${resourceLocationScopeSql(BATCH_VIEWER, 'content_documents')}`
  const { db, organization, session, rows } = await readWebsiteMember(event, organizationId, [snapshot])
  const current = rows[0]!.results[0] as Parameters<typeof updateQa>[5] | undefined
  if (!current) throw new HTTPError({ statusCode: 404, message: 'Q&A not found' })
  return jsonResponse(await updateQa(db, { organizationId: organization.id, locationId, pagePath }, qaId, changes, session.user, current))
}

export interface DashboardMediaFilters {
  id?: string
  kind?: string
  ownerType?: string
  ownerId?: string
  slot?: string
  search?: string
  limit?: number
  offset?: number
}

export async function loadDashboardMedia(
  event: H3Event,
  organizationId: string,
  filters: DashboardMediaFilters = {},
) {
  const { env, db, organization } = await requireOrganizationAccess(event, organizationId)
  const principal = memberAccessPrincipal(organization.membership, { env, event })
  if (filters.id) {
    const asset = await getMediaAsset(db, filters.id, organizationId)
    if (asset) {
      await assertResourceAccess(db, {
        ...principal,
        resourceLocationId: null,
      })
    }
    return { media: asset ? [asset] : [] }
  }

  await assertResourceAccess(db, {
    ...principal,
    resourceLocationId: null,
  })
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100)
  const offset = Math.max(filters.offset ?? 0, 0)
  return {
    media: await listMediaAssets(db, organizationId, {
      kind: filters.kind,
      ownerType: filters.ownerType,
      ownerId: filters.ownerId,
      slot: filters.slot,
      search: filters.search,
      limit,
      offset,
    }),
  }
}

export interface LocationContentCounts {
  photos: number
  posts: number
  qa: number
  reviews: number
  /** The site's own questions, which this location's page also answers from. */
  organization_qa: number
}

/**
 * What each row on the location hub reports about itself.
 *
 * One statement rather than five round trips, because the hub renders every
 * count at once and a row with no number is a row nobody can act on without
 * opening it first.
 */
async function loadLocationContentCounts(
  db: DbClient,
  organizationId: string,
  locationId: string,
): Promise<LocationContentCounts> {
  // Positional placeholders repeated per subquery: D1 binds each `?` in order
  // and does not honour numbered `?1` parameters, which silently returned zero
  // for every count after the first.
  const row = await queryFirst<Record<string, number>>(db, `
    SELECT
      -- Joined to the asset: a placement can stay active while its asset is
      -- retired, and every other media read here requires an active asset. The
      -- count has to mean photos a guest could actually see.
      (SELECT COUNT(*) FROM media_placements mp
        JOIN media_assets ma ON ma.id = mp.asset_id
         AND ma.organization_id = mp.organization_id AND ma.organization_id = mp.organization_id
         AND ma.status = 'active'
        WHERE mp.organization_id = ? AND mp.owner_type = 'business_location' AND mp.owner_id = ?
          AND mp.slot IN ('hero', 'gallery') AND mp.status = 'active') AS photos,
      (SELECT COUNT(*) FROM content_documents WHERE kind = 'social_post' AND row_role = 'root' AND organization_id = ? AND location_id = ? AND status = 'published') AS posts,
      (SELECT COUNT(*) FROM content_documents WHERE kind = 'qa' AND row_role = 'root' AND organization_id = ? AND location_id = ?) AS qa,
      (SELECT COUNT(*) FROM reviews WHERE organization_id = ? AND location_id = ?) AS reviews,
      (SELECT COUNT(*) FROM content_documents WHERE kind = 'qa' AND row_role = 'root' AND organization_id = ? AND location_id IS NULL) AS organization_qa
  `, [...Array.from({ length: 4 }, () => [organizationId, locationId]).flat(), organizationId])
  return {
    photos: row?.photos ?? 0,
    posts: row?.posts ?? 0,
    qa: row?.qa ?? 0,
    reviews: row?.reviews ?? 0,
    organization_qa: row?.organization_qa ?? 0,
  }
}

export async function loadDashboardLocationOverview(
  event: H3Event,
  organizationId: string,
  locationId: string,
) {
  const { env, db, organization, location } = await getDashboardLocationContext(event, locationId)
  if (location.organization_id !== organizationId) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Location not found' })
  }
  const principal = memberAccessPrincipal(organization, { env, event })
  await assertLocationAccess(db, { ...principal, locationId })
  const [catalog, counts] = await Promise.all([
    summarizeLocationProducts(db, { organizationId: organization.id, locationId }),
    loadLocationContentCounts(db, organizationId, locationId),
  ])
  const loc = parseLocationPayload(location)!
  if (!organization.vertical || !organization.theme_id) throw new HTTPError({ statusCode: 500, message: 'Location website configuration is missing' })
  const { capabilities } = resolveOrganizationCmsCapabilities(organization.vertical, organization.theme_id, null)
  const features = new Set([...capabilities.pages.map(page => page.feature), ...capabilities.managers.map(manager => manager.id)])
  const hasCatalog = features.has('products') || features.has('services')
  const place = locationEditorPath(organization.slug, loc.slug)
  const website = `/dashboard/${encodeURIComponent(organization.slug)}/website`
  const scope = { location_id: locationId }
  const search = new URLSearchParams(scope).toString()
  const row = (id: string, label: string, summary: string, extras: Partial<CatalogRow> = {}): CatalogRow =>
    ({ id, label, summary, to: `${place}/${id}`, native: `business-location-${id}`, query: scope, ...extras })
  const count = (total: number, noun: string, empty: string) => total ? `${total} ${noun}${total === 1 ? '' : 's'}` : empty
  const contact = [loc.phone && formatPhone(loc.phone), loc.email].filter(value => value?.trim()).join(' · ')
  const trust = [
    count(counts.qa, 'question', ''), count(counts.reviews, 'review', ''),
    counts.organization_qa ? `${counts.organization_qa} organization-wide` : '',
  ].filter(Boolean).join(' · ')
  const picture = features.has('photos') ? (await loadPublicSocialMedia(db, organization.id, 'business_location', [locationId])).get(locationId)?.social_image : null
  const rows = [
    ...(features.has('photos') ? [row('photos', 'Media', count(counts.photos, 'item', 'Add media'), { image: picture?.url })] : []),
    row('name', 'Name', loc.title),
    row('description', 'Description', loc.short_description?.trim() || loc.description?.trim() || 'Describe this location'),
    row('hours', 'Hours', getTodayHoursLabel(loc.opening_hours, 'Closed today', loc.timezone, new Date(), loc.special_hours) || 'Set your hours', { icon: 'i-lucide-clock' }),
    row('address', 'Address', formatPostalAddress(loc.address) || 'Add the address', { icon: 'i-lucide-map-pin' }),
    row('contact', 'Contact', contact || 'Add a phone or email', { icon: 'i-lucide-contact-round' }),
    ...(hasCatalog ? [row('products', catalogLabel(organization.vertical, catalog), catalogSummary(organization.vertical, catalog), { icon: 'i-lucide-store', to: catalogPath(organization.slug, locationId), native: 'scoped-catalog' })] : []),
    ...(features.has('posts') ? [row('posts', 'Posts', count(counts.posts, 'published post', 'Write your first post'), { icon: 'i-lucide-megaphone', to: `${website}/posts?${search}`, native: 'website-posts' })] : []),
    ...(features.has('qa') ? [row('qa', 'Reviews and Q&A', trust || 'Answer your first question', { icon: 'i-lucide-message-circle-question', to: `${website}/qa?${search}`, native: 'website-qa' })] : []),
  ]
  return {
    location: { success: true as const, location: loc },
    catalog,
    counts,
    rows,
    settings: row('settings', capabilities.locationVocabulary === 'office/service area' ? 'Office settings' : 'Location settings', loc.status === 'active' ? 'Published' : 'Draft', { native: 'business-location-status' }),
  }
}

export async function loadDashboardBlogPosts(
  event: H3Event,
  organizationId: string,
  input: { status?: string | null; collection?: string | null; limit?: number; cursor?: string },
) {
  const { db } = await requireWebsiteAccess(event, organizationId)
  const collection = input.collection ?? null
  if (collection !== null && !isArticleCollection(collection)) throw new HTTPError({ statusCode: 400, statusMessage: 'collection must be blog or docs' })
  const resource = { resource: `blog-posts:${organizationId}:${input.status ?? ''}:${collection ?? ''}` }
  const list = prepareBlogList(organizationId, input.status, mcpPageWindow({
    ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.cursor ? { cursor: input.cursor } : {}),
  }, resource), collection)
  return list.read(await executeBatch(db, list.queries, { operation: 'Read blog index' }), resource)
}

export type ProductEditorContext = {
  env: CloudflareEnv
  db: DbClient
  organization: Omit<OrganizationAccessRow, 'membership' | 'user_id' | 'member_role'> & ResolvedMembership
}

export async function loadDashboardProduct(
  event: H3Event, organizationId: string, locationId: string | null, productId: string, editor = false,
) {
  const plan = prepareDashboardProductRead(productId, editor)
  const context = await readWebsiteMember(event, organizationId, plan.queries)
  return plan.read(context.rows, context, locationId)
}

export async function presentDashboardProduct(
  context: Omit<ProductEditorContext, 'organization'> & { organization: OrganizationAccessRow },
  product: Product, locationId: string | null, editor = false,
) {
  const organization = { ...context.organization, ...context.organization.membership }
  const viewer = { query: 'SELECT ? AS organization_id, ? AS user_id, ? AS member_id, ? AS role, ? AS organization_wide',
    params: [organization.id, organization.userId, organization.memberId, organization.role, Number(isOrganizationWideRole(organization.role))] }
  const plan = prepareDashboardProductRead(product.id, editor, product)
  return plan.read(await executeBatch(context.db, plan.queries.map(query => withViewer(viewer, query)), { operation: 'Read saved product editor' }),
    { ...context, organization }, locationId)
}

/** The same authorized product read joins either the document batch or its direct API batch. */
export function prepareDashboardProductRead(productId: string, editor = true, saved?: Product) {
  const assignment = assignedOfferingCondition({ user: BATCH_VIEWER.user, unrestricted: '0' })
  const update = roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ products: ['update'] }))
  const assigned = roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ products: ['assigned'] }))
  const selected: BatchQuery = { query: `SELECT p.id, p.organization_id FROM products p
    WHERE p.organization_id = ${BATCH_VIEWER.organization} AND p.id = ? AND (${update} OR (${assigned} AND (${assignment.sql})))`, params: [productId] }
  const organization = { sql: '(SELECT organization_id FROM editor_product)' }
  const record = saved ? null : prepareOrganizationProduct(organization, productId)
  const metadata = prepareDashboardProductMetadata(organization, productId, editor)
  const recordQueries = record?.queries ?? [{ query: 'SELECT id FROM editor_product', params: [] }]
  const queries = [...recordQueries, ...metadata.queries].map((statement): BatchQuery => {
    const query = statement.query.trimStart()
    return { query: `WITH editor_product AS (${selected.query})${/^WITH\s/i.test(query) ? `, ${query.slice(5)}` : ` ${query}`}`,
      params: [...selected.params ?? [], ...statement.params ?? []] }
  })
  return { queries, async read(rows: D1Result[], context: ProductEditorContext, locationId: string | null) {
    if (!await roleAllows({ ...context.organization, permissions: { products: ['update'] } })) await assertRoleAllows({ ...context.organization, permissions: { products: ['assigned'] } })
    if (saved && rows[0]!.results.length !== 1) throw new HTTPError({ statusCode: 404, statusMessage: 'Product not found' })
    const product = saved ?? record!.read(rows.slice(0, recordQueries.length))[0]
    if (!product || product.organization_id !== context.organization.id) throw new HTTPError({ statusCode: 404, statusMessage: 'Product not found' })
    return metadata.read(rows.slice(recordQueries.length), product, locationId, context)
  } }
}

function prepareDashboardProductMetadata(organizationId: string | { sql: string }, productId: string, editor: boolean) {
  const media = preparePublicSocialMedia(organizationId, 'product', [productId])
  const links = prepareProductPublicPresentation(organizationId, productId)
  const navigation = editor ? prepareDashboardOffering(organizationId, productId) : null
  const mediaEnd = media.queries.length
  const linksEnd = mediaEnd + links.queries.length
  const navigationEnd = linksEnd + (navigation?.queries.length ?? 0)
  return {
    queries: [...media.queries, ...links.queries, ...navigation?.queries ?? [], publishedHostProfilesQuery(organizationId, {
      query: `SELECT assigned_member_id FROM product_booking_configs WHERE organization_id = ${typeof organizationId === 'string' ? '?' : organizationId.sql} AND product_id = ? AND unit = 'nights'`,
      params: [...(typeof organizationId === 'string' ? [organizationId] : []), productId],
    })],
    async read(rows: D1Result[], product: Product, locationId: string | null, context: ProductEditorContext) {
      const { env, db, organization } = context
      const organizationId = organization.id
      const canPreview = await roleAllows({ organizationId, role: organization.role, permissions: { content: ['read'] } })
      if (locationId !== null && !product.locations.some(entry => entry.location_id === locationId)) {
        throw new HTTPError({ statusCode: 404, statusMessage: 'Product not found at this location' })
      }
      const [hydrated] = await hydrateProductMedia(db, organizationId, [product], media.read(rows.slice(0, mediaEnd), organizationId))
      const { publicUrl, publicUrls } = await links.read(rows.slice(mediaEnd, linksEnd), db, env, product, organization.default_currency)
      const details = await navigation?.read(rows.slice(linksEnd, navigationEnd), hydrated!, locationId, context)
      const hostProfilePublished = product.stay ? rows[navigationEnd]!.results.length > 0 : null
      const previewToken = editor && canPreview && isOrganizationWideRole(organization.role) && ['dish', 'experience', 'service'].includes(product.kind)
        ? await editorPreviewToken(env.PREVIEW_SECRET, organizationId) : null
      let previewUrl: string | null = null
      if (product.kind === 'stay' && organization.subdomain && canPreview) {
        const origin = tenantOrganizationOrigin({ platformDomain: env.NUXT_PUBLIC_PLATFORM_DOMAIN ?? '',
          freeOrganizationDomain: env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN ?? '', subdomain: organization.subdomain })
        if (!origin) throw new Error('Listing preview has no configured site address')
        const url = new URL(presentationForProduct(product).productPath('', product.slug), origin)
        url.searchParams.set(PREVIEW_TOKEN_QUERY, await editorPreviewToken(env.PREVIEW_SECRET, organizationId))
        previewUrl = url.toString()
      }
      return { success: true as const, product: hydrated!,
        ...(editor ? { collections: product.stay ? details!.collections : [], preview_token: previewToken, locations: details!.locations, assigned_member_name: details!.assigned_member_name } : {}),
        public_url: publicUrl, public_urls: publicUrls, preview_url: previewUrl, host_profile_published: hostProfilePublished,
        offering: details?.offering ?? null }
    },
  }
}
