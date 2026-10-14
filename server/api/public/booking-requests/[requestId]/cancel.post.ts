import { getGuestRequest, cancelBookingRequest } from '~/server/domain/requests'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { notifyGuestCancellation } from '~/server/utils/notifications'
import { hashReservationCancelToken, readBearerToken } from '~/server/utils/reservation-cancel-token'
import { getClientIp, hashClientIp, incrementHourlyRateLimit } from '~/server/utils/hourly-rate-limit'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

const IP_HOURLY_LIMIT = 20
const REQUEST_HOURLY_LIMIT = 5

/**
 * Spend a guest's cancellation token.
 *
 * One route for both kinds. Which record holds the seats is the thread's own
 * `kind`, resolved once by cancelBookingRequest, and the guest is told about
 * the thing they booked in the words that fit it.
 */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined
  const requestId = getRouterParam(event, 'requestId')
  const token = readBearerToken(event.req.headers.get('authorization'))
  if (!organizationId || !requestId || !token) {
    return jsonResponse({ error: 'Missing required parameters' }, { status: 400 })
  }

  const env = cloudflareEnv(event)
  const db = env.db
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const clientIpHash = await hashClientIp(getClientIp(event))
  const hour = Math.floor(Date.now() / 3_600_000)
  const ipOk = await incrementHourlyRateLimit(db, `booking-cancel:ip:${clientIpHash}:${hour}`, import.meta.dev ? 1000 : IP_HOURLY_LIMIT, 3_600_000)
  if (!ipOk) return jsonResponse({ error: 'Too many cancellation attempts. Please try again later.' }, { status: 429 })
  const requestOk = await incrementHourlyRateLimit(db, `booking-cancel:request:${organizationId}:${requestId}:${hour}`, import.meta.dev ? 1000 : REQUEST_HOURLY_LIMIT, 3_600_000)
  if (!requestOk) return jsonResponse({ error: 'Too many cancellation attempts. Please try again later.' }, { status: 429 })

  const existing = await getGuestRequest(db, requestId, organizationId)
  if (!existing || existing.kind === 'contact') {
    return jsonResponse({ error: 'Booking not found or already cancelled' }, { status: 404 })
  }

  const tokenHash = await hashReservationCancelToken(token)
  const now = new Date().toISOString()
  const cancelled = await cancelBookingRequest(db, { id: requestId, organizationId, kind: existing.kind, tokenHash, now, env })
  if (!cancelled) return jsonResponse({ error: 'Booking not found or already cancelled' }, { status: 404 })

  await notifyGuestCancellation(env, db, cancelled)

  return jsonResponse({ success: true, kind: cancelled.record.kind })
})
