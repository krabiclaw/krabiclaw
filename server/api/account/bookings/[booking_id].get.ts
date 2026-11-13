import { defineHandler, HTTPError } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { linkGuestIdentitiesByVerifiedEmail } from '~/server/utils/guest-accounts'
import { ownedBuyerRequest } from '~/server/domain/payments/buyer'
import { readGuestStay } from '~/server/domain/stays'
import { loadBuyerBookingDetails } from '~/server/utils/dashboard-booking-details'
import { nightBooking } from '~/server/utils/dashboard-bookings'

export default defineHandler(async event => {
  const env = cloudflareEnv(event)
  const session = await getAuthSession(event, env)
  if (!session) throw new HTTPError({ statusCode: 401, message: 'Sign in to read your booking' })
  const id = getRouterParam(event, 'booking_id')
  if (!id) throw new HTTPError({ statusCode: 400, message: 'Booking ID is required' })
  const lookup = getQuery(event).lookup
  if (lookup !== undefined && lookup !== 'conversation') throw new HTTPError({ statusCode: 422, message: 'Invalid booking lookup' })
  // A tenant's browser can create an anonymous request after the guest signed in here.
  if (lookup === 'conversation') await linkGuestIdentitiesByVerifiedEmail(env.DB, session.user)
  // Issued account activity links explicitly identify the owned conversation.
  const record = await ownedBuyerRequest(env.DB, session.user.id, id, lookup ?? 'booking')
  const headers = { 'cache-control': 'private, no-store' }
  if (record.unit === 'nights') {
    const { stay, ...details } = await readGuestStay(env.DB, session.user.id, record.conversation_id)
    return jsonResponse({ ...details, booking: nightBooking(stay) }, { headers })
  }
  return jsonResponse({ booking: await loadBuyerBookingDetails(env.DB, env, session.user.id, 'booking', record.booking_id, 'booking') }, { headers })
})
