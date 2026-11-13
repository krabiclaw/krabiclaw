import { platformLocale } from '~/shared/platform-locales'
import { parseOpeningHours, parseSpecialHours, type OpeningHours, type SpecialHours } from '~/shared/reservation-hours'
import type { OrganizationVertical } from '~/utils/vertical-copy'
import { queryAll, queryFirst, type BatchQuery } from '~/server/db'
import { creationRequestHash } from '~/server/utils/organization-events'
import { isCurrencyCode } from '~/shared/currencies'
import { isValidTimezone } from '~/utils/timezone'
import { ALL_VERTICALS } from '~/utils/vertical-copy'
import { getPhoneCountry, toE164 } from '~/utils/phone'
import type { PlaceDetails, PlaceReview } from '~/server/utils/google-places'
import type { CurrencyCode } from '~/shared/currencies'
import type { PriceInput } from '~/shared/prices'
import type { TenantPageBlock, TenantPageType } from '~/utils/tenant-page-blocks'
import { postalAddressFromAnswers, type PostalAddress } from '~/utils/postal-address'
import { HTTPError } from 'nitro'
import { STARTER_PALETTES } from '~/shared/site-palette'
import { isOrganizationFontPreset } from '~/shared/organization-fonts'
import { LOGO_SHAPES } from '~/shared/media-placement-contract'
import type { OnboardingStepId } from '~/shared/onboarding-flow'

type DraftSourceType = 'google_places' | 'manual'
export const ONBOARDING_ORGANIZATION_MARKER = '__krabiclaw_organization_creation_marker'

export interface SavedOnboardingDraft {
  id: string
  user_id: string
  organization_id: string | null
  name: string
  vertical: OrganizationVertical
  subdomain_candidate: string | null
  source_type: DraftSourceType
  status: string
  payload_json: string
  updated_at: string
}

export async function readActiveOnboardingDraft(db: D1Database, userId: string, includeAbandoned = false) {
  const rows = await queryAll<SavedOnboardingDraft>(db,
    "SELECT * FROM onboarding_drafts d WHERE user_id = ? AND (status = 'active' OR (status = 'abandoned' AND EXISTS (SELECT 1 FROM organization WHERE (id = d.organization_id OR json_extract(metadata, ?) = d.id) AND onboarding_status <> 'active'))) ORDER BY created_at, id LIMIT 2", [userId, `$.${ONBOARDING_ORGANIZATION_MARKER}`])
  if (rows.length > 1) throw new HTTPError({ statusCode: 409, statusMessage: 'More than one unfinished website draft needs recovery', data: { code: 'ONBOARDING_DRAFT_CONFLICT', draft_ids: rows.map(row => row.id) } })
  const row = rows[0]
  if (row?.status === 'abandoned' && !includeAbandoned) throw new HTTPError({ statusCode: 409, statusMessage: 'Website draft cleanup is incomplete. Retry discarding this draft.', data: { code: 'ONBOARDING_DRAFT_DISCARD_INCOMPLETE', draft_id: row.id, organization_id: row.organization_id } })
  return row ?? null
}

/** The batch must still belong to this unfinished draft revision. */
export function onboardingDraftWriteGuard(draft: Pick<SavedOnboardingDraft, 'id' | 'user_id' | 'updated_at'>, organizationId?: string): BatchQuery {
  return {
    query: `SELECT CASE WHEN EXISTS (
      SELECT 1 FROM onboarding_drafts d WHERE d.id = ? AND d.user_id = ? AND d.status = 'active' AND d.updated_at = ?
        ${organizationId ? "AND d.organization_id = ? AND EXISTS (SELECT 1 FROM organization o WHERE o.id = d.organization_id AND o.onboarding_status IN ('pending', 'failed') AND NOT EXISTS (SELECT 1 FROM bookings WHERE organization_id = o.id))" : ''}
    ) THEN NULL ELSE json('Onboarding draft revision changed') END`,
    params: [draft.id, draft.user_id, draft.updated_at, ...(organizationId ? [organizationId] : [])],
  }
}

export interface DraftBrandInput {
  /** A starter palette id; the site wears the default colors until one is chosen. */
  palette_starter: string | null
  font_preset: string | null
  /** How the uploaded logo is shown: original, square or circle. */
  logo_shape: string | null
  logo_note: string | null
  logo_preview_url: string | null
  hero_photo_note: string | null
  hero_preview_url: string | null
  hero_headline: string | null
  hero_subtitle: string | null
  logo_image: DraftUploadedImage | null
  hero_image: DraftUploadedImage | null
}

export interface DraftUploadedImage {
  asset_id: string
  cloudflare_image_id: string
  public_url: string
  thumbnail_url: string | null
  mime_type: string | null
  file_name: string | null
  file_size: number | null
}

