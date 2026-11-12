import { PRODUCT_KINDS, type ProductKind } from '~/shared/product-details'
import type { FormattedBookingPolicySummary } from '~/server/utils/booking-policy-summary'
import type { Collection, Product } from '~/server/types/products'
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { SocialImageSource } from '~/utils/social-metadata'
import type { PublicLocationArea } from '~/types/public-location'
import type { StayMapSharing } from '~/shared/stay-listing'
import { isStayPhotoRoom } from '~/shared/stay-photos'
import { isRecord } from '~/utils/api-clients'

export interface PublicShellOrganization {
  name: string | null
  brand_description: string | null
  media: Array<{ asset_id: string; slot: string; public_url: string | null; thumbnail_url: string | null; kind: string | null }>
  social_image: SocialImageSource | null
  vertical: string | null
  config: { phone: string | null } | null
}

/** The sections of a location's own pages; each is a page only when it has something on it. */
export const PUBLIC_LOCATION_SECTIONS = ['menu', 'products', 'experiences', 'posts', 'reviews', 'qa', 'photos'] as const
export type PublicLocationSection = typeof PUBLIC_LOCATION_SECTIONS[number]

/** The site's sections. The navigation offers, the sitemap lists and the page renders exactly the ones that are true. */
export const PUBLIC_SITE_SECTIONS = ['menu', 'products', 'experiences', 'stays', 'reservations', 'blog', 'posts', 'reviews', 'qa', 'photos'] as const
export type PublicSiteSection = typeof PUBLIC_SITE_SECTIONS[number]

export interface PublicShellLocation {
  [key: string]: ApiValue
  id: string
  slug: string
  title: string
  address?: ApiValue
  city?: ApiValue
  stay_map_sharing: StayMapSharing | null
  public_area: PublicLocationArea | null
  social_image?: SocialImageSource | null
  sections: Record<PublicLocationSection, boolean>
}

export interface PublicShellPayload {
  organization: PublicShellOrganization
  locations: PublicShellLocation[]
  config: Record<string, string>
  google_maps: ApiRecord
  sections: Record<PublicSiteSection, boolean>
  platform_messages: Record<string, string> | null
  consultation?: import('~/types/public-site').PublicConsultationSettings | null
  can_schedule?: boolean
  compliance?: import('~/types/public-site').PublicCompliance | null
  page_links?: import('~/types/public-site').PublicPageLink[]
  search_console_verification?: string | null
}

const sectionFlags = (value: unknown, names: readonly string[]): boolean =>
  isRecord(value) && names.every(name => typeof value[name] === 'boolean')

const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

export const isPublicShellPayload = (value: unknown): value is PublicShellPayload => {
  if (!isRecord(value) || !isRecord(value.organization)) return false
  if (!nullableString(value.organization.name)) return false
  if (!nullableString(value.organization.brand_description)) return false
  if (!Array.isArray(value.organization.media) || !value.organization.media.every(item => isRecord(item)
    && typeof item.asset_id === 'string' && typeof item.slot === 'string'
    && nullableString(item.public_url) && nullableString(item.thumbnail_url) && nullableString(item.kind))) return false
  if (value.organization.social_image !== null && (!isRecord(value.organization.social_image) || typeof value.organization.social_image.url !== 'string')) return false
  if (!nullableString(value.organization.vertical)) return false
  if (value.organization.config !== null && !isRecord(value.organization.config)) return false
  if (isRecord(value.organization.config) && !nullableString(value.organization.config.phone)) return false
  if (!Array.isArray(value.locations)
    || !value.locations.every(location =>
      isRecord(location)
      && typeof location.id === 'string'
      && typeof location.slug === 'string'
      && typeof location.title === 'string'
      && (location.stay_map_sharing === null || location.stay_map_sharing === 'general' || location.stay_map_sharing === 'specific')
      && (location.public_area === null || (isRecord(location.public_area)
        && nullableString(location.public_area.label)
        && nullableString(location.public_area.locality)
        && nullableString(location.public_area.administrative_area)
        && nullableString(location.public_area.region_code)
        && typeof location.public_area.approximate === 'boolean'
        && (location.public_area.center === null || (isRecord(location.public_area.center)
          && typeof location.public_area.center.latitude === 'number' && Number.isFinite(location.public_area.center.latitude)
          && typeof location.public_area.center.longitude === 'number' && Number.isFinite(location.public_area.center.longitude)))
        && (location.public_area.radius_meters === null || typeof location.public_area.radius_meters === 'number')))
      && (location.stay_map_sharing === null || (location.address === null && location.maps_url === null))
      && (location.stay_map_sharing !== 'general' || (location.latitude === null && location.longitude === null))
      && sectionFlags(location.sections, PUBLIC_LOCATION_SECTIONS))) return false
  if (!isRecord(value.config)
    || !Object.values(value.config).every(item => typeof item === 'string')) return false
  if (!isRecord(value.google_maps)
    || (value.google_maps.business !== null && !isRecord(value.google_maps.business))
    || !Array.isArray(value.google_maps.reviews)
    || !Array.isArray(value.google_maps.media)) return false
  if (value.platform_messages !== null && (!isRecord(value.platform_messages)
    || !Object.values(value.platform_messages).every(message => typeof message === 'string'))) return false
  if (value.consultation !== undefined && value.consultation !== null && (!isRecord(value.consultation) || typeof value.consultation.mode !== 'string')) return false
  if (value.can_schedule !== undefined && typeof value.can_schedule !== 'boolean') return false
  if (value.compliance !== undefined && value.compliance !== null && !isRecord(value.compliance)) return false
  if (value.page_links !== undefined && !Array.isArray(value.page_links)) return false
  if (value.search_console_verification !== undefined && value.search_console_verification !== null && typeof value.search_console_verification !== 'string') return false
  return sectionFlags(value.sections, PUBLIC_SITE_SECTIONS)
}

