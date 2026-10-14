import { platformLocale } from '~/shared/platform-locales'
import { parseOpeningHours, parseSpecialHours, type OpeningHours, type SpecialHours } from '~/shared/reservation-hours'
import type { OrganizationVertical } from '~/utils/vertical-copy'
import { execute, queryAll, queryFirst, type BatchQuery } from '~/server/db'
import { creationRequestHash } from '~/server/utils/organization-events'
import { isCurrencyCode } from '~/shared/currencies'
import { isValidTimezone } from '~/utils/timezone'
import { WEBSITE_DRAFT_VERTICALS } from '~/utils/vertical-copy'
import { getPhoneCountry, parsePhone } from '~/utils/phone'
import type { PlaceDetails, PlaceReview } from '~/server/utils/google-places'
import type { CurrencyCode } from '~/shared/currencies'
import type { PriceInput } from '~/shared/prices'
import type { TenantPageBlock, TenantPageType } from '~/utils/tenant-page-blocks'
import { postalAddressFromAnswers, type PostalAddress } from '~/utils/postal-address'
import { HTTPError } from 'nitro'
import { STARTER_PALETTES } from '~/shared/site-palette'
import { isOrganizationFontPreset } from '~/shared/organization-fonts'
import { LOGO_SHAPES } from '~/shared/media-placement-contract'

type DraftSourceType = 'google_places' | 'manual'
export const ONBOARDING_ORGANIZATION_MARKER = '__krabiclaw_organization_creation_marker'

export interface SavedOnboardingDraft {
  id: string
  user_id: string
  organization_id: string | null
  name: string
  vertical: OrganizationVertical
  subdomain_candidate: string
  source_type: DraftSourceType
  status: string
  payload_json: string
  updated_at: string
}

export async function readActiveOnboardingDraft(db: D1Database, userId: string, includeAbandoned = false) {
  const rows = await queryAll<SavedOnboardingDraft>(db,
    "SELECT * FROM onboarding_drafts d WHERE user_id = ? AND (status IN ('active', 'committing') OR (status = 'abandoned' AND EXISTS (SELECT 1 FROM organization WHERE (id = d.organization_id OR json_extract(metadata, ?) = d.id) AND onboarding_status <> 'active'))) ORDER BY created_at, id LIMIT 2", [userId, `$.${ONBOARDING_ORGANIZATION_MARKER}`])
  if (rows.length > 1) throw new HTTPError({ statusCode: 409, statusMessage: 'More than one unfinished website draft needs recovery', data: { code: 'ONBOARDING_DRAFT_CONFLICT', draft_ids: rows.map(row => row.id) } })
  const row = rows[0]
  if (row?.status === 'abandoned' && !includeAbandoned) throw new HTTPError({ statusCode: 409, statusMessage: 'Website draft cleanup is incomplete. Retry discarding this draft.', data: { code: 'ONBOARDING_DRAFT_DISCARD_INCOMPLETE', draft_id: row.id, organization_id: row.organization_id } })
  if (row?.status === 'committing') {
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(row.updated_at) + 1)).toISOString()
    const restored = await execute(db, "UPDATE onboarding_drafts SET status = 'active', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'committing' AND updated_at = ?", [updatedAt, row.id, userId, row.updated_at])
    if (!restored.meta.changes) throw new HTTPError({ statusCode: 409, statusMessage: 'Website draft changed; retry the same request', data: { code: 'ONBOARDING_DRAFT_CHANGED', draft_id: row.id } })
    return { ...row, status: 'active', updated_at: updatedAt }
  }
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
  /** A starter palette id; the site wears its template's colors until one is chosen. */
  paletteStarter: string | null
  fontPreset: string | null
  /** How the uploaded logo is shown: original, square or circle. */
  logoShape: string | null
  logoNote: string | null
  logoPreviewUrl: string | null
  heroPhotoNote: string | null
  heroPreviewUrl: string | null
  heroHeadline: string | null
  heroSubtitle: string | null
  logoImage: DraftUploadedImage | null
  heroImage: DraftUploadedImage | null
}