export interface DraftLocationRecord {
  id: string
  slug: string
  title: string
  address: PostalAddress | null
  description: string | null
  phone: string | null
  website_url: string | null
  opening_hours: OpeningHours
  special_hours: SpecialHours
  rating: number | null
  review_count: number | null
  status: 'active'
}

/**
 * A Product the owner named on the onboarding products step.
 *
 * Expressed the way the catalog stores it: the Product belongs to the
 * organization, `collection` is the grouping the site presents it in, and the
 * price belongs to the variant a customer buys. A blank price stays absent —
 * a zero would be a price the owner never named.
 */
export interface DraftProductRecord {
  id: string
  location_id: string
  collection: string
  name: string
  slug: string
  description: string
  /** Absent when the owner has not priced it yet: the variant carries no price row. */
  price: PriceInput | null
  order_url: string | null
  sort_order: number
  source: 'import'
}

export interface DraftReviewRecord extends PlaceReview {
  id: string
  title: string | null
  owner_reply: string | null
  owner_reply_at: string | null
  source: string | null
  created_at: string | null
}

export interface DraftQaRecord {
  id: string
  question: string
  answer: string
  answer_author: string
  sort_order: number
}

export interface DraftContentRecord {
  page: string
  field: string
  content: string | null
  value: string | null
  type: string
  hero_title: string | null
  hero_subtitle: string | null
  updated_at: string
  // Not populated by this module's own parser today (no draft content record
  // carries a resolved media asset yet) — declared so commit.post.ts's
  // per-field image-block attachment logic, which already treats it as
  // possibly absent, type-checks against the real shape it reads.
  id?: string
  asset_id?: string | null
}

export function firstMenuSetupApplies(payload: OnboardingDraftPayload): boolean {
  return payload.preview.vertical === 'restaurant' && payload.preview.products.length === 0
}

export interface OnboardingDraftPayload {
  version: 3
  partial?: false
  timezone_step_visited?: boolean
  first_menu_section_id?: string
  first_menu_location_id?: string
  first_menu_skips?: { dish_id: string; price?: true; photo?: true; description?: true }
  first_experience_photo_skipped?: string
  first_experience_venue_address?: {
    product_id: string
    location_id: string
    partial?: { location_revision: string; values: Record<string, string> }
  }
  first_practice_area_meeting?: { product_id: string; format: string }
  first_practice_area_attorney?: { product_id: string; member_id: string }
  first_practice_area_progress?: {
    product_id: string
    profile_member_id?: string
    hours_member_id?: string
    office_address_location_id?: string
    partial?: Partial<Record<'office-address' | 'hours' | 'office-times', {
      scope_id: string
      values: Record<string, string>
    }>>
  }
  request?: { key: string; fingerprint: string }
  source: {
    type: DraftSourceType
    /** The Google place the owner picked; null on a manual draft. */
    placeId: string | null
    place: PlaceDetailsSnapshot | null
    details: DraftDetailsInput
  }
  preview: {
    brandName: string
    vertical: OrganizationVertical
    subdomainCandidate: string
    config: Record<string, string | null>
    media: Array<{ slot: 'logo' | 'hero'; asset: DraftUploadedImage }>
    locations: DraftLocationRecord[]
    products: DraftProductRecord[]
    reviews: DraftReviewRecord[]
    qa: DraftQaRecord[]
    content: DraftContentRecord[]
    locales: Array<{ code: string; label: string; is_source: boolean }>
  }
}

export type StoredOnboardingDraftPayload = OnboardingDraftPayload | (Omit<OnboardingDraftPayload, 'partial' | 'preview'> & {
  partial: true
  paused_step?: OnboardingStepId
  preview: OnboardingDraftPayload['preview'] | null
  /** Unfinished address text while the existing preview keeps its own address. */
  subdomain_answer?: string | null
})

function defaultProductCategory(vertical: OrganizationVertical): string {
  if (vertical === 'experience') return 'Experiences'
  if (vertical === 'restaurant') return 'Menu'
  throw new HTTPError({ statusCode: 400, statusMessage: 'This business type adds its offerings after website setup' })
}

export function onboardingPagePath(page: string): string {
  if (page === 'home') return '/'
  if (page === 'privacy') return '/policies/privacy'
  if (page === 'terms') return '/policies/terms'
  return `/${page}`
}

export function onboardingPageType(page: string): TenantPageType {
  if (page === 'privacy' || page === 'terms') return 'legal'
  if (page === 'home' || page === 'about' || page === 'contact') return 'system'
  return 'recipe'
}

