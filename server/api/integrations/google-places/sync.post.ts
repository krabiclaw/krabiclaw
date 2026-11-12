import { defineHandler } from 'nitro'
import { readBody } from 'nitro/h3'
import { HTTPError } from 'h3'
import { jsonResponse } from '~/server/utils/api-response'
import { syncPlaceToLocation } from '~/server/utils/google-places'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'
import { queryFirst } from '~/server/db'
import { requireRequestedLocationAccess } from '~/server/utils/location-access'

/**
 * Connecting a location to Google Maps, and re-importing from it.
 *
 * With `google_place_id` this is the connection: the tenant confirmed that place is
 * this location, so its id is stored and its details imported. Without one it
 * is the explicit re-import of the place already connected. Both replace the
 * location's address, phone, hours and timezone with Google's — which is why
 * each is only ever a confirmed tenant action, and the hourly sync is not.
 */
export default defineHandler(async (event) => {
  const body = await readBody(event) as { organization_id?: string; location_id?: string; google_place_id?: string } | undefined
  const locationId = body?.location_id
  if (!locationId) return jsonResponse({ error: 'location_id is required' }, { status: 400 })

  const { env, db, organization } = await requireRequestedLocationAccess(event, locationId, body?.organization_id)

  if (!await hasOrganizationEntitlement(env, organization.id, 'google_places')) {
    return jsonResponse({ error: 'Google Maps requires a Growth plan or higher.' }, { status: 403 })
  }

  const apiKey = env.GOOGLE_PLACES_API_KEY as string | undefined
  if (!apiKey) return jsonResponse({ error: 'Google Places API key not configured' }, { status: 500 })

  const location = await queryFirst<{ id: string; google_place_id: string | null }>(db, `
    SELECT id, google_place_id FROM business_locations
    WHERE id = ? AND organization_id = ?
    LIMIT 1
  `, [locationId, organization.id])
  if (!location) return jsonResponse({ error: 'Location not found' }, { status: 404 })

  const placeId = body?.google_place_id?.trim() || location.google_place_id
  if (!placeId) return jsonResponse({ error: 'This location is not connected to Google Maps.' }, { status: 400 })

  try {
    const { place, reviewsUpserted } = await syncPlaceToLocation(db, apiKey, organization.id, locationId, placeId, 'import')
    await purgePublicResourceCacheNow(env, organization.id)

    return jsonResponse({
      success: true, synced_at: new Date().toISOString(), reviews_upserted: reviewsUpserted, place: {
        google_place_id: place.placeId, name: place.name, phone: place.phone, rating: place.rating, google_rating_count: place.ratingCount,
        opening_hours: place.openingHours, timezone: place.timezone, address: place.address, google_maps_url: place.mapsUrl,
      },
    })
  } catch (error) {
    if (error instanceof HTTPError) throw error
    return jsonResponse({ error: error instanceof Error ? error.message : 'Google Maps import failed' }, { status: 502 })
  }
})