export interface DraftUploadedImage {
  draftAssetId: string
  cloudflareImageId: string
  publicUrl: string
  thumbnailUrl: string | null
  mimeType: string | null
  fileName: string | null
  fileSize: number | null
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

export interface OnboardingDraftPayload {
  version: 3
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

function defaultProductCategory(vertical: OrganizationVertical): string {
  if (vertical === 'experience') return 'Experiences'
  if (vertical === 'service') return 'Services'
  return 'Menu'
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

export function getDraftMedia(payload: OnboardingDraftPayload, slot: 'logo' | 'hero') {
  return payload.preview.media.find(item => item.slot === slot)?.asset ?? null
}

export interface OnboardingDraftUpsertResult {
  updatedAt: string
  id: string
  subdomainCandidate: string
  organizationId: string | null
  payload: OnboardingDraftPayload
}

export interface DraftDetailsInput {
  name: string
  /**
   * The address one field per answer, which is also how a location stores it.
   * The draft used to persist a single composed line, and resume read it back
   * into the street field — so an owner returning to a saved draft found their
   * street address reading "United States".
   */
  streetAddress: string | null
  addressLine2: string | null
  city: string | null
  region: string | null
  postalCode: string | null
  /**
   * ISO 3166-1 alpha-2, as the owner answered it on the location step. Stored
   * in its own right rather than read back off the phone number: the location
   * step saves before the contact step, so a resumed draft would otherwise fall
   * back to the product default and validate a non-US number against the US
   * numbering plan.
   */
  country: string | null
  phone: string | null
  websiteUrl: string | null
  openingHours: OpeningHours
  specialHours: SpecialHours
  timezone: string | null
  currency: CurrencyCode | null
  sourceLocale: string | null
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
  heroHeadline: string | null,
  heroSubtitle: string | null,
): DraftContentRecord[] {
  if (!heroHeadline && !heroSubtitle) return []
  return [{
    page: 'home',
    field: 'hero',
    content: null,
    value: null,
    type: 'text',
    hero_title: heroHeadline,
    hero_subtitle: heroSubtitle,
    updated_at: nowIso(),
  }]
}

/** What the owner typed on the products step, before it becomes a draft row. */
export interface DraftProductInput {
  name: string
  category: string
  /** null when the owner left the price blank. `products` requires no price. */
  amountMinor: number | null
}

export function buildOnboardingDraftPayload(input: {
  name: string
  vertical: OrganizationVertical
  details: DraftDetailsInput
  place: DraftPlaceSource | null
  brandDraft?: DraftBrandInput | null
  products?: DraftProductInput[] | null
}): OnboardingDraftPayload {
  const sourceLocale = input.details.sourceLocale ? platformLocale(input.details.sourceLocale) : null
  if (!sourceLocale) throw new HTTPError({ statusCode: 400, statusMessage: 'Choose a supported website language' })
  const brandName = input.details.name || input.name
  const subdomainCandidate = slugify(brandName).slice(0, 40)
  const placeSnapshot = input.place ? asPlaceSnapshot(input.place) : null
  // No stock photo fallback here: a generic stock image isn't actually theirs, and the
  // Saya hero renders a brand-color + icon treatment when no real photo is available yet.
  const uploadedHero = input.brandDraft?.heroImage ?? null
  const uploadedLogo = input.brandDraft?.logoImage ?? null
  // A tenant's first location is 'main' everywhere else — seedNewOrganization creates it
  // under that slug and seeds its page at /locations/main. Deriving a slug from
  // the brand name here renamed the location out from under that page, leaving
  // every onboarded site serving 200 "Location Not Found" at /locations/main.
  // Later locations get their own slugs through the add-location flow.
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
      price: product.amountMinor === null
        ? null
        : { unit_amount: product.amountMinor, ...(input.details.currency ? { currency: input.details.currency } : {}) },
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

  const paletteStarter = input.brandDraft?.paletteStarter ?? null
  if (paletteStarter !== null && !STARTER_PALETTES.some(starter => starter.id === paletteStarter)) throw new HTTPError({ statusCode: 400, statusMessage: 'Unknown starter palette' })
  const fontPreset = input.brandDraft?.fontPreset ?? null
  if (fontPreset !== null && !isOrganizationFontPreset(fontPreset)) throw new HTTPError({ statusCode: 400, statusMessage: 'Unsupported website font' })
  const logoShape = input.brandDraft?.logoShape ?? null
  if (logoShape !== null && !(LOGO_SHAPES as readonly string[]).includes(logoShape)) throw new HTTPError({ statusCode: 400, statusMessage: 'Unsupported logo shape' })
  const heroHeadline = input.brandDraft?.heroHeadline?.trim() || null
  const heroSubtitle = input.brandDraft?.heroSubtitle?.trim() || null
  const content = buildDraftContent(brandName, input.vertical, heroHeadline, heroSubtitle)

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
        palette_starter: paletteStarter,
        font_preset: fontPreset,
        logo_shape: logoShape,
        draft_logo_note: input.brandDraft?.logoNote?.trim() || null,
        draft_hero_photo_note: input.brandDraft?.heroPhotoNote?.trim() || null,
        draft_hero_headline: heroHeadline,
        draft_hero_subtitle: heroSubtitle,
      },
      media: [
        ...(uploadedLogo ? [{ slot: 'logo' as const, asset: uploadedLogo }] : []),
        ...(uploadedHero ? [{ slot: 'hero' as const, asset: uploadedHero }] : []),
      ],
      locations: [{
        id: locationId,
        slug: locationSlug,
        title: brandName,
        address: postalAddressFromAnswers(input.details),
        description,
        phone: input.details.phone ?? placeSnapshot?.phone ?? null,
        website_url: input.details.websiteUrl ?? placeSnapshot?.websiteUrl ?? null,
        opening_hours: input.details.openingHours,
        special_hours: input.details.specialHours,
        rating: placeSnapshot?.rating ?? null,
        review_count: placeSnapshot?.ratingCount ?? null,

      status: 'active',
      }],
      products,
      reviews,
      qa,
      content,
      locales: [{ code: sourceLocale.locale, label: sourceLocale.label, is_source: true }],
    },
  }
}

