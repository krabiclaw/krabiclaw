import { parseOpeningHours, parseSpecialHours } from '~/shared/reservation-hours'
import type { BatchQuery, DbClient } from '~/server/db'
import type { PublicBase } from '~/server/utils/public-base'
import { calculateMapEmbedUrl } from '~/server/utils/google-places'
import { PUBLIC_LOCATION_SECTIONS, PUBLIC_SITE_SECTIONS, type PublicLocationSection, type PublicShellPayload, type PublicSiteSection } from '~/utils/public-resource-contracts'
import { listOrganizationProducts, PUBLIC_PRODUCT_SQL } from '~/server/utils/product-management'
import type { Product } from '~/server/types/products'
import { productSurfaceOf } from '~/utils/product-presentation'
import { publicLocationHomeSlugSql, publicLocationSql } from '~/server/utils/public-locations'
import type { CloudflareEnv } from '~/server/utils/auth'
import { isCurrencyCode } from '~/shared/currencies'
import { parsePostalAddress } from '~/utils/postal-address'
import type { PublicMediaPlacement } from '~/server/utils/public-social-image'
import { publicSocialMediaFromPlacements } from '~/utils/social-metadata'
import type { PublicConsultationSettings, PublicCompliance, PublicPageLink } from '~/types/public-site'

type BatchResult = { results?: unknown[] }

