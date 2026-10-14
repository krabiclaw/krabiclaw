// POST /api/dashboard/google-places/details
// The place the owner picked in the business picker. Carries the picker's
// autocomplete session token, which ends that Google session. Reviews are not
// returned: the draft save and the Google Maps sync fetch and
// import them themselves.
import { defineHandler } from 'nitro'
import { readBody } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { getPlaceDetails, isPlacesSessionToken } from '~/server/utils/google-places'
import { HOUR_MS, incrementHourlyRateLimit } from '~/server/utils/hourly-rate-limit'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })

  const body = await readBody(event) as { placeId?: unknown; sessionToken?: unknown } | undefined
  const placeId = typeof body?.placeId === 'string' ? body.placeId.trim() : ''
  if (!placeId || placeId.length > 300) return jsonResponse({ error: 'placeId is required and at most 300 characters' }, { status: 400 })
  if (!isPlacesSessionToken(body?.sessionToken)) return jsonResponse({ error: 'sessionToken must be a UUID' }, { status: 400 })

  const apiKey = env.GOOGLE_PLACES_API_KEY as string | undefined
  if (!apiKey) return jsonResponse({ error: 'Google Places API key not configured' }, { status: 503 })

  const hourWindow = Math.floor(Date.now() / HOUR_MS)
  if (!await incrementHourlyRateLimit(db, `rate:places-details:user:${session.user.id}:${hourWindow}`, 30, HOUR_MS)) {
    return jsonResponse({ error: 'Too many requests. Please try again later.' }, { status: 429 })
  }

  let place
  try {
    place = await getPlaceDetails(apiKey, placeId, { sessionToken: body.sessionToken })
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Could not fetch place details. Try again.' }, { status: 502 })
  }

  return jsonResponse({
    placeId: place.placeId,
    name: place.name,
    address: place.address,
    phone: place.phone,
    mapsUrl: place.mapsUrl,
    websiteUrl: place.websiteUrl,
    rating: place.rating,
    ratingCount: place.ratingCount,
    openingHours: place.openingHours,
    timezone: place.timezone,
  })
})
