import { isRecord } from './api-clients'
import type { PublicLocaleRepresentation } from './public-resource-contracts'

export interface PublicLinksItem {
  id: string
  label: string
  destination: string
  status: 'active'
}

export interface PublicLinksPayload {
  organization: {
    id: string
    organization_id: string
    name: string | null
    brand_description: string | null
    media: Array<{ asset_id: string; slot: string; public_url: string | null; thumbnail_url: string | null; kind: string | null }>
    template: 'tenant'
  }
  page: {
    path: '/links'
    title: string
  }
  items: PublicLinksItem[]
  localeRepresentations: PublicLocaleRepresentation[]
}

export type PublicLinksResponse = { success: true } & PublicLinksPayload

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

export function isPublicLinksPayload(value: unknown): value is PublicLinksPayload {
  if (!isRecord(value) || !isRecord(value.organization) || !isRecord(value.page) || !Array.isArray(value.items)) return false

  const organization = value.organization
  const page = value.page
  return typeof organization.id === 'string'
    && typeof organization.organization_id === 'string'
    && isNullableString(organization.name)
    && isNullableString(organization.brand_description)
    && Array.isArray(organization.media)
    && organization.media.every(item => isRecord(item) && typeof item.asset_id === 'string' && typeof item.slot === 'string' && isNullableString(item.public_url) && isNullableString(item.thumbnail_url) && isNullableString(item.kind))
    && organization.template === 'tenant'
    && page.path === '/links'
    && typeof page.title === 'string'
    && value.items.every(item =>
      isRecord(item)
      && typeof item.id === 'string'
      && typeof item.label === 'string'
      && typeof item.destination === 'string'
      && item.status === 'active',
    )
    && Array.isArray(value.localeRepresentations)
    && value.localeRepresentations.every(item => isRecord(item)
      && typeof item.locale === 'string'
      && typeof item.label === 'string'
      && typeof item.route_path === 'string'
      && (item.source === 'source' || item.source === 'localized'))
}

export function isPublicLinksResponse(value: unknown): value is PublicLinksResponse {
  return isRecord(value) && value.success === true && isPublicLinksPayload(value)
}