// One mapping from draft content rows to tenant-page blocks. The draft preview
// renders these blocks and commit persists them, so the preview is exactly the
// page the tenant will get.
export function onboardingPageBlocks(rows: DraftContentRecord[]): TenantPageBlock[] {
  const blocks: TenantPageBlock[] = []
  for (const row of rows) {
    if (row.field === 'hero') {
      // `hero_title` is the only source of a hero's headline: buildDraftContent
      // writes the owner's answer there and leaves `content` null on that row.
      blocks.push({ id: row.id ?? crypto.randomUUID(), type: 'hero', position: blocks.length, data: { title: row.hero_title, subtitle: row.hero_subtitle }, media: [] })
    } else if (row.type === 'media' || row.field.endsWith('.image')) {
      if (row.asset_id) {
        const type = row.field.endsWith('.image') ? 'image' : 'gallery'
        blocks.push({ id: row.id ?? crypto.randomUUID(), type, position: blocks.length, data: { field: row.field }, media: [] })
      }
    } else if (row.content?.trim()) {
      const type = row.field.endsWith('.title') || row.field.endsWith('.headline') ? 'heading' : 'markdown'
      blocks.push({ id: row.id ?? crypto.randomUUID(), type, position: blocks.length, data: type === 'heading' ? { field: row.field, text: row.content, level: 2 } : { field: row.field, markdown: row.content }, media: [] })
    }
  }
  return blocks
}

export function getDraftMedia(payload: StoredOnboardingDraftPayload, slot: 'logo' | 'hero') {
  return payload.preview?.media.find(item => item.slot === slot)?.asset ?? null
}

export interface OnboardingDraftUpsertResult {
  updatedAt: string
  id: string
}

export interface DraftDetailsInput {
  name: string
  /**
   * The address one field per answer, which is also how a location stores it.
   * The draft used to persist a single composed line, and resume read it back
   * into the street field — so an owner returning to a saved draft found their
   * street address reading "United States".
   */
  street_address: string | null
  address_line_2: string | null
  city: string | null
  region: string | null
  postal_code: string | null
  /**
   * ISO 3166-1 alpha-2, as the owner answered it on the location step. Stored
   * in its own right rather than read back off the phone number: the location
   * step saves before the contact step, so a resumed draft would otherwise fall
   * back to the product default and validate a non-US number against the US
   * numbering plan.
   */
  country: string | null
  phone: string | null
  website_url: string | null
  opening_hours: OpeningHours
  special_hours: SpecialHours
  timezone: string | null
  currency: CurrencyCode | null
  source_locale: string | null
}

export interface PlaceDetailsSnapshot {
  placeId: string
  name: string
  address: PostalAddress | null
  phone: string | null
  mapsUrl: string | null
  websiteUrl: string | null
  rating: number | null
  ratingCount: number | null
  openingHours: OpeningHours
  timezone: string | null
  reviews: PlaceReview[]
}

export function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function onboardingSubdomainCandidate(name: string) {
  return slugify(name.normalize('NFKD').replace(/\p{M}/gu, '')).slice(0, 40).replace(/-+$/, '')
}

export function isOnboardingSubdomain(value: string) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
}

function nowIso() {
  return new Date().toISOString()
}

type DraftPlaceSource = PlaceDetails | PlaceDetailsSnapshot

function asPlaceSnapshot(place: DraftPlaceSource): PlaceDetailsSnapshot {
  return {
    placeId: place.placeId,
    name: place.name,
    address: place.address,
    phone: place.phone ?? null,
    mapsUrl: place.mapsUrl ?? null,
    websiteUrl: place.websiteUrl ?? null,
    rating: place.rating ?? null,
    ratingCount: place.ratingCount ?? null,
    openingHours: place.openingHours ?? null,
    timezone: place.timezone,
    reviews: place.reviews,
  }
}

function buildDraftContent(
  _brandName: string,
  _vertical: OrganizationVertical,
  hero_headline: string | null,
  hero_subtitle: string | null,
): DraftContentRecord[] {
  if (!hero_headline && !hero_subtitle) return []
  return [{
    page: 'home',
    field: 'hero',
    content: null,
    value: null,
    type: 'text',
    hero_title: hero_headline,
    hero_subtitle: hero_subtitle,
    updated_at: nowIso(),
  }]
}

/** What the owner typed on the products step, before it becomes a draft row. */
export interface DraftProductInput {
  name: string
  category: string
  /** null when the owner left the price blank. `products` requires no price. */
  unit_amount: number | null
}

