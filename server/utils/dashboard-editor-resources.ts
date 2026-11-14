import { hasPublishedHost } from '~/server/utils/public-provider'
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
  roleAllows,
} from '~/server/utils/member-access'
import { getMediaAsset, listMediaAssets } from '~/server/utils/media-asset-manager'
import { getDashboardLocationContext } from '~/server/utils/dashboard-context'
import { loadPublicSocialMedia } from '~/server/utils/public-social-image'
import { parseLocationPayload } from '~/server/utils/location-payload'
import { getProduct, hydrateProductMedia, productPublicPresentation, summarizeLocationProducts } from '~/server/utils/product-management'
import { requireBlogAccess } from '~/server/utils/blog-access'
import { getBlogPost, listBlogPosts } from '~/server/utils/content/publishing'
import { isArticleCollection } from '~/utils/article-collections'
import { createPreviewToken, PREVIEW_TOKEN_QUERY, PREVIEW_TOKEN_TTL_MS } from '~/server/utils/preview-token'
import { catalogLabel, catalogSummary, presentationForProduct } from '~/utils/product-presentation'
import { tenantOrganizationOrigin } from '~/utils/tenant-organization-origin'
import { resolveOrganizationCmsCapabilities } from '~/server/utils/cms-capabilities'
import { getEditablePages } from '~/config/content-registry'

import { catalogPath, locationEditorPath } from '~/server/utils/dashboard-links'
import { formatPostalAddress } from '~/utils/postal-address'
import { formatPhone } from '~/utils/phone'
import { getTodayHoursLabel } from '~/shared/reservation-hours'
import type { CatalogRow } from '~/shared/catalog-screen'

interface EditorLocationRow {
  id: string
  slug: string
  title: string
  status: 'active' | 'inactive'
}

async function editorPreviewToken(secret: unknown, organizationId: string) {
  if (typeof secret !== 'string' || !secret) {
    throw new HTTPError({ statusCode: 500, statusMessage: 'PREVIEW_SECRET is required for editor previews' })
  }
  return await createPreviewToken(secret, organizationId, Date.now() + PREVIEW_TOKEN_TTL_MS)
}

export async function loadDashboardEditorContext(event: H3Event, organizationId: string) {
  const { env, db, organization } = await requireOrganizationAccess(event, organizationId)
  if (!organization.vertical) throw new HTTPError({ statusCode: 500, statusMessage: 'Organization vertical is not configured' })

  // requireOrganizationAccess(event, organizationId) has already
  // authorized this caller (location-access.ts), so asserting again here only
  // bought a second read of the same member row.
  const [locationRows, entitlements, source_locale] = await Promise.all([
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
  const preview_token = await editorPreviewToken(env.PREVIEW_SECRET, organizationId)
  const { vertical, site } = resolveOrganizationCmsCapabilities(organization.vertical, organization.theme_id, null)
  return {
    success: true as const,
    context: {
      source_locale,
      organization: {
        id: organization.id,
        name: organization.name,
        subdomain: organization.subdomain,
        status: organization.status,
        onboarding_status: organization.onboarding_status,
        vertical,
        site,
        entitlements,
      },
      locations,
      scopes: [
        { id: null, label: 'Brand-wide', type: 'brand' as const },
        ...locations.map(location => ({ id: location.id, label: location.title, type: 'location' as const })),
      ],
      preview_token,
      editable_pages: getEditablePages(vertical, site),
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
  const { env, db, organization } = await requireProductAccess(event, organizationId, productId)
  const product = await getProduct(db, organization.id, productId)
  // The catalog is organization-owned, so being offered here is what makes
  // this location's editor the right place to open it.
  if (locationId !== null && !product.locations.some(entry => entry.location_id === locationId)) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Product not found at this location' })
  }
  // Both editor scopes show the same organization-owned media as the catalog.
  const [hydrated] = await hydrateProductMedia(db, organization.id, [product])
  const [{ publicUrl, publicUrls }, hostProfilePublished] = await Promise.all([
    productPublicPresentation(db, env, organization.id, hydrated!),
    product.stay ? hasPublishedHost(db, organization.id, product.stay) : null,
  ])
  let previewUrl: string | null = null
  if (product.kind === 'stay' && organization.subdomain && await roleAllows({
    organizationId, role: organization.member_role, permissions: { content: ['read'] },
  })) {
    const origin = tenantOrganizationOrigin({
      platformDomain: env.NUXT_PUBLIC_PLATFORM_DOMAIN ?? '',
      freeOrganizationDomain: env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN ?? '',
      subdomain: organization.subdomain,
    })
    if (!origin) throw new Error('Listing preview has no configured site address')
    const url = new URL(presentationForProduct(product).productPath('', product.slug), origin)
    url.searchParams.set(PREVIEW_TOKEN_QUERY, await editorPreviewToken(env.PREVIEW_SECRET, organizationId))
    previewUrl = url.toString()
  }
  return { success: true as const, product: hydrated!, public_url: publicUrl, public_urls: publicUrls, preview_url: previewUrl, host_profile_published: hostProfilePublished }
}