/**
 * Reads a stored draft. Version 2 drafts predate `source.placeId`; they carry
 * the same identity on their place snapshot, so they restore as version 3 and
 * an owner part-way through onboarding at deployment keeps their draft.
 */
export function parseOnboardingDraftPayload(raw: string): OnboardingDraftPayload {
  const parsed = JSON.parse(raw) as OnboardingDraftPayload | (Omit<OnboardingDraftPayload, 'version'> & { version: 2 })
  if (!parsed || (parsed.version !== 2 && parsed.version !== 3) || !parsed.source || !parsed.preview
    || !Array.isArray(parsed.preview.media) || !Array.isArray(parsed.preview.products)) {
    throw new Error('Unsupported onboarding draft payload')
  }
  const placeId = parsed.version === 3 ? parsed.source.placeId : parsed.source.place?.placeId ?? null
  if (parsed.source.type === 'google_places' ? !placeId : placeId !== null || parsed.source.place !== null) {
    throw new Error(`Onboarding draft source does not match its ${parsed.source.type} type`)
  }
  const payload: OnboardingDraftPayload = { ...parsed, version: 3, source: { ...parsed.source, placeId } }
  const source = payload.preview.locales.filter(locale => locale.is_source)
  if (source.length !== 1 || !platformLocale(source[0]!.code)) throw new Error('Onboarding primary language is unavailable')
  payload.source.details.sourceLocale ??= source[0]!.code
  if (payload.source.details.sourceLocale !== source[0]!.code) throw new Error('Onboarding primary language is inconsistent')
  payload.source.details.openingHours = parseOpeningHours(payload.source.details.openingHours)
  payload.source.details.specialHours = parseSpecialHours(payload.source.details.specialHours)
  if (payload.source.place) payload.source.place.openingHours = parseOpeningHours(payload.source.place.openingHours)
  for (const location of payload.preview.locations) {
    location.opening_hours = parseOpeningHours(location.opening_hours)
    location.special_hours = parseSpecialHours(location.special_hours)
  }
  return payload
}