export interface PublicPagePayload {
  kind: string
  shell: PublicShellPayload
  content: ApiRecord[]
  content_blocks: ApiRecord[]
  tenant_page: PublicTenantPage | null
  location_reviews: ApiRecord[]
  global_reviews: ApiRecord[]
  reviews_aggregate: ApiRecord | null
  reviews_list: ApiRecord[]
  media: ApiRecord[]
  qa_list: ApiRecord[]
  blog_post: ApiRecord | null
  /** Each table product's terms in the page's language, by product id: what the reservations page states before booking. */
  table_policy_summaries: Record<string, FormattedBookingPolicySummary>
  products: Product[]
  collections: Collection[]
  locale_representations: PublicLocaleRepresentation[]
}

export interface PublicLocaleRepresentation {
  locale: string
  label: string
  route_path: string
  source: 'source' | 'localized'
}

/**
 * The shape a public surface is allowed to render.
 *
 * Checks the relationships the pages actually read — variants carry the
 * prices, memberships say where the product is offered and grouped — rather
 * than every field, so a payload missing one of them fails here instead of
 * rendering a product with no offer.
 */
export function isPublicProduct(value: unknown): value is Product {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.organization_id === 'string'
    && PRODUCT_KINDS.includes(value.kind as ProductKind)
    && typeof value.name === 'string'
    && typeof value.slug === 'string'
    && typeof value.description === 'string'
    && typeof value.active === 'boolean'
    && Array.isArray(value.variants)
    && value.variants.every(variant => isRecord(variant)
      && typeof variant.id === 'string'
      && typeof variant.name === 'string'
      && Array.isArray(variant.prices))
    && isRecord(value.details)
    && Array.isArray(value.locations)
    && value.locations.every(entry => isRecord(entry)
      && typeof entry.location_id === 'string'
      && typeof entry.active === 'boolean'
      && typeof entry.published === 'boolean')
    && Array.isArray(value.collections)
    && value.collections.every(entry => isRecord(entry)
      && typeof entry.collection_id === 'string'
      && Number.isInteger(entry.sort_order))
    && (value.image === null || isRecord(value.image))
    && Array.isArray(value.gallery)
    && (value.kind !== 'stay' || (isRecord(value.stay)
      && Array.isArray(value.stay.photo_rooms)
      && value.stay.photo_rooms.every(isStayPhotoRoom)))
}

export function isPublicCollection(value: unknown): value is Collection {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.organization_id === 'string'
    && typeof value.name === 'string'
    && typeof value.slug === 'string'
    && Number.isInteger(value.sort_order)
}

export const isPublicPagePayload = (
  value: unknown,
  expectedKind?: string | null,
): value is PublicPagePayload =>
  isRecord(value)
  && typeof value.kind === 'string'
  && isPublicShellPayload(value.shell)
  && (!expectedKind || value.kind === expectedKind)
  && Array.isArray(value.content)
  && value.content.every(item => isRecord(item) && typeof item.field === 'string')
  && Array.isArray(value.content_blocks)
  && (value.tenant_page === null || (isRecord(value.tenant_page)
    && typeof value.tenant_page.id === 'string'
    && typeof value.tenant_page.path === 'string'
    && typeof value.tenant_page.title === 'string'
    && Array.isArray(value.tenant_page.blocks)))
  && Array.isArray(value.location_reviews)
  && Array.isArray(value.global_reviews)
  && value.global_reviews.every(item => isRecord(item) && typeof item.rating === 'number')
  && (value.reviews_aggregate === null || isRecord(value.reviews_aggregate))
  && Array.isArray(value.reviews_list)
  && Array.isArray(value.media)
  && Array.isArray(value.qa_list)
  && (value.blog_post === null || isRecord(value.blog_post))
  && isRecord(value.table_policy_summaries)
  && Object.values(value.table_policy_summaries).every(item => isRecord(item) && typeof item.heading === 'string' && Array.isArray(item.items))
  && Array.isArray(value.products)
  && value.products.every(isPublicProduct)
  && Array.isArray(value.collections)
  && value.collections.every(isPublicCollection)
  && Array.isArray(value.locale_representations)
  && value.locale_representations.every(item => isRecord(item)
    && typeof item.locale === 'string'
    && typeof item.label === 'string'
    && typeof item.route_path === 'string'
    && (item.source === 'source' || item.source === 'localized'))

export type PublicSocialPost = import('~/server/utils/post-management').PublicSocialPost

/** The template-neutral post every social template draws. */
export function isPublicSocialPost(value: unknown): value is PublicSocialPost {
  return isRecord(value) && typeof value.id === 'string' && typeof value.slug === 'string' && typeof value.path === 'string'
    && (value.title === null || typeof value.title === 'string') && (value.body === null || typeof value.body === 'string')
    && Array.isArray(value.media) && Array.isArray(value.publications)
    && value.publications.every(item => isRecord(item) && (item.channel === 'facebook' || item.channel === 'instagram') && (item.url === null || typeof item.url === 'string') && (item.account_name === null || typeof item.account_name === 'string'))
}