export function buildOnboardingDraftPayload(input: {
  name: string
  vertical: OrganizationVertical
  details: DraftDetailsInput
  place: DraftPlaceSource | null
  brandDraft?: DraftBrandInput | null
  products?: DraftProductInput[] | null
}): OnboardingDraftPayload {
  if (input.products?.length && input.vertical !== 'restaurant' && input.vertical !== 'experience') throw new HTTPError({ statusCode: 400, statusMessage: 'This business type adds its offerings after website setup' })
  const source_locale = input.details.source_locale ? platformLocale(input.details.source_locale) : null
  if (!source_locale) throw new HTTPError({ statusCode: 400, statusMessage: 'Choose a supported website language' })
  const brandName = input.details.name || input.name
  const subdomainCandidate = onboardingSubdomainCandidate(brandName)
  const placeSnapshot = input.place ? asPlaceSnapshot(input.place) : null
  // No stock photo fallback here: a generic stock image isn't actually theirs, and the
  // Saya hero renders a brand-color + icon treatment when no real photo is available yet.
  const uploadedHero = input.brandDraft?.hero_image ?? null
  const uploadedLogo = input.brandDraft?.logo_image ?? null
  // A tenant's first location is 'main' everywhere else — seedNewOrganization creates it
  // under that slug and seeds its page at /locations/main. Deriving a slug from
  // the brand name here renamed the location out from under that page, leaving
  // every onboarded site serving 200 "Location Not Found" at /locations/main.
  // Later locations get their own slugs when the location record is created.
  const locationSlug = 'main'
  const locationId = 'draft-location-main'

  const description = null
  const products: DraftProductRecord[] = (input.products ?? []).map((product, index) => {
    const name = product.name.trim()
    const collection = product.category.trim() || defaultProductCategory(input.vertical)
    return {
      id: `draft-product-${slugify(name) || index}`,
      location_id: locationId,
      collection,
      name,
      slug: slugify(name) || `item-${index + 1}`,
      description: '',
      // No currency of its own when the onboarding details carry none: the
      // price is normalized against the site's currency, and hardcoding USD
      // here overrode what the tenant actually sells in.
      price: product.unit_amount === null
        ? null
        : { unit_amount: product.unit_amount, ...(input.details.currency ? { currency: input.details.currency } : {}) },
      order_url: null,
      sort_order: index,
      source: 'import' as const,
    }
  })

  const reviews = (placeSnapshot?.reviews ?? []).map(review => ({
    ...review,
    id: `draft-review-${review.google_review_id.replace(/\//g, '-')}`,
    title: null, owner_reply: null, owner_reply_at: null,
    source: 'google_places', created_at: review.original_review_date,
  }))

  const qa: DraftQaRecord[] = []

  const palette_starter = input.brandDraft?.palette_starter ?? null
  if (palette_starter !== null && !STARTER_PALETTES.some(starter => starter.id === palette_starter)) throw new HTTPError({ statusCode: 400, statusMessage: 'Unknown starter palette' })
  const font_preset = input.brandDraft?.font_preset ?? null
  if (font_preset !== null && !isOrganizationFontPreset(font_preset)) throw new HTTPError({ statusCode: 400, statusMessage: 'Unsupported website font' })
  const logo_shape = input.brandDraft?.logo_shape ?? null
  if (logo_shape !== null && !(LOGO_SHAPES as readonly string[]).includes(logo_shape)) throw new HTTPError({ statusCode: 400, statusMessage: 'Unsupported logo shape' })
  const hero_headline = input.brandDraft?.hero_headline?.trim() || null
  const hero_subtitle = input.brandDraft?.hero_subtitle?.trim() || null
  const content = buildDraftContent(brandName, input.vertical, hero_headline, hero_subtitle)

  return {
    version: 3,
    source: {
      type: placeSnapshot ? 'google_places' : 'manual',
      placeId: placeSnapshot?.placeId ?? null,
      place: placeSnapshot,
      details: input.details,
    },
    preview: {
      brandName,
      vertical: input.vertical,
      subdomainCandidate,
      config: {
        palette_starter: palette_starter,
        font_preset: font_preset,
        logo_shape: logo_shape,
        draft_logo_note: input.brandDraft?.logo_note?.trim() || null,
        draft_hero_photo_note: input.brandDraft?.hero_photo_note?.trim() || null,
        draft_hero_headline: hero_headline,
        draft_hero_subtitle: hero_subtitle,
      },
      media: [
        ...(uploadedLogo ? [{ slot: 'logo' as const, asset: uploadedLogo }] : []),
        ...(uploadedHero ? [{ slot: 'hero' as const, asset: uploadedHero }] : []),
      ],
      locations: [{
        id: locationId,
        slug: locationSlug,
        title: brandName,
        address: postalAddressFromAnswers({ ...input.details, streetAddress: input.details.street_address, addressLine2: input.details.address_line_2, postalCode: input.details.postal_code }),
        description,
        phone: input.details.phone ?? placeSnapshot?.phone ?? null,
        website_url: input.details.website_url ?? placeSnapshot?.websiteUrl ?? null,
        opening_hours: input.details.opening_hours,
        special_hours: input.details.special_hours,
        rating: placeSnapshot?.rating ?? null,
        review_count: placeSnapshot?.ratingCount ?? null,

      status: 'active',
      }],
      products,
      reviews,
      qa,
      content,
      locales: [{ code: source_locale.locale, label: source_locale.label, is_source: true }],
    },
  }
}

