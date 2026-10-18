import { PRODUCT_KINDS, type ProductKind } from '~/shared/product-details'
import type { RenderedBookingPolicySummary } from '~/server/utils/reservations'
import type { Collection, Product } from '~/server/types/products'
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { SocialImageSource } from '~/utils/social-metadata'

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
  social_image?: SocialImageSource | null
  /** The one home this location holds and nothing besides; its page is the home's. */
  home_slug: string | null
  sections: Record<PublicLocationSection, boolean>
}

export interface PublicShellPayload {
  organization: PublicShellOrganization
  locations: PublicShellLocation[]
  config: Record<string, string>
  googleMaps: ApiRecord
  sections: Record<PublicSiteSection, boolean>
  platformMessages: Record<string, string> | null
  consultation?: import('~/types/blawby').PublicConsultationSettings | null
  canSchedule?: boolean
  compliance?: import('~/types/blawby').PublicCompliance | null
  pageLinks?: import('~/types/blawby').PublicBlawbyPageLink[]
  searchConsoleVerification?: string | null
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
      && (location.home_slug === null || typeof location.home_slug === 'string')
      && sectionFlags(location.sections, PUBLIC_LOCATION_SECTIONS))) return false
  if (!isRecord(value.config)
    || !Object.values(value.config).every(item => typeof item === 'string')) return false
  if (!isRecord(value.googleMaps)
    || (value.googleMaps.business !== null && !isRecord(value.googleMaps.business))
    || !Array.isArray(value.googleMaps.reviews)
    || !Array.isArray(value.googleMaps.media)) return false
  if (value.platformMessages !== null && (!isRecord(value.platformMessages)
    || !Object.values(value.platformMessages).every(message => typeof message === 'string'))) return false
  if (value.consultation !== undefined && value.consultation !== null && (!isRecord(value.consultation) || typeof value.consultation.mode !== 'string')) return false
  if (value.canSchedule !== undefined && typeof value.canSchedule !== 'boolean') return false
  if (value.compliance !== undefined && value.compliance !== null && !isRecord(value.compliance)) return false
  if (value.pageLinks !== undefined && !Array.isArray(value.pageLinks)) return false
  if (value.searchConsoleVerification !== undefined && value.searchConsoleVerification !== null && typeof value.searchConsoleVerification !== 'string') return false
  return sectionFlags(value.sections, PUBLIC_SITE_SECTIONS)
}

export interface PublicPagePayload {
  kind: string
  shell: PublicShellPayload
  content: ApiRecord[]
  content_blocks: ApiRecord[]
  tenant_page: PublicTenantPage | null
  locationReviews: ApiRecord[]
  globalReviews: ApiRecord[]
  reviewsAggregate: ApiRecord | null
  reviewsList: ApiRecord[]
  media: ApiRecord[]
  qaList: ApiRecord[]
  blogPost: ApiRecord | null
  reservationPolicyByLocation: Record<string, RenderedBookingPolicySummary | null>
  products: Product[]
  collections: Collection[]
  localeRepresentations: PublicLocaleRepresentation[]
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
    && Array.isArray(value.options)
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
  && Array.isArray(value.locationReviews)
  && Array.isArray(value.globalReviews)
  && value.globalReviews.every(item => isRecord(item) && typeof item.rating === 'number')
  && (value.reviewsAggregate === null || isRecord(value.reviewsAggregate))
  && Array.isArray(value.reviewsList)
  && Array.isArray(value.media)
  && Array.isArray(value.qaList)
  && (value.blogPost === null || isRecord(value.blogPost))
  && isRecord(value.reservationPolicyByLocation)
  && Object.values(value.reservationPolicyByLocation).every(item => item === null || isRecord(item))
  && Array.isArray(value.products)
  && value.products.every(isPublicProduct)
  && Array.isArray(value.collections)
  && value.collections.every(isPublicCollection)
  && Array.isArray(value.localeRepresentations)
  && value.localeRepresentations.every(item => isRecord(item)
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
