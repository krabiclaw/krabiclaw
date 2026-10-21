import { normalizeGoogleOpeningHours, type OpeningHours } from '~/shared/reservation-hours'
import { serializeOpeningHours } from '~/server/utils/location-management'
import type { D1Database } from '@cloudflare/workers-types'
import { normalizeGoogleReview, type GoogleReview } from '~/shared/google-review'
import { executeBatch } from '~/server/db'
import { formatPostalAddress, parsePostalAddress, type PostalAddress } from '~/utils/postal-address'
import { toE164 } from '~/utils/phone'

const PLACES_BASE = 'https://places.googleapis.com/v1/places'

// Generate a canonical Google Maps embed URL from the location data already
// stored by the Places importer. This helper does not call Google.
export const calculateMapEmbedUrl = (loc: {
  title: string
  maps_url?: string | null
  latitude?: number | null
  longitude?: number | null
  address?: PostalAddress | null
}) => {
  if (loc.maps_url) {
    try {
      const url = new URL(loc.maps_url)
      const cid = url.searchParams.get('cid')
      if (cid) return `https://maps.google.com/maps?cid=${cid}&output=embed`
    } catch { /* use the next available source */ }
  }

  if (loc.latitude != null && loc.longitude != null) {
    return `https://maps.google.com/maps?q=${loc.latitude},${loc.longitude}&output=embed`
  }

  const address = formatPostalAddress(loc.address ?? null)
  if (!address) return null
  const query = loc.title ? `${loc.title}, ${address}` : address
  return `https://maps.google.com/maps?q=${encodeURIComponent(String(query))}&output=embed`
}

const DETAIL_FIELD_MASK = [
  'id',
  'displayName',
  'postalAddress',
  'location',
  'googleMapsUri',
  'internationalPhoneNumber',
  'websiteUri',
  'rating',
  'userRatingCount',
  'regularOpeningHours',
  'timeZone',
  'reviews',
].join(',')

export type PlaceReview = GoogleReview

export interface PlaceDetails {
  placeId: string
  name: string
  address: PostalAddress | null
  lat: number | null
  lng: number | null
  mapsUrl: string | null
  phone: string | null
  websiteUrl: string | null
  rating: number | null
  ratingCount: number | null
  timezone: string | null
  openingHours: OpeningHours
  reviews: PlaceReview[]
}

interface RawPlace {
  id?: string
  displayName?: { text?: string }
  location?: { latitude?: number; longitude?: number }
  googleMapsUri?: string
  internationalPhoneNumber?: string
  websiteUri?: string
  rating?: number
  userRatingCount?: number
  regularOpeningHours?: { periods?: unknown[] }
  timeZone?: { id?: string }
  postalAddress?: unknown
  reviews?: unknown[]
}

function normalizeDetail(place: RawPlace): PlaceDetails {
  return {
    placeId: place.id ?? '',
    name: place.displayName?.text ?? '',
    address: parsePostalAddress(place.postalAddress),
    lat: place.location?.latitude ?? null,
    lng: place.location?.longitude ?? null,
    mapsUrl: place.googleMapsUri ?? null,
    // A location stores E.164. Google's national format carries no country, so
    // the international form is the one that says which number this is.
    phone: place.internationalPhoneNumber ? toE164(place.internationalPhoneNumber) : null,
    websiteUrl: place.websiteUri ?? null,
    rating: place.rating ?? null,
    ratingCount: place.userRatingCount ?? null,
    timezone: place.timeZone?.id ?? null,
    openingHours: normalizeGoogleOpeningHours(place.regularOpeningHours?.periods),
    reviews: (place.reviews ?? []).map(normalizeGoogleReview),
  }
}

/**
 * A location's Google reviews are exactly what Google returned this sync.
 * Google's Places API returns at most five reviews per place, chosen by
 * Google, and the site shows exactly those (owner decision, 2026-09-14): a
 * review Google no longer shows is not shown here either, and a row imported
 * under a merged or legacy place id, or without a review id, is not a Google
 * review of this place. Beachfront Pottery Krabi showed each review three
 * times (2026-09-13) because earlier syncs kept everything ever imported.
 * There is no fuller inventory to preserve: this response is the inventory.
 */