/**
 * Reads a stored draft. Version 2 drafts predate `source.placeId`; they carry
 * the same identity on their place snapshot, so they restore as version 3 and
 * an owner part-way through onboarding at deployment keeps their draft.
 */
export function parseStoredOnboardingDraftPayload(raw: string): StoredOnboardingDraftPayload {
  const parsed = JSON.parse(raw) as StoredOnboardingDraftPayload | (Omit<OnboardingDraftPayload, 'version'> & { version: 2 })
  if (!parsed || (parsed.version !== 2 && parsed.version !== 3) || !parsed.source
    || (!parsed.partial && !parsed.preview)
    || (parsed.preview && (!Array.isArray(parsed.preview.media) || !Array.isArray(parsed.preview.products)))) {
    throw new Error('Unsupported onboarding draft payload')
  }
  const placeId = parsed.version === 3 ? parsed.source.placeId : parsed.source.place?.placeId ?? null
  if (parsed.source.type === 'google_places' ? !placeId : placeId !== null || parsed.source.place !== null) {
    throw new Error(`Onboarding draft source does not match its ${parsed.source.type} type`)
  }
  const payload: StoredOnboardingDraftPayload = { ...parsed, version: 3, source: { ...parsed.source, placeId } }
  if (!payload.partial) {
    const source = payload.preview.locales.filter(locale => locale.is_source)
    if (source.length !== 1 || !platformLocale(source[0]!.code)) throw new Error('Onboarding primary language is unavailable')
    payload.source.details.source_locale ??= source[0]!.code
    if (payload.source.details.source_locale !== source[0]!.code) throw new Error('Onboarding primary language is inconsistent')
  }
  payload.source.details.opening_hours = parseOpeningHours(payload.source.details.opening_hours)
  payload.source.details.special_hours = parseSpecialHours(payload.source.details.special_hours)
  if (payload.source.place) payload.source.place.openingHours = parseOpeningHours(payload.source.place.openingHours)
  for (const location of payload.preview?.locations ?? []) {
    location.opening_hours = parseOpeningHours(location.opening_hours)
    location.special_hours = parseSpecialHours(location.special_hours)
  }
  return payload
}

export function parseOnboardingDraftPayload(raw: string): OnboardingDraftPayload {
  const payload = parseStoredOnboardingDraftPayload(raw)
  if (payload.partial) throw new Error('Website draft has not completed setup')
  return payload
}

export interface OnboardingDraftInput {
  draft_id?: string
  updated_at?: string | null
  idempotency_key?: string
  source_type?: unknown
  google_place_id?: unknown
  vertical?: unknown
  name?: unknown
  subdomain?: unknown
  details?: Record<string, unknown> | null
  brand_draft?: Record<string, unknown> | null
  products?: unknown
  partial?: boolean
  timezone_step_visited?: boolean
  paused_step?: OnboardingStepId
}

function answer(raw: Record<string, unknown> | null | undefined, field: string, existing: string | null = null): string | null {
  const value = raw?.[field]
  if (value === undefined) return existing
  if (value === null) return null
  if (typeof value !== 'string') throw new HTTPError({ statusCode: 400, statusMessage: `${field} must be text` })
  return value.trim() || null
}

function draftImage(raw: unknown, existing: DraftUploadedImage | null): DraftUploadedImage | null {
  if (raw === undefined) return existing
  if (raw === null) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HTTPError({ statusCode: 400, statusMessage: 'Invalid draft image' })
  const image = raw as Record<string, unknown>
  const asset_id = answer(image, 'asset_id')
  const cloudflare_image_id = answer(image, 'cloudflare_image_id')
  const public_url = answer(image, 'public_url')
  if (!asset_id || !cloudflare_image_id || !public_url) throw new HTTPError({ statusCode: 400, statusMessage: 'Draft image identity and URL are required' })
  return { asset_id, cloudflare_image_id, public_url, thumbnail_url: answer(image, 'thumbnail_url'), mime_type: answer(image, 'mime_type'), file_name: answer(image, 'file_name'), file_size: typeof image.file_size === 'number' ? image.file_size : null }
}