const requireLocationString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Public location ${field} is unavailable`)
  }
  return value
}

export interface PublicShellQueryIndexes {
  locations: number
  config: number
  content: Record<PublicContentSection, number>
  catalog: number
  media: number
}

/**
 * Which content sections have something on them: one statement per section,
 * because D1 refuses a compound SELECT of more than five terms. Each binds the
 * organization id once and answers the rows its section's pages read, by
 * location; `site` is 1 where a row also counts for the site-wide page.
 */
export const PUBLIC_CONTENT_SECTION_QUERIES = {
  reviews: `SELECT DISTINCT location_id, 1 AS site FROM reviews WHERE organization_id = ? AND status = 'approved'`,
  qa: `SELECT DISTINCT location_id, scope_path IS NULL AS site FROM content_documents
        WHERE organization_id = ? AND kind = 'qa' AND row_role = 'root' AND status = 'published'`,
  posts: `SELECT DISTINCT location_id, 1 AS site FROM content_documents
           WHERE organization_id = ? AND kind = 'social_post' AND row_role = 'root' AND status = 'published' AND visibility = 'listed'`,
  blog: `SELECT DISTINCT NULL AS location_id, 1 AS site FROM content_documents
          WHERE organization_id = ? AND kind = 'article' AND row_role = 'root' AND status = 'published' AND visibility = 'listed'
            AND (metadata_json ->> '$.collection') = 'blog'`,
  photos: `SELECT DISTINCT mp.owner_id AS location_id, 1 AS site FROM media_placements mp JOIN media_assets ma ON ma.id = mp.asset_id
            WHERE mp.organization_id = ? AND mp.owner_type = 'business_location' AND mp.slot = 'gallery' AND mp.status = 'active'
              AND ma.kind = 'image' AND ma.status = 'active'`,
} as const

export type PublicContentSection = keyof typeof PUBLIC_CONTENT_SECTION_QUERIES
export const PUBLIC_CONTENT_SECTIONS = Object.keys(PUBLIC_CONTENT_SECTION_QUERIES) as PublicContentSection[]
export type PublicContentSectionRow = { location_id: string | null; site: number }
export type PublicContentSectionRows = Record<PublicContentSection, ReadonlyArray<PublicContentSectionRow>>

/** Each section's rows, read by `read`. */
export function publicContentSectionRows(read: (section: PublicContentSection) => ReadonlyArray<PublicContentSectionRow>): PublicContentSectionRows {
  return { reviews: read('reviews'), qa: read('qa'), posts: read('posts'), blog: read('blog'), photos: read('photos') }
}

/**
 * Which kinds of product the site publishes, and where: one row per kind and
 * location it is offered at (location_id NULL for none). Experiences are not
 * read here, because a published experience is on the page only while it can
 * be booked; the caller reads those through the catalog's readiness check.
 * Every other kind is publishable only when it can be sold, so publication is
 * the page's own test. Binds the organization id once.
 */
export const PUBLIC_CATALOG_SECTIONS_SQL = `SELECT DISTINCT p.kind, pl.location_id FROM products p
  JOIN product_publications pub ON pub.product_id = p.id AND pub.organization_id = p.organization_id
  LEFT JOIN product_locations pl ON pl.product_id = p.id AND pl.organization_id = p.organization_id AND pl.published = 1
 WHERE p.organization_id = ? AND p.kind <> 'experience' AND ${PUBLIC_PRODUCT_SQL}`

export type PublicCatalogRow = { kind: string; location_id: string | null }

/** The catalog rows of products already read: each kind once, and at each location it is offered at. */
export function productCatalogRows(products: readonly Product[]): PublicCatalogRow[] {
  return products.flatMap(product => [
    { kind: product.kind, location_id: null },
    ...product.locations.filter(entry => entry.published).map(entry => ({ kind: product.kind, location_id: entry.location_id })),
  ])
}

/**
 * The site's sections and each location's, from its published catalog and its
 * content rows. Navigation, sitemap and pages all read these flags.
 */
export function publicSections(vertical: string | null, catalog: readonly PublicCatalogRow[], contentRows: PublicContentSectionRows, hasReservations: boolean) {
  const hasContent = (section: PublicContentSection, locationId: string | null) => contentRows[section].some(row =>
    locationId === null ? Number(row.site) === 1 : row.location_id === locationId)
  const offersSurface = (surface: string, locationId?: string) => catalog.some(row => productSurfaceOf(vertical, { kind: row.kind as Product['kind'] }) === surface
    && (locationId === undefined || row.location_id === locationId))
  return {
    site: Object.fromEntries(PUBLIC_SITE_SECTIONS.map(section => [section,
      section === 'reservations' ? hasReservations
        : section === 'menu' || section === 'products' || section === 'experiences' || section === 'stays' ? offersSurface(section)
          : hasContent(section as PublicContentSection, null),
    ])) as Record<PublicSiteSection, boolean>,
    location: (locationId: string) => Object.fromEntries(PUBLIC_LOCATION_SECTIONS.map(section => [section,
      section === 'menu' || section === 'products' || section === 'experiences' ? offersSurface(section, locationId) : hasContent(section as PublicContentSection, locationId),
    ])) as Record<PublicLocationSection, boolean>,
  }
}

export function appendPublicShellQueries(
  queries: BatchQuery[],
  organizationId: string,
): PublicShellQueryIndexes {
  const push = (query: string, params: unknown[]) => {
    const index = queries.length
    queries.push({ query, params })
    return index
  }

  return {
    locations: push(`SELECT bl.id, bl.slug, bl.title, bl.address, bl.phone, bl.email,
                     bl.website_url, bl.maps_url, bl.latitude, bl.longitude,
                     bl.opening_hours, bl.special_hours, bl.timezone, bl.rating,
                     bl.review_count, bl.status,
                     bl.description, bl.short_description,
                     bl.last_synced_at, bl.seo_title, bl.seo_description,
                     bl.canonical_url,
                     EXISTS (SELECT 1 FROM location_reservation_configs c
                              WHERE c.organization_id = bl.organization_id AND c.location_id = bl.id) AS has_reservations,
                     ${publicLocationHomeSlugSql('bl')} AS home_slug
                FROM business_locations bl
               WHERE bl.organization_id = ? AND ${publicLocationSql('bl')}
               ORDER BY bl.title ASC`, [organizationId]),
    config: push(`SELECT setting.key, setting.value
                FROM organization s, json_each(s.settings_json, '$.config') setting
               WHERE s.id = ?
                 AND setting.key IN ('press_email', 'partnerships_email', 'catering_email', 'careers_email')
              `, [organizationId]),
    catalog: push(PUBLIC_CATALOG_SECTIONS_SQL, [organizationId]),
    content: Object.fromEntries(PUBLIC_CONTENT_SECTIONS.map(section => [section, push(PUBLIC_CONTENT_SECTION_QUERIES[section], [organizationId])])) as Record<PublicContentSection, number>,
    // The organization's own placements and its locations' heroes and cards,
    // in one read: the shell's logo and favicon, and each location's og:image.
    media: push(`SELECT mp.owner_type, mp.owner_id, mp.slot, ma.id AS asset_id,
                        ma.public_url, ma.thumbnail_url, ma.kind, ma.mime_type, ma.width, ma.height
                   FROM media_placements mp
                   JOIN media_assets ma ON ma.id = mp.asset_id AND ma.organization_id = mp.organization_id AND ma.status = 'active'
                  WHERE mp.organization_id = ? AND mp.status = 'active'
                    AND ((mp.owner_type = 'organization' AND mp.owner_id = mp.organization_id)
                      OR (mp.owner_type = 'business_location' AND mp.slot IN ('hero', 'social_card')))
                  ORDER BY mp.owner_type, mp.owner_id, mp.slot, mp.sort_order, mp.id`, [organizationId]),
  }
}

export async function buildPublicShellPayload(
  db: DbClient,
  organization: PublicBase['organization'],
  results: BatchResult[],
  indexes: PublicShellQueryIndexes,
  env?: CloudflareEnv,
  /** The bookable experiences, when the caller read them beside the shell rows. */
  experiences?: Product[],
  extra?: {
    consultation?: PublicConsultationSettings | null
    canSchedule?: boolean
    compliance?: PublicCompliance | null
    pageLinks?: PublicPageLink[]
    searchConsoleVerification?: string | null
  },
): Promise<PublicShellPayload> {
  const rawLocations = (results[indexes.locations]?.results ?? []) as Record<string, unknown>[]
  const placements = (results[indexes.media]?.results ?? []) as Array<PublicMediaPlacement & { owner_type: string; owner_id: string }>
  const organizationMedia = placements.filter(item => item.owner_type === 'organization')
    .map(({ owner_type: _ownerType, owner_id: _ownerId, ...item }) => item)
  const organizationSocialMedia = publicSocialMediaFromPlacements('organization', organizationMedia, organizationMedia)
  // The catalog sections follow the published catalog the section pages list,
  // through the same call, so the navigation cannot offer an empty page.
  experiences ??= await listOrganizationProducts(db, { organizationId: organization.id, kind: 'experience', publishedOnly: true, env })
  const sections = publicSections(organization.vertical,
    [...(results[indexes.catalog]?.results ?? []) as PublicCatalogRow[], ...productCatalogRows(experiences)],
    publicContentSectionRows(section => (results[indexes.content[section]]?.results ?? []) as PublicContentSectionRow[]),
    rawLocations.some(location => Number(location.has_reservations) === 1))
  const locations = rawLocations.map(location => {
    const locationMedia = publicSocialMediaFromPlacements('business_location',
      placements.filter(item => item.owner_type === 'business_location' && item.owner_id === location.id)
        .map(({ owner_type: _ownerType, owner_id: _ownerId, ...item }) => item),
      organizationMedia)
    const address = parsePostalAddress(location.address)
    return {
      id: requireLocationString(location.id, 'id'),
      slug: requireLocationString(location.slug, 'slug'),
      title: requireLocationString(location.title, 'title'),
      address,
      phone: location.phone,
      email: location.email ?? null,
      website_url: location.website_url,
      maps_url: location.maps_url,
      map_embed_url: calculateMapEmbedUrl({
        title: String(location.title),
        maps_url: location.maps_url as string | null,
        latitude: location.latitude as number | null,
        longitude: location.longitude as number | null,
        address,
      }),
      latitude: location.latitude,
      longitude: location.longitude,
      opening_hours: parseOpeningHours(location.opening_hours ? JSON.parse(String(location.opening_hours)) : null),
      special_hours: parseSpecialHours(location.special_hours ? JSON.parse(String(location.special_hours)) : null),
      timezone: requireLocationString(location.timezone, 'timezone'),
      rating: location.rating,
      review_count: location.review_count,
      status: location.status,
      media: locationMedia.media,
      social_image: locationMedia.social_image,
      short_description: location.short_description ?? null,
      description: location.description ?? null,
      seo_title: location.seo_title ?? null,
      seo_description: location.seo_description ?? null,
      canonical_url: location.canonical_url ?? null,
      home_slug: typeof location.home_slug === 'string' ? location.home_slug : null,
      sections: sections.location(String(location.id)),
    }
  })
  const configRows = (results[indexes.config]?.results ?? []) as Array<{ key: string, value: string }>
  const config: Record<string, string> = Object.fromEntries(
    configRows.filter(({ key }) => !key.startsWith('__')).map(({ key, value }) => [key, value]),
  )
  if (!isCurrencyCode(organization.default_currency)) throw new Error(`Unsupported organization currency: ${organization.default_currency}`)
  config.default_currency = organization.default_currency
  if (organization.contact_email) config.contact_email = organization.contact_email
  if (organization.contact_phone) config.contact_phone = organization.contact_phone
  if (organization.name) config.name = organization.name
  if (organization.brand_description) config.brand_description = organization.brand_description
  if (organization.seo_title) config.seo_title = organization.seo_title
  if (organization.seo_description) config.seo_description = organization.seo_description
  if (organization.canonical_url) config.canonical_url = organization.canonical_url
  if (organization.search_console_verification) config.search_console_verification = organization.search_console_verification

  return {
    platformMessages: null,
    organization: {
      name: organization.name,
      brand_description: organization.brand_description,
      vertical: organization.vertical,
      media: organizationSocialMedia.media,
      social_image: organizationSocialMedia.social_image,
      config: { phone: organization.contact_phone },
    },
    locations,
    config,
    googleMaps: {
      business: null,
      reviews: [],
      media: [],
      syncedAt: null,
    },
    sections: sections.site,
    consultation: extra?.consultation ?? null,
    canSchedule: extra?.canSchedule ?? false,
    compliance: extra?.compliance ?? null,
    pageLinks: extra?.pageLinks ?? [],
    searchConsoleVerification: extra?.searchConsoleVerification ?? (organization.search_console_verification as string | null) ?? null,
  }
}
