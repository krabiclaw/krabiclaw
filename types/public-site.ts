// What a customer site's public shell carries beyond its identity: its pages
// for navigation, and — for a legal practice — its consultation settings and the
// compliance details its footer and structured data state.

/** A published page, as the header and footer link to it. */
export interface PublicPageLink {
  id: string
  path: string
  title: string
}

export interface PublicConsultationSettings {
  mode: 'native' | 'external_url' | 'native_disabled'
  cta_label: string
  external_url: string | null
  schedule_path: string
  confirmation_path: string
}

export interface PublicComplianceContactPoint {
  contact_type: string | null
  telephone: string | null
  email: string | null
  area_served: string | null
  available_language: string[] | string | null
  url: string | null
}

export interface PublicCompliance {
  entity_name: string | null
  dba_name: string | null
  entity_type: string | null
  /** Raw stored value — already normalized to a schema.org enum URL (e.g. https://schema.org/Nonprofit501c3) by the canonical write layer. */
  nonprofit_status: string | null
  registration_number: string | null
  service_area: string | null
  /** schema.org areaServed @type, e.g. 'State', 'City', 'Country'. */
  service_area_type: string | null
  disclaimer: string | null
  footer_disclaimer: string | null
  media: Array<{
    asset_id: string
    slot: string
    public_url: string | null
    kind: string | null
    alt_text: string | null
    file_name: string | null
  }>
  founder_name: string | null
  founding_date: string | null
  same_as: string[]
  contact_points: PublicComplianceContactPoint[]
  address_visibility: 'visible' | 'hidden'
}