export function normalizeOnboardingDraftInput(input: OnboardingDraftInput, existingRow: Pick<SavedOnboardingDraft, 'vertical' | 'organization_id' | 'subdomain_candidate'> | null, existing: StoredOnboardingDraftPayload | null, sourceType: DraftSourceType, placeId: string | null, place: DraftPlaceSource | null) {
  if (input.details !== undefined && input.details !== null && (typeof input.details !== 'object' || Array.isArray(input.details))) throw new HTTPError({ statusCode: 400, statusMessage: 'Business details must be an object' })
  if (input.brand_draft !== undefined && input.brand_draft !== null && (typeof input.brand_draft !== 'object' || Array.isArray(input.brand_draft))) throw new HTTPError({ statusCode: 400, statusMessage: 'Brand details must be an object' })
  const raw = input.details
  const previous = existing?.source.details
  const savedPlaceDetails = existing?.source.placeId === placeId ? previous : undefined
  const name = answer(raw, 'name', answer({ name: input.name }, 'name', savedPlaceDetails?.name ?? place?.name ?? previous?.name)) ?? ''
  const vertical = (input.vertical ?? existingRow?.vertical) as OrganizationVertical
  if ((!input.partial && !name) || !ALL_VERTICALS.includes(vertical)) throw new HTTPError({ statusCode: 400, statusMessage: 'Business name and type are required', data: { code: 'ONBOARDING_INCOMPLETE', missing_fields: [...(!name ? ['name'] : []), ...(!ALL_VERTICALS.includes(vertical) ? ['vertical'] : [])] } })
  const source_locale = answer(raw, 'source_locale', previous?.source_locale)
  if (source_locale ? !platformLocale(source_locale) : !input.partial) throw new HTTPError({ statusCode: 400, statusMessage: 'Choose a supported website language', data: { code: 'ONBOARDING_INCOMPLETE', missing_fields: ['source_locale'] } })
  const savedLocale = existing?.preview?.locales.find(locale => locale.is_source)?.code
  if (existingRow?.organization_id && savedLocale && source_locale !== savedLocale) throw new HTTPError({ statusCode: 409, statusMessage: 'Existing draft content cannot be relabelled into another language', data: { code: 'ONBOARDING_LANGUAGE_LOCKED' } })
  const country = answer(raw, 'country', previous?.country)?.toUpperCase() ?? null
  if (country && !getPhoneCountry(country)) throw new HTTPError({ statusCode: 400, statusMessage: 'country must be an ISO 3166-1 alpha-2 code' })
  const currency = answer(raw, 'currency', previous?.currency)?.toUpperCase() ?? null
  if (currency && !isCurrencyCode(currency)) throw new HTTPError({ statusCode: 400, statusMessage: 'Choose a supported currency' })
  const timezone = answer(raw, 'timezone', savedPlaceDetails?.timezone ?? place?.timezone)
  if (timezone && !isValidTimezone(timezone)) throw new HTTPError({ statusCode: 400, statusMessage: 'Choose a valid IANA timezone' })
  const savedProviderDetails = place && !existing?.source.place ? undefined : savedPlaceDetails
  const phone = answer(raw, 'phone', savedProviderDetails ? savedProviderDetails.phone : place?.phone ?? null)
  const openingHours = savedProviderDetails ? savedProviderDetails.opening_hours : place?.openingHours ?? null
  const phoneE164 = phone ? toE164(phone) : null
  if (phone && !phoneE164) throw new HTTPError({ statusCode: 400, statusMessage: 'Enter a valid phone number with its country calling code' })
  const details: DraftDetailsInput = {
    name, source_locale, country, currency: currency as CurrencyCode | null, timezone, phone: phoneE164,
    street_address: answer(raw, 'street_address', previous?.street_address), address_line_2: answer(raw, 'address_line_2', previous?.address_line_2),
    city: answer(raw, 'city', previous?.city), region: answer(raw, 'region', previous?.region), postal_code: answer(raw, 'postal_code', previous?.postal_code),
    website_url: answer(raw, 'website_url', savedProviderDetails ? savedProviderDetails.website_url : place?.websiteUrl ?? null),
    opening_hours: parseOpeningHours(raw?.opening_hours === undefined ? openingHours : raw.opening_hours),
    special_hours: parseSpecialHours(raw?.special_hours === undefined ? savedPlaceDetails?.special_hours ?? null : raw.special_hours),
  }
  const previousPreview = existing?.preview
  const timezone_step_visited = input.timezone_step_visited ?? existing?.timezone_step_visited
  const savedSubdomain = existing?.partial && previousPreview && !existingRow?.organization_id
    ? existing.subdomain_answer ?? null
    : existingRow?.subdomain_candidate ?? null
  const typedSubdomain = input.subdomain === undefined ? savedSubdomain : input.subdomain
  if (typedSubdomain !== null && typeof typedSubdomain !== 'string') throw new HTTPError({ statusCode: 400, statusMessage: 'subdomain must be text', data: { code: 'INVALID_SUBDOMAIN' } })
  if (input.partial) {
    if (input.brand_draft !== undefined || input.products !== undefined || input.idempotency_key !== undefined) throw new HTTPError({ statusCode: 400, statusMessage: 'Save website content after completing setup', data: { code: 'ONBOARDING_INCOMPLETE' } })
    const payload: StoredOnboardingDraftPayload = {
      version: 3,
      partial: true,
      paused_step: input.paused_step,
      timezone_step_visited,
      source: {
        type: sourceType, placeId, details,
        place: existing?.source.place?.placeId === placeId ? existing.source.place : null,
      },
      preview: previousPreview ?? null,
      ...(previousPreview && !existingRow?.organization_id ? { subdomain_answer: typedSubdomain } : {}),
    }
    return { name, vertical, payload, subdomain: previousPreview ? existingRow?.subdomain_candidate ?? null : typedSubdomain }
  }
  const products: DraftProductInput[] = input.products === undefined
    ? (previousPreview?.vertical === vertical ? previousPreview.products : []).map(product => ({ name: product.name, category: product.collection, unit_amount: product.price?.unit_amount ?? null }))
    : (() => {
        if (!Array.isArray(input.products)) throw new HTTPError({ statusCode: 400, statusMessage: 'products must be an array' })
        return input.products.map((value, index) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HTTPError({ statusCode: 400, statusMessage: `Product ${index + 1} is invalid` })
          const product = value as Record<string, unknown>
          const productName = answer(product, 'name')
          const amount = product.unit_amount
          if (!productName || (amount !== undefined && amount !== null && (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0))) throw new HTTPError({ statusCode: 400, statusMessage: `Product ${index + 1} requires a name and a valid price when supplied` })
          return { name: productName, category: answer(product, 'category') ?? '', unit_amount: typeof amount === 'number' ? amount : null }
        })
      })()
  const brand = input.brand_draft
  const config = previousPreview?.config
  const previousHeadline = config?.draft_hero_headline ?? previousPreview?.content.find(content => content.page === 'home' && content.field === 'hero')?.hero_title
  const brandDraft: DraftBrandInput = {
    palette_starter: answer(brand, 'palette_starter', config?.palette_starter), font_preset: answer(brand, 'font_preset', config?.font_preset),
    logo_shape: answer(brand, 'logo_shape', config?.logo_shape), logo_note: answer(brand, 'logo_note', config?.draft_logo_note),
    logo_preview_url: answer(brand, 'logo_preview_url'), hero_photo_note: answer(brand, 'hero_photo_note', config?.draft_hero_photo_note), hero_preview_url: answer(brand, 'hero_preview_url'),
    hero_headline: answer(brand, 'hero_headline', previousHeadline && previousHeadline !== previousPreview?.brandName ? previousHeadline : name) ?? name, hero_subtitle: answer(brand, 'hero_subtitle', config?.draft_hero_subtitle),
    logo_image: draftImage(brand?.logo_image, existing ? getDraftMedia(existing, 'logo') : null),
    hero_image: draftImage(brand?.hero_image, existing ? getDraftMedia(existing, 'hero') : null),
  }
  const payload = buildOnboardingDraftPayload({ name, vertical, place, details, brandDraft, products })
  const subdomain = (typedSubdomain ?? savedSubdomain)?.trim().toLowerCase() || payload.preview.subdomainCandidate
  if (!isOnboardingSubdomain(subdomain)) throw new HTTPError({ statusCode: 400, statusMessage: 'Choose a website address using Latin letters, digits or hyphens', data: { missing_fields: ['subdomain'] } })
  payload.preview.subdomainCandidate = subdomain
  payload.timezone_step_visited = timezone_step_visited
  return { name, vertical, payload, subdomain }
}