export function staleGoogleReviewDeletes(scope: { organizationId: string; locationId: string }, reviews: PlaceReview[]) {
  const stale = `
      SELECT id FROM reviews
      WHERE organization_id = ? AND location_id = ?
        AND source = 'google_places'
        AND (google_review_id IS NULL OR google_review_id NOT IN (SELECT value FROM json_each(?)))`
  const params = [scope.organizationId, scope.locationId, JSON.stringify(reviews.map(review => review.google_review_id))]
  // A review's media placements (author portrait) have no foreign key to the
  // review, so they go first, by the same predicate.
  return [
    { query: `DELETE FROM media_placements WHERE owner_type = 'review' AND owner_id IN (${stale})`, params },
    { query: `DELETE FROM reviews WHERE id IN (${stale})`, params },
  ]
}

export function googleReviewUpserts(scope: { organizationId: string; locationId: string }, reviews: PlaceReview[], now: string) {
  const { organizationId, locationId } = scope
  return reviews.map(review => {
    const reviewId = `gplaces-${locationId}-${review.google_review_id.replace(/\//g, '-')}`
    return {
      query: `INSERT INTO reviews (id, organization_id, location_id, google_review_id, author_name, rating, content,
        original_review_date, original_reference, google_review_metadata, status, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 'google_places', ?, ?)
        ON CONFLICT(organization_id, location_id, google_review_id) DO UPDATE SET
          author_name = excluded.author_name, rating = excluded.rating, content = excluded.content,
          original_review_date = excluded.original_review_date, original_reference = excluded.original_reference,
          google_review_metadata = excluded.google_review_metadata, updated_at = excluded.updated_at`,
      params: [reviewId, organizationId, locationId, review.google_review_id, review.author_name, review.rating, review.content,
        review.original_review_date, review.original_reference, JSON.stringify(review.google_review_metadata), now, now],
    }
  })
}

/**
 * Writes what Google Maps says about a location's connected place.
 *
 * `import` is the explicit act — connecting a place, or the tenant confirming a
 * re-import — and replaces the business details the tenant otherwise owns:
 * address, phone, website, hours, timezone. `provider` is the routine sync and
 * writes only what Google owns: rating, review count, the Maps link and the
 * review snapshot. A tenant who corrected their hours is never overwritten by
 * an hourly job.
 */
export async function syncPlaceToLocation(
  db: D1Database,
  apiKey: string,
  organizationId: string,
  locationId: string,
  placeId: string,
  scope: 'import' | 'provider',
): Promise<{ place: PlaceDetails; reviewsUpserted: number }> {
  const place = await getPlaceDetails(apiKey, placeId)
  if (!place.placeId) throw new Error(`Google Maps returned no place id for ${placeId}`)
  const now = new Date().toISOString()

  const location = scope === 'import'
    ? { query: `
    UPDATE business_locations SET
      phone = COALESCE(?, phone),
      website_url = COALESCE(?, website_url),
      address = COALESCE(?, address),
      latitude = COALESCE(?, latitude),
      longitude = COALESCE(?, longitude),
      maps_url = COALESCE(?, maps_url),
      opening_hours = ?,
      timezone = COALESCE(?, timezone),
      rating = ?,
      review_count = ?,
      google_place_id = ?,
      last_synced_at = ?,
      updated_at = ?
    WHERE id = ? AND organization_id = ?
  `, params: [
      place.phone,
      place.websiteUrl,
      place.address ? JSON.stringify(place.address) : null,
      place.lat,
      place.lng,
      place.mapsUrl,
      serializeOpeningHours(place.openingHours),
      place.timezone,
      place.rating,
      place.ratingCount,
      place.placeId,
      now,
      now,
      locationId,
      organizationId,
    ] }
    : { query: `
    UPDATE business_locations SET
      maps_url = COALESCE(?, maps_url),
      rating = ?,
      review_count = ?,
      last_synced_at = ?,
      updated_at = ?
    WHERE id = ? AND organization_id = ? AND google_place_id = ?
  `, params: [place.mapsUrl, place.rating, place.ratingCount, now, now, locationId, organizationId, placeId] }

  const results = await executeBatch(db, [location,
    ...staleGoogleReviewDeletes({ organizationId, locationId }, place.reviews),
    ...googleReviewUpserts({ organizationId, locationId }, place.reviews, now)])
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) throw new Error(`Location ${locationId} is not connected to ${placeId}`)
  const reviewsUpserted = results.slice(results.length - place.reviews.length).reduce((count, result) => count + Number(result.meta?.changes ?? 0), 0)

  return { place, reviewsUpserted }
}

