// Site management types

import type { DomainStatus } from '~/server/utils/domains'
import type { CurrencyCode } from '~/shared/currencies'
import type { OrganizationFontPreset } from '~/shared/organization-fonts'
import type { SitePalette, SitePalettePatch } from '~/shared/site-palette'
import type { LogoPresentation } from '~/shared/media-placement-contract'
import type { PublicCompliance } from '~/types/blawby'

export type { CurrencyCode }

/**
 * The one universal announcement modal, available to every theme. An image comes through `media`
 * (slot `announcement`), never a URL stored here. `enabled: false` or a missing config both mean
 * nothing shows; the CMS writes `null` to remove it entirely rather than leaving stale content off.
 */
export interface OrganizationAnnouncement {
  headline: string
  description: string | null
  cta_label: string | null
  cta_url: string | null
  dismissible: boolean
  enabled: boolean
}

export interface OrganizationSettings {
  id: string
  organization_id: string
  subdomain: string
  theme: string
  status: 'active' | 'inactive' | 'suspended'
  public_url: string | null
  custom_domain_status: DomainStatus | 'none'
  name: string
  brand_description: string | null
  announcement: OrganizationAnnouncement | null
  media: Array<{ asset_id: string; slot: string; public_url: string | null; thumbnail_url: string | null; kind: string; presentation?: LogoPresentation | null }>
  contact_email: string | null
  address_visibility?: PublicCompliance['address_visibility']
  /** What the site renders: its own palette, or its template's. Null on the platform template, whose palette is fixed. */
  palette: SitePalette | null
  palette_source: 'custom' | 'template' | null
  font_preset: OrganizationFontPreset
  default_currency: CurrencyCode
  /** The business's reporting clock: the day boundaries of its analytics. */
  timezone: string
  google_analytics_measurement_id?: string
  created_at: string
  updated_at: string
}

export interface UpdateOrganizationSettingsRequest {
  name?: string
  /**
   * The website's publication state, and the only one there is. A tenant moves
   * between 'active' (Live) and 'inactive' (Draft); 'suspended' is Krabiclaw's
   * and is rejected here. server/utils/organization-settings.ts enforces it.
   */
  status?: 'active' | 'inactive'
  brand_description?: string
  // A full replacement of the announcement, or null to remove it entirely. There is no partial
  // patch: the CMS leaf edits every field together, the same way the old banner did.
  announcement?: { headline: string; description?: string | null; cta_label?: string | null; cta_url?: string | null; dismissible?: boolean; enabled?: boolean } | null
  contact_email?: string
  address_visibility?: PublicCompliance['address_visibility']
  /** A starter and/or colors to change, or null to return to the template's palette. */
  palette?: SitePalettePatch | null
  font_preset?: OrganizationFontPreset
  default_currency?: CurrencyCode
  timezone?: string
  press_email?: string
  partnerships_email?: string
  catering_email?: string
  careers_email?: string
  seo_title?: string | null
  seo_description?: string | null
  canonical_url?: string | null
  robots?: string | null
  media?: Array<{ asset_id: string | null; slot: 'logo' | 'logo_dark' | 'favicon' | 'social_share' | 'announcement'; presentation?: LogoPresentation | null }>
}

export interface LaunchReadiness {
  organization_id: string
  overall_ready: boolean
  missing_critical: number
  missing_optional: number
  sections: {
    organization_identity: {
      ready: boolean
      items: {
        name: boolean
        subdomain: boolean
        theme: boolean
        status: boolean
        locations: boolean
      }
    }
    brand_basics: {
      ready: boolean
      items: {
        name: boolean
        description: boolean
        contact_email: boolean
      }
    }
    publishing_status: {
      ready: boolean
      items: {
        organization_active: boolean
        public_url: boolean
        last_published: boolean
      }
    }
    domain_status: {
      ready: boolean
      items: {
        subdomain: boolean
        custom_domain: boolean
      }
    }
    integrations: {
      ready: boolean
      items: {
        google_places_configured: boolean
        locations_imported: boolean
      }
    }
    content_readiness: {
      ready: boolean
      items: {
        homepage_hero: boolean
        products_exist: boolean
        contact_details: boolean
        locations_exist: boolean
        seo_metadata: boolean
      }
    }
  }
  action_items: Array<{
    section: string
    item: string
    priority: 'critical' | 'optional'
    description: string
    action_url?: string
  }>
}
