import { cancelGuestBooking } from '~/server/domain/requests'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { hashReservationCancelToken, readBearerToken } from '~/server/utils/reservation-cancel-token'
import { getClientIp, hashClientIp, incrementHourlyRateLimit } from '~/server/utils/hourly-rate-limit'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

const IP_HOURLY_LIMIT = 20
const REQUEST_HOURLY_LIMIT = 5

/** Spend the cancellation capability from the guest's booking confirmation. */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined
  const requestId = getRouterParam(event, 'conversation_id')
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

  const tokenHash = await hashReservationCancelToken(token)
  const now = new Date().toISOString()
  const cancelled = await cancelGuestBooking(db, { id: requestId, organizationId, tokenHash, now, env })
  if (!cancelled) return jsonResponse({ error: 'Booking not found or already cancelled' }, { status: 404 })
  return jsonResponse({ success: true, ...cancelled })
})