export function onboardingPublicationMissingFields(draft: Pick<SavedOnboardingDraft, 'subdomain_candidate'>, payload: StoredOnboardingDraftPayload) {
  const details = payload.source.details
  return [
    ...(!details.name ? ['name'] : []),
    ...(!details.source_locale || !platformLocale(details.source_locale) ? ['source_locale'] : []),
    ...(!details.currency ? ['currency'] : []),
    ...(!isValidTimezone(details.timezone) ? ['timezone'] : []),
    ...(!draft.subdomain_candidate || !isOnboardingSubdomain(draft.subdomain_candidate) ? ['subdomain'] : []),
  ]
}

export async function readOnboardingDraft(db: D1Database, userId: string, draftId?: string) {
  const draft = draftId
    ? await queryFirst<SavedOnboardingDraft>(db, 'SELECT * FROM onboarding_drafts WHERE id = ? AND user_id = ?', [draftId, userId])
    : await readActiveOnboardingDraft(db, userId)
  if (!draft) throw new HTTPError({ statusCode: 404, statusMessage: 'Website draft not found' })
  if (draft.status === 'abandoned') throw new HTTPError({ statusCode: 409, statusMessage: 'This website draft was discarded', data: { code: 'ONBOARDING_DRAFT_ABANDONED', draft_id: draft.id } })
  return { row: draft, payload: parseStoredOnboardingDraftPayload(draft.payload_json) }
}

