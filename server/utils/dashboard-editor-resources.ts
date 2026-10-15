import { getSourceLocale } from '~/server/utils/organization-locales'
import { mcpPageWindow } from '~/server/utils/mcp-pagination'
import { HTTPError } from 'nitro';

import type { H3Event } from 'nitro'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { getOrganizationEntitlements } from '~/server/utils/billing-access'
import { listLocationQa } from '~/server/utils/location-qa'
import { requireLocationAccess, requireOrganizationAccess, requireProductAccess } from '~/server/utils/location-access'
import {
  assertLocationAccess,
  assertResourceAccess,
  memberAccessPrincipal,
} from '~/server/utils/member-access'
import { getMediaAsset, listMediaAssets } from '~/server/utils/media-asset-manager'
import { getDashboardLocationContext } from '~/server/utils/dashboard-context'
import { parseLocationPayload } from '~/server/utils/location-payload'
import { getProduct, hydrateProductMedia, summarizeLocationProducts } from '~/server/utils/product-management'
import { getLocationReservationConfig } from '~/server/utils/reservations'
import { requireBlogAccess } from '~/server/utils/blog-access'
import { getBlogPost, listBlogPosts } from '~/server/utils/content/publishing'
import { isArticleCollection } from '~/utils/article-collections'
import { createPreviewToken, PREVIEW_TOKEN_TTL_MS } from '~/server/utils/preview-token'
import { resolveOrganizationCmsCapabilities } from '~/server/utils/cms-capabilities'
import { getEditablePages } from '~/config/content-registry'

interface EditorLocationRow {
  id: string
  slug: string
  title: string
  status: 'active' | 'inactive' | 'sync_error'
}

export async function loadDashboardEditorContext(event: H3Event, organizationId: string) {
  const { env, db, organization } = await requireOrganizationAccess(event, organizationId)
  if (!organization.vertical) throw new HTTPError({ statusCode: 500, statusMessage: 'Organization vertical is not configured' })

  // requireOrganizationAccess(event, organizationId) has already
  // authorized this caller (location-access.ts), so asserting again here only
  // bought a second read of the same member row.
  const [locationRows, entitlements, sourceLocale] = await Promise.all([
    queryAll<EditorLocationRow>(db, `
      SELECT id, slug, title, status
        FROM business_locations
       WHERE organization_id = ?  AND status = 'active'
       ORDER BY title ASC
    `, [organization.id]),
    getOrganizationEntitlements(env, organization.id),
    getSourceLocale(db, organization.id),
  ])
  const locations = locationRows
  if (typeof env.PREVIEW_SECRET !== 'string' || !env.PREVIEW_SECRET) {
    throw new HTTPError({ statusCode: 500, statusMessage: 'PREVIEW_SECRET is required for editor previews' })
  }
  const previewToken = await createPreviewToken(env.PREVIEW_SECRET, organizationId, Date.now() + PREVIEW_TOKEN_TTL_MS)
  const { vertical, template } = resolveOrganizationCmsCapabilities(organization.vertical, organization.theme_id)
  return {
    success: true as const,
    context: {
      sourceLocale,
      organization: {
        id: organization.id,
        name: organization.name,
        subdomain: organization.subdomain,
        status: organization.status,
        onboarding_status: organization.onboarding_status,
        vertical,
        template,
        entitlements,
      },
      locations,
      scopes: [
        { id: null, label: 'Brand-wide', type: 'brand' as const },
        ...locations.map(location => ({ id: location.id, label: location.title, type: 'location' as const })),
      ],
      previewToken,
      editablePages: getEditablePages(vertical, template),
    },
  }
}

export async function loadDashboardLocationQa(
  event: H3Event,
  organizationId: string,
  locationId: string,
) {
  const { db } = await requireLocationAccess(event, organizationId, locationId)
  return { qa: await listLocationQa(db, organizationId, locationId) }
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
  organizationQa: number
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
    organizationQa: row?.organization_qa ?? 0,
  }
}

export async function loadDashboardLocationOverview(
  event: H3Event,
  organizationId: string,
  locationId: string,
  options: { includeProducts: boolean },
) {
  const { env, db, organization, location } = await getDashboardLocationContext(event, locationId)
  if (location.organization_id !== organizationId) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Location not found' })
  }
  const principal = memberAccessPrincipal(organization, { env, event })
  await assertLocationAccess(db, { ...principal, locationId })
  const [catalog, reservationConfig, counts] = await Promise.all([
    options.includeProducts
      ? summarizeLocationProducts(db, { organizationId: organization.id, locationId })
      : Promise.resolve({ total: 0, experiences: 0 }),
    getLocationReservationConfig(db, { organizationId: organization.id, locationId }),
    loadLocationContentCounts(db, organizationId, locationId),
  ])
  return {
    location: {
      success: true as const,
      location: parseLocationPayload(location)!,
    },
    catalog,
    reservationConfig,
    counts,
  }
}

export async function loadDashboardBlogPosts(
  event: H3Event,
  organizationId: string,
  input: { status?: string | null; collection?: string | null; limit?: number; cursor?: string },
) {
  const { env, db } = await requireBlogAccess(event, organizationId)
  const collection = input.collection ?? null
  if (collection !== null && !isArticleCollection(collection)) throw new HTTPError({ statusCode: 400, statusMessage: 'collection must be blog or docs' })
  const resource = { resource: `blog-posts:${organizationId}:${input.status ?? ''}:${collection ?? ''}` }
  return await listBlogPosts(db, organizationId, input.status, env, mcpPageWindow({
    ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.cursor ? { cursor: input.cursor } : {}),
  }, resource), resource, collection)
}

export async function loadDashboardBlogPost(
  event: H3Event,
  organizationId: string,
  postId: string,
) {
  const { env, db } = await requireBlogAccess(event, organizationId)
  const post = await getBlogPost(db, postId, organizationId, env)
  if (!post) throw new HTTPError({ statusCode: 404, statusMessage: 'Post not found' })
  return { post }
}

export async function loadDashboardProduct(
  event: H3Event,
  organizationId: string,
  locationId: string | null,
  productId: string,
) {
  const { db, organization } = await requireProductAccess(event, organizationId, productId)
  const product = await getProduct(db, organization.id, productId)
  // The catalog is organization-owned, so being offered here is what makes
  // this location's editor the right place to open it.
  if (locationId !== null && !product.locations.some(entry => entry.location_id === locationId)) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Product not found at this location' })
  }
  // Both editor scopes show the same organization-owned media as the catalog.
  const [hydrated] = await hydrateProductMedia(db, organization.id, [product])
  return { success: true as const, product: hydrated! }
}
