import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { requireFinancialBrowserOrigin } from '~/server/utils/financial-browser'
import { cancelGuestBooking } from '~/server/domain/requests'

export default defineHandler(async event => {
  const env = cloudflareEnv(event)
  const session = await getAuthSession(event, env)
  if (!session) throw new HTTPError({ statusCode: 401, message: 'Sign in to manage your booking' })
  requireFinancialBrowserOrigin(event)
  const bookingId = getRouterParam(event, 'booking_id')
  if (!bookingId) throw new HTTPError({ statusCode: 400, message: 'Booking ID is required' })
  const body = await readRequiredBody<{ version?: unknown }>(event)
  if (typeof body?.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1) throw new HTTPError({ statusCode: 400, message: 'Booking version is required' })
  const cancelled = await cancelGuestBooking(env.DB, { bookingId, version: body.version, buyerUserId: session.user.id, now: new Date().toISOString(), env })
  if (!cancelled) throw new HTTPError({ statusCode: 409, message: 'This booking can no longer be cancelled' })
  return jsonResponse({ success: true, status: 'cancelled', ...cancelled })
})