export async function upsertActiveOnboardingDraft(db: D1Database, input: {
  userId: string
  organizationId?: string | null
  name: string
  vertical: OrganizationVertical
  sourceType: DraftSourceType
  payload: StoredOnboardingDraftPayload
  subdomain?: string | null
  updated_at: string | null
  draftId?: string
  idempotencyKey?: string
}): Promise<OnboardingDraftUpsertResult> {
  const existing = await readActiveOnboardingDraft(db, input.userId)
  const key = input.idempotencyKey?.trim()
  if (input.idempotencyKey !== undefined && (!key || key.length > 200)) throw new HTTPError({ statusCode: 400, statusMessage: 'idempotency_key must contain 1 to 200 characters' })
  const id = input.draftId ?? (key ? `mcp-website-${await creationRequestHash({ userId: input.userId, key })}` : crypto.randomUUID())
  const keyed = key ? await queryFirst<SavedOnboardingDraft>(db, 'SELECT * FROM onboarding_drafts WHERE id = ? AND user_id = ?', [id, input.userId]) : null
  const preview = input.payload.preview
  const fingerprint = await creationRequestHash({ ...input.payload, request: undefined, preview: preview ? { ...preview, content: preview.content.map(content => ({ ...content, updated_at: undefined })) } : null })
  if (keyed && input.updated_at === null) {
    const saved = parseStoredOnboardingDraftPayload(keyed.payload_json)
    if (!saved.request || saved.request.key !== key || saved.request.fingerprint !== fingerprint) throw new HTTPError({ statusCode: 409, statusMessage: 'This idempotency key was already used for different website answers', data: { code: 'IDEMPOTENCY_KEY_CONFLICT', draft_id: keyed.id } })
    if (keyed.status === 'abandoned') throw new HTTPError({ statusCode: 409, statusMessage: 'This website draft was discarded', data: { code: 'ONBOARDING_DRAFT_ABANDONED', draft_id: keyed.id } })
    return { id: keyed.id, updatedAt: keyed.updated_at }
  }
  if (existing && input.draftId !== existing.id) throw new HTTPError({ statusCode: 409, statusMessage: 'Resume your saved website draft before creating another', data: { code: 'ONBOARDING_DRAFT_EXISTS', draft_id: existing.id } })
  if (input.draftId && !existing) throw new HTTPError({ statusCode: 404, statusMessage: 'Active website draft not found' })
  if ((existing?.updated_at ?? null) !== input.updated_at) throw new HTTPError({ statusCode: 409, statusMessage: 'Website draft changed; reload before saving', data: { code: 'ONBOARDING_DRAFT_CHANGED', draft_id: existing?.id } })
  const subdomain = input.subdomain === undefined ? existing?.subdomain_candidate ?? null : input.subdomain
  if (existing?.organization_id && subdomain !== existing.subdomain_candidate) {
    const organization = await queryFirst<{ subdomain: string | null; onboarding_status: string }>(db, 'SELECT subdomain, onboarding_status FROM organization WHERE id = ?', [existing.organization_id])
    if (!organization || organization.subdomain !== null || !['pending', 'failed'].includes(organization.onboarding_status)) throw new HTTPError({ statusCode: 409, statusMessage: 'A saved draft already owns its website address' })
  }
  const savedRequest = existing ? parseStoredOnboardingDraftPayload(existing.payload_json).request : null
  if (key && savedRequest && savedRequest.key !== key) throw new HTTPError({ statusCode: 409, statusMessage: 'This draft belongs to a different idempotency key', data: { code: 'IDEMPOTENCY_KEY_CONFLICT', draft_id: existing?.id } })
  const payload = input.payload
  if (key || savedRequest) payload.request = { key: key ?? savedRequest!.key, fingerprint }
  const payloadJson = JSON.stringify(payload)
  const now = new Date(Math.max(Date.now(), existing ? Date.parse(existing.updated_at) + 1 : 0)).toISOString()
  const draft = await queryFirst<{ id: string; updated_at: string }>(db, existing ? `
    UPDATE onboarding_drafts SET name = ?, vertical = ?, subdomain_candidate = ?, source_type = ?, payload_json = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND status = 'active' AND updated_at = ?
      AND (organization_id IS NULL OR subdomain_candidate IS ? OR EXISTS (
        SELECT 1 FROM organization o WHERE o.id = onboarding_drafts.organization_id
          AND o.subdomain IS NULL AND o.onboarding_status IN ('pending', 'failed')
      ))
    RETURNING id, updated_at
  ` : `INSERT INTO onboarding_drafts
    (id, user_id, organization_id, name, vertical, subdomain_candidate, source_type, status, payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT DO NOTHING
    RETURNING id, updated_at
  `, existing ? [input.name, input.vertical, subdomain, input.sourceType, payloadJson, now, existing.id, input.userId, input.updated_at, subdomain] : [id, input.userId, input.organizationId ?? null, input.name, input.vertical, subdomain, input.sourceType, payloadJson, now, now])
  if (!draft) throw new HTTPError({ statusCode: 409, statusMessage: 'Website draft changed; read it before retrying', data: { code: 'ONBOARDING_DRAFT_CHANGED' } })
  return { id: draft.id, updatedAt: draft.updated_at }
}