export interface OnboardingDraftInput {
  draftId?: string
  expectedUpdatedAt?: string | null
  idempotencyKey?: string
  sourceType?: unknown
  placeId?: unknown
  vertical?: unknown
  name?: unknown
  subdomain?: unknown
  details?: Record<string, unknown> | null
  brandDraft?: Record<string, unknown> | null
  products?: unknown
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
  const draftAssetId = answer(image, 'draftAssetId')
  const cloudflareImageId = answer(image, 'cloudflareImageId')
  const publicUrl = answer(image, 'publicUrl')
  if (!draftAssetId || !cloudflareImageId || !publicUrl) throw new HTTPError({ statusCode: 400, statusMessage: 'Draft image identity and URL are required' })
  return { draftAssetId, cloudflareImageId, publicUrl, thumbnailUrl: answer(image, 'thumbnailUrl'), mimeType: answer(image, 'mimeType'), fileName: answer(image, 'fileName'), fileSize: typeof image.fileSize === 'number' ? image.fileSize : null }
}

export function normalizeOnboardingDraftInput(input: OnboardingDraftInput, existing: OnboardingDraftPayload | null, place: DraftPlaceSource | null) {
  if (input.details !== undefined && input.details !== null && (typeof input.details !== 'object' || Array.isArray(input.details))) throw new HTTPError({ statusCode: 400, statusMessage: 'Business details must be an object' })
  if (input.brandDraft !== undefined && input.brandDraft !== null && (typeof input.brandDraft !== 'object' || Array.isArray(input.brandDraft))) throw new HTTPError({ statusCode: 400, statusMessage: 'Brand details must be an object' })
  const raw = input.details
  const previous = existing?.source.details
  const name = answer(raw, 'name') ?? answer(input as unknown as Record<string, unknown>, 'name') ?? place?.name ?? previous?.name ?? ''
  const vertical = input.vertical ?? existing?.preview.vertical
  if (!name || typeof vertical !== 'string' || !WEBSITE_DRAFT_VERTICALS.includes(vertical as OrganizationVertical)) throw new HTTPError({ statusCode: 400, statusMessage: 'Business name and type are required', data: { missing_fields: [...(!name ? ['name'] : []), ...(!vertical ? ['vertical'] : [])] } })
  const sourceLocale = answer(raw, 'sourceLocale', previous?.sourceLocale)
  if (!sourceLocale || !platformLocale(sourceLocale)) throw new HTTPError({ statusCode: 400, statusMessage: 'Choose a supported website language', data: { missing_fields: ['source_locale'] } })
  if (previous && previous.sourceLocale !== sourceLocale) throw new HTTPError({ statusCode: 409, statusMessage: 'Existing draft content cannot be relabelled into another language' })
  const country = answer(raw, 'country', previous?.country)?.toUpperCase() ?? null
  if (country && !getPhoneCountry(country)) throw new HTTPError({ statusCode: 400, statusMessage: 'country must be an ISO 3166-1 alpha-2 code' })
  const currency = answer(raw, 'currency', previous?.currency)?.toUpperCase() ?? null
  if (currency && !isCurrencyCode(currency)) throw new HTTPError({ statusCode: 400, statusMessage: 'Choose a supported currency' })
  const timezone = answer(raw, 'timezone', previous?.timezone ?? place?.timezone)
  if (timezone && !isValidTimezone(timezone)) throw new HTTPError({ statusCode: 400, statusMessage: 'Choose a valid IANA timezone' })
  const phone = answer(raw, 'phone', previous?.phone ?? place?.phone ?? null)
  const parsedPhone = phone ? parsePhone(phone, { defaultCountry: getPhoneCountry(country)?.code }) : null
  if (phone && !parsedPhone?.valid) throw new HTTPError({ statusCode: 400, statusMessage: 'Enter a valid phone number' })
  const details: DraftDetailsInput = {
    name, sourceLocale, country, currency: currency as CurrencyCode | null, timezone, phone: parsedPhone?.e164 ?? null,
    streetAddress: answer(raw, 'streetAddress', previous?.streetAddress), addressLine2: answer(raw, 'addressLine2', previous?.addressLine2),
    city: answer(raw, 'city', previous?.city), region: answer(raw, 'region', previous?.region), postalCode: answer(raw, 'postalCode', previous?.postalCode),
    websiteUrl: answer(raw, 'websiteUrl', previous?.websiteUrl ?? place?.websiteUrl ?? null),
    openingHours: parseOpeningHours(raw?.openingHours === undefined ? previous?.openingHours ?? place?.openingHours ?? null : raw.openingHours),
    specialHours: parseSpecialHours(raw?.specialHours === undefined ? previous?.specialHours ?? null : raw.specialHours),
  }
  const products: DraftProductInput[] = input.products === undefined
    ? (existing?.preview.products ?? []).map(product => ({ name: product.name, category: product.collection, amountMinor: product.price?.unit_amount ?? null }))
    : (() => {
        if (!Array.isArray(input.products)) throw new HTTPError({ statusCode: 400, statusMessage: 'products must be an array' })
        return input.products.map((value, index) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HTTPError({ statusCode: 400, statusMessage: `Product ${index + 1} is invalid` })
          const product = value as Record<string, unknown>
          const productName = answer(product, 'name')
          const amount = product.amountMinor
          if (!productName || (amount !== undefined && amount !== null && (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0))) throw new HTTPError({ statusCode: 400, statusMessage: `Product ${index + 1} requires a name and a valid price when supplied` })
          return { name: productName, category: answer(product, 'category') ?? '', amountMinor: typeof amount === 'number' ? amount : null }
        })
      })()
  const brand = input.brandDraft
  const config = existing?.preview.config
  const previousHeadline = config?.draft_hero_headline ?? existing?.preview.content.find(content => content.page === 'home' && content.field === 'hero')?.hero_title
  const brandDraft: DraftBrandInput = {
    paletteStarter: answer(brand, 'paletteStarter', config?.palette_starter), fontPreset: answer(brand, 'fontPreset', config?.font_preset),
    logoShape: answer(brand, 'logoShape', config?.logo_shape), logoNote: answer(brand, 'logoNote', config?.draft_logo_note),
    logoPreviewUrl: answer(brand, 'logoPreviewUrl'), heroPhotoNote: answer(brand, 'heroPhotoNote', config?.draft_hero_photo_note), heroPreviewUrl: answer(brand, 'heroPreviewUrl'),
    heroHeadline: answer(brand, 'heroHeadline', previousHeadline && previousHeadline !== existing?.preview.brandName ? previousHeadline : name) ?? name, heroSubtitle: answer(brand, 'heroSubtitle', config?.draft_hero_subtitle),
    logoImage: draftImage(brand?.logoImage, existing ? getDraftMedia(existing, 'logo') : null),
    heroImage: draftImage(brand?.heroImage, existing ? getDraftMedia(existing, 'hero') : null),
  }
  const payload = buildOnboardingDraftPayload({ name, vertical: vertical as OrganizationVertical, place, details, brandDraft, products })
  const subdomain = answer(input as unknown as Record<string, unknown>, 'subdomain')?.toLowerCase() ?? existing?.preview.subdomainCandidate ?? payload.preview.subdomainCandidate
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) throw new HTTPError({ statusCode: 400, statusMessage: 'Choose a website address using Latin letters, digits or hyphens', data: { missing_fields: ['subdomain'] } })
  payload.preview.subdomainCandidate = subdomain
  return payload
}

