import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { requireProductAccess } from '~/server/utils/location-access'
import { replaceWeeklySchedule } from '~/server/utils/availability'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

/**
 * Replace the weekly schedule a product runs at one location.
 *
 * The body is the whole schedule for that branch: every (weekday, time) the
 * merchant runs, using the Product's duration and capacity.
 * Times are the branch's wall clock; the branch's timezone is what makes them
 * instants. See replaceWeeklySchedule for what a removed slot does to the
 * sessions already generated from it.
 */
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const productId = getRouterParam(event, 'productId')
  if (!organizationId || !productId) return jsonResponse({ error: 'Organization ID and product ID are required' }, { status: 400 })
  const body = await readStrictBody<{ location_id: unknown; slots: unknown }>(event, { location_id: 'unknown', slots: 'unknown' })
  if (typeof body.location_id !== 'string' || !body.location_id) return jsonResponse({ error: 'location_id must be a location ID; an online offering is booked in its provider\'s working hours' }, { status: 400 })
  const { db, session, organization } = await requireProductAccess(event, organizationId, productId)
  const result = await replaceWeeklySchedule(db, {
    organizationId: organization.id, productId, locationId: body.location_id,
    slots: body.slots, actorId: session.user.id,
  })
  return jsonResponse({ success: true, ...result })
})