/** Google's Autocomplete (New) session token is a UUID the client generates. */
const SESSION_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isPlacesSessionToken(value: unknown): value is string {
  return typeof value === 'string' && SESSION_TOKEN_PATTERN.test(value)
}

const AUTOCOMPLETE_FIELD_MASK = [
  'suggestions.placePrediction.placeId',
  'suggestions.placePrediction.structuredFormat.mainText.text',
  'suggestions.placePrediction.structuredFormat.secondaryText.text',
  'suggestions.placePrediction.text.text',
].join(',')

/** One place prediction, as the business picker shows it. */
export interface GooglePlaceSuggestion {
  placeId: string
  name: string
  addressLabel: string
  fullText: string
}

interface RawPlacePrediction {
  placeId?: unknown
  text?: { text?: unknown }
  structuredFormat?: { mainText?: { text?: unknown }; secondaryText?: { text?: unknown } }
}

/**
 * Places API (New) Autocomplete: the owner types their business name and picks
 * Google's prediction. Global and unbiased, place predictions only. Every
 * request in one search carries the same session token, and the Place Details
 * request that follows a selection carries it too, which closes the session.
 * https://developers.google.com/maps/documentation/places/web-service/place-autocomplete
 */
export async function autocompletePlaces(
  apiKey: string,
  input: string,
  sessionToken: string,
): Promise<GooglePlaceSuggestion[]> {
  const response = await fetch(`${PLACES_BASE}:autocomplete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': AUTOCOMPLETE_FIELD_MASK,
    },
    body: JSON.stringify({ input, sessionToken }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Places autocomplete failed: ${response.status} ${text.slice(0, 200)}`)
  }

  const data = await response.json() as { suggestions?: Array<{ placePrediction?: RawPlacePrediction }> }
  return (data.suggestions ?? []).flatMap((suggestion): GooglePlaceSuggestion[] => {
    const prediction = suggestion.placePrediction
    const placeId = prediction?.placeId
    const name = prediction?.structuredFormat?.mainText?.text
    const fullText = prediction?.text?.text
    const secondary = prediction?.structuredFormat?.secondaryText?.text
    if (typeof placeId !== 'string' || !placeId || typeof name !== 'string' || !name || typeof fullText !== 'string') return []
    if (secondary !== undefined && typeof secondary !== 'string') return []
    return [{ placeId, name, addressLabel: secondary ?? '', fullText }]
  })
}

export async function getPlaceDetails(
  apiKey: string,
  placeId: string,
  options: { sessionToken?: string } = {},
): Promise<PlaceDetails> {
  const query = new URLSearchParams({ languageCode: 'en' })
  if (options.sessionToken) query.set('sessionToken', options.sessionToken)
  const response = await fetch(`${PLACES_BASE}/${encodeURIComponent(placeId)}?${query}`, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': DETAIL_FIELD_MASK,
    },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Places detail failed: ${response.status} ${text.slice(0, 200)}`)
  }

  return normalizeDetail(await response.json() as RawPlace)
}
