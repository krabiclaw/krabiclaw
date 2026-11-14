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
  if (!db) return jsonResponse({ error: 'Database not available', code: 'DATABASE_UNAVAILABLE' }, { status: 500 })

  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required', code: 'UNAUTHENTICATED' }, { status: 401 })

  const body = await readBody(event) as { input?: unknown; session_token?: unknown; purpose?: unknown } | undefined
  const input = typeof body?.input === 'string' ? body.input : ''
  if (input.trim().length < 3) return jsonResponse({ error: 'input must be at least 3 characters', code: 'INVALID_BODY_FIELD' }, { status: 400 })
  if (input.length > 200) return jsonResponse({ error: 'input must be at most 200 characters', code: 'INVALID_BODY_FIELD' }, { status: 400 })
  if (!isPlacesSessionToken(body?.session_token)) return jsonResponse({ error: 'session_token must be a UUID', code: 'INVALID_BODY_FIELD' }, { status: 400 })
  if (body.purpose !== undefined && body.purpose !== 'address') return jsonResponse({ error: 'Invalid search purpose', code: 'INVALID_BODY_FIELD' }, { status: 400 })

  const apiKey = env.GOOGLE_PLACES_API_KEY as string | undefined
  if (!apiKey) return jsonResponse({ error: 'Google Maps search is unavailable here.', code: 'GOOGLE_PLACES_UNAVAILABLE' }, { status: 503 })

  const hourWindow = Math.floor(Date.now() / HOUR_MS)
  if (!await incrementHourlyRateLimit(db, `rate:places-autocomplete:user:${session.user.id}:${hourWindow}`, 120, HOUR_MS)) {
    return jsonResponse({ error: 'Too many searches. Please try again later.', code: 'RATE_LIMITED' }, { status: 429 })
  }

  try {
    return jsonResponse({ suggestions: await autocompletePlaces(apiKey, input.trim(), body.session_token, body.purpose) })
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Google Maps search failed', code: 'GOOGLE_PLACES_FAILED' }, { status: 502 })
  }
})