export function onboardingPublicationMissingFields(draft: Pick<SavedOnboardingDraft, 'subdomain_candidate'>, payload: OnboardingDraftPayload) {
  const details = payload.source.details
  return [
    ...(!details.sourceLocale || !platformLocale(details.sourceLocale) ? ['source_locale'] : []),
    ...(!details.currency ? ['currency'] : []),
    ...(!isValidTimezone(details.timezone) ? ['timezone'] : []),
    ...(!draft.subdomain_candidate ? ['subdomain'] : []),
  ]
}

export async function readOnboardingDraft(db: D1Database, userId: string, draftId?: string) {
  const draft = draftId
    ? await queryFirst<SavedOnboardingDraft>(db, 'SELECT * FROM onboarding_drafts WHERE id = ? AND user_id = ?', [draftId, userId])
    : await readActiveOnboardingDraft(db, userId)
  if (!draft) throw new HTTPError({ statusCode: 404, statusMessage: 'Website draft not found' })
  if (draft.status === 'abandoned') throw new HTTPError({ statusCode: 409, statusMessage: 'This website draft was discarded', data: { code: 'ONBOARDING_DRAFT_ABANDONED', draft_id: draft.id } })
  const current = draft.status === 'committing' ? await readActiveOnboardingDraft(db, userId) : draft
  if (!current || current.id !== draft.id) throw new HTTPError({ statusCode: 409, statusMessage: 'Website draft changed; read it again', data: { code: 'ONBOARDING_DRAFT_CHANGED', draft_id: draft.id } })
  return { row: current, payload: parseOnboardingDraftPayload(current.payload_json) }
}

