// POST /api/dashboard/google-places/autocomplete
// The business picker's predictions, shared by new-site onboarding and
// Settings → Google Maps. The API key stays on the server.
import { defineHandler } from 'nitro'
import { readBody } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { autocompletePlaces, isPlacesSessionToken } from '~/server/utils/google-places'
import { HOUR_MS, incrementHourlyRateLimit } from '~/server/utils/hourly-rate-limit'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })

  const body = await readBody(event) as { input?: unknown; sessionToken?: unknown } | undefined
  const input = typeof body?.input === 'string' ? body.input : ''
  if (input.trim().length < 3) return jsonResponse({ error: 'input must be at least 3 characters' }, { status: 400 })
  if (input.length > 200) return jsonResponse({ error: 'input must be at most 200 characters' }, { status: 400 })
  if (!isPlacesSessionToken(body?.sessionToken)) return jsonResponse({ error: 'sessionToken must be a UUID' }, { status: 400 })

  const apiKey = env.GOOGLE_PLACES_API_KEY as string | undefined
  if (!apiKey) return jsonResponse({ error: 'Google Places API key not configured' }, { status: 503 })

  const hourWindow = Math.floor(Date.now() / HOUR_MS)
  if (!await incrementHourlyRateLimit(db, `rate:places-autocomplete:user:${session.user.id}:${hourWindow}`, 120, HOUR_MS)) {
    return jsonResponse({ error: 'Too many searches. Please try again later.' }, { status: 429 })
  }

  try {
    return jsonResponse({ suggestions: await autocompletePlaces(apiKey, input.trim(), body.sessionToken) })
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Google Maps search failed' }, { status: 502 })
  }
})
