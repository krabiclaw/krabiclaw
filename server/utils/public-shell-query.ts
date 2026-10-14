import { parseOpeningHours, parseSpecialHours } from '~/shared/reservation-hours'
import type { BatchQuery, DbClient } from '~/server/db'
import type { PublicBase } from '~/server/utils/public-base'
import { calculateMapEmbedUrl } from '~/server/utils/google-places'
import type { PublicShellPayload } from '~/utils/public-resource-contracts'
import { listOrganizationProducts } from '~/server/utils/product-management'
import type { CloudflareEnv } from '~/server/utils/auth'
import { isCurrencyCode } from '~/shared/currencies'
import { parsePostalAddress } from '~/utils/postal-address'
import type { PublicMediaPlacement } from '~/server/utils/public-social-image'
import { publicSocialMediaFromPlacements } from '~/utils/social-metadata'

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
  productLocations: number
  media: number
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
                              WHERE c.organization_id = bl.organization_id AND c.location_id = bl.id) AS has_reservations
                FROM business_locations bl
               WHERE bl.organization_id = ?  AND bl.status = 'active'
               ORDER BY bl.title ASC`, [organizationId]),
    config: push(`SELECT setting.key, setting.value
                FROM organization s, json_each(s.settings_json, '$.config') setting
               WHERE s.id = ?
                 AND setting.key IN ('press_email', 'partnerships_email', 'catering_email', 'careers_email')
              `, [organizationId]),
    productLocations: push(`SELECT DISTINCT pl.location_id
                              FROM product_locations pl
                              JOIN products p ON p.id = pl.product_id AND p.organization_id = pl.organization_id
                              JOIN product_publications pp ON pp.product_id = p.id AND pp.organization_id = p.organization_id
                             WHERE pl.organization_id = ?  AND pp.published = 1
                               AND pl.published = 1 AND p.kind <> 'experience'
                             ORDER BY pl.location_id`, [organizationId]),
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
): Promise<PublicShellPayload> {
  const rawLocations = (results[indexes.locations]?.results ?? []) as Record<string, unknown>[]
  const placements = (results[indexes.media]?.results ?? []) as Array<PublicMediaPlacement & { owner_type: string; owner_id: string }>
  const organizationMedia = placements.filter(item => item.owner_type === 'organization')
    .map(({ owner_type: _ownerType, owner_id: _ownerId, ...item }) => item)
  const organizationSocialMedia = publicSocialMediaFromPlacements('organization', organizationMedia, organizationMedia)
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

  const activeLocationIds = new Set(rawLocations.map(location => String(location.id)))
  const productLocationRows = (results[indexes.productLocations]?.results ?? []) as Array<{ location_id: string }>
  experiences ??= await listOrganizationProducts(db, { organizationId: organization.id, kind: 'experience', publishedOnly: true, bookableOnly: true, env })

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
    hasProducts: productLocationRows.some(row => activeLocationIds.has(String(row.location_id))),
    hasBookableProducts: experiences.length > 0,
    hasReservations: rawLocations.some(location => Number(location.has_reservations) === 1),
  }
}