export async function upsertActiveOnboardingDraft(db: D1Database, input: {
  userId: string
  organizationId?: string | null
  name: string
  vertical: OrganizationVertical
  sourceType: DraftSourceType
  payload: OnboardingDraftPayload
  expectedUpdatedAt: string | null
  draftId?: string
  idempotencyKey?: string
}): Promise<OnboardingDraftUpsertResult> {
  const existing = await readActiveOnboardingDraft(db, input.userId)
  const key = input.idempotencyKey?.trim()
  if (input.idempotencyKey !== undefined && (!key || key.length > 200)) throw new HTTPError({ statusCode: 400, statusMessage: 'idempotency_key must contain 1 to 200 characters' })
  const id = input.draftId ?? (key ? `mcp-website-${await creationRequestHash({ userId: input.userId, key })}` : crypto.randomUUID())
  const keyed = key ? await queryFirst<SavedOnboardingDraft>(db, 'SELECT * FROM onboarding_drafts WHERE id = ? AND user_id = ?', [id, input.userId]) : null
  const fingerprint = await creationRequestHash({ ...input.payload, request: undefined, preview: { ...input.payload.preview, content: input.payload.preview.content.map(content => ({ ...content, updated_at: undefined })) } })
  if (keyed && input.expectedUpdatedAt === null) {
    const saved = parseOnboardingDraftPayload(keyed.payload_json)
    if (!saved.request || saved.request.key !== key || saved.request.fingerprint !== fingerprint) throw new HTTPError({ statusCode: 409, statusMessage: 'This idempotency key was already used for different website answers', data: { code: 'IDEMPOTENCY_KEY_CONFLICT', draft_id: keyed.id } })
    if (keyed.status === 'abandoned') throw new HTTPError({ statusCode: 409, statusMessage: 'This website draft was discarded', data: { code: 'ONBOARDING_DRAFT_ABANDONED', draft_id: keyed.id } })
    return { id: keyed.id, subdomainCandidate: keyed.subdomain_candidate, updatedAt: keyed.updated_at, organizationId: keyed.organization_id, payload: saved }
  }
  if (existing && input.draftId !== existing.id) throw new HTTPError({ statusCode: 409, statusMessage: 'Resume your saved website draft before creating another', data: { code: 'ONBOARDING_DRAFT_EXISTS', draft_id: existing.id } })
  if (input.draftId && !existing) throw new HTTPError({ statusCode: 404, statusMessage: 'Active website draft not found' })
  if ((existing?.updated_at ?? null) !== input.expectedUpdatedAt) throw new HTTPError({ statusCode: 409, statusMessage: 'Website draft changed; reload before saving', data: { code: 'ONBOARDING_DRAFT_CHANGED', draft_id: existing?.id } })
  if (existing?.organization_id && input.payload.preview.subdomainCandidate !== existing.subdomain_candidate) {
    const organization = await queryFirst<{ subdomain: string | null; onboarding_status: string }>(db, 'SELECT subdomain, onboarding_status FROM organization WHERE id = ?', [existing.organization_id])
    if (!organization || organization.subdomain !== null || !['pending', 'failed'].includes(organization.onboarding_status)) throw new HTTPError({ statusCode: 409, statusMessage: 'A saved draft already owns its website address' })
  }
  if (existing && key && parseOnboardingDraftPayload(existing.payload_json).request?.key && parseOnboardingDraftPayload(existing.payload_json).request?.key !== key) throw new HTTPError({ statusCode: 409, statusMessage: 'This draft belongs to a different idempotency key', data: { code: 'IDEMPOTENCY_KEY_CONFLICT', draft_id: existing.id } })
  const payload = input.payload
  const savedRequest = existing ? parseOnboardingDraftPayload(existing.payload_json).request : null
  if (key || savedRequest) payload.request = { key: key ?? savedRequest!.key, fingerprint }
  const payloadJson = JSON.stringify(payload)
  const now = new Date(Math.max(Date.now(), existing ? Date.parse(existing.updated_at) + 1 : 0)).toISOString()
  const draft = await queryFirst<{ id: string; subdomain_candidate: string; organization_id: string | null; updated_at: string }>(db, existing ? `
    UPDATE onboarding_drafts SET name = ?, vertical = ?, subdomain_candidate = ?, source_type = ?, payload_json = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND status = 'active' AND updated_at = ?
      AND (organization_id IS NULL OR subdomain_candidate = ? OR EXISTS (
        SELECT 1 FROM organization o WHERE o.id = onboarding_drafts.organization_id
          AND o.subdomain IS NULL AND o.onboarding_status IN ('pending', 'failed')
      ))
    RETURNING id, subdomain_candidate, organization_id, updated_at
  ` : `INSERT INTO onboarding_drafts
    (id, user_id, organization_id, name, vertical, subdomain_candidate, source_type, status, payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT DO NOTHING
    RETURNING id, subdomain_candidate, organization_id, updated_at
  `, existing ? [input.name, input.vertical, payload.preview.subdomainCandidate, input.sourceType, payloadJson, now, existing.id, input.userId, input.expectedUpdatedAt, payload.preview.subdomainCandidate] : [id, input.userId, input.organizationId ?? null, input.name, input.vertical, payload.preview.subdomainCandidate, input.sourceType, payloadJson, now, now])
  if (!draft) throw new HTTPError({ statusCode: 409, statusMessage: 'Website draft changed; read it before retrying', data: { code: 'ONBOARDING_DRAFT_CHANGED' } })
  return { id: draft.id, subdomainCandidate: draft.subdomain_candidate, updatedAt: draft.updated_at, organizationId: draft.organization_id, payload }
}
