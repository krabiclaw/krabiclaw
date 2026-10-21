import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { updateLocation, type UpdateLocationInput } from '~/server/utils/location-management'
import { requireLocationAccess } from '~/server/utils/location-access'
import { parseLocationPayload } from '~/server/utils/location-payload'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const locationId = getRouterParam(event, 'locationId')
  if (!organizationId || !locationId) {
    return jsonResponse({ error: 'Organization ID and location ID are required' }, { status: 400 })
  }

  const body = await readRequiredBody<Record<string, unknown>>(event)
  const { env, db, session, organization } = await requireLocationAccess(event, organizationId, locationId, body)

  const rating = body.rating === undefined || body.rating === null || String(body.rating).trim() === ''
    ? undefined
    : Number(body.rating)
  const reviewCount = body.review_count === undefined || body.review_count === null || String(body.review_count).trim() === ''
    ? undefined
    : Number(body.review_count)
  const assignedMemberId = body.assigned_member_id === undefined
    ? undefined
    : body.assigned_member_id === null || body.assigned_member_id === ''
      ? null
      : String(body.assigned_member_id)
  const assignedTeamId = body.assigned_team_id === undefined
    ? undefined
    : body.assigned_team_id === null || body.assigned_team_id === ''
      ? null
      : String(body.assigned_team_id)

  const result = await updateLocation(
    db, organization.id, locationId, {
      stay_map_sharing: body.stay_map_sharing as UpdateLocationInput['stay_map_sharing'],
      latitude: body.latitude as UpdateLocationInput['latitude'],
      longitude: body.longitude as UpdateLocationInput['longitude'],
      title: typeof body.title === 'string' ? body.title : undefined, slug: typeof body.slug === 'string' ? body.slug : undefined, address: body.address, phone: typeof body.phone === 'string' ? body.phone : undefined, email: typeof body.email === 'string' ? body.email : undefined, website_url: typeof body.website_url === 'string' ? body.website_url : body.website_url === null ? null : undefined, maps_url: typeof body.maps_url === 'string' ? body.maps_url : body.maps_url === null ? null : undefined, opening_hours: body.opening_hours === undefined ? undefined : (body.opening_hours || null) as UpdateLocationInput['opening_hours'], special_hours: body.special_hours === undefined ? undefined : (body.special_hours || null) as UpdateLocationInput['special_hours'], expected_updated_at: typeof body.expected_updated_at === 'string' ? body.expected_updated_at : undefined, description: typeof body.description === 'string' ? body.description : body.description === null ? null : undefined, short_description: typeof body.short_description === 'string' ? body.short_description : body.short_description === null ? null : undefined, price_level: typeof body.price_level === 'string' ? body.price_level : body.price_level === null ? null : undefined, google_place_id: typeof body.google_place_id === 'string' ? body.google_place_id : body.google_place_id === null ? null : undefined, rating, review_count: reviewCount, assigned_member_id: assignedMemberId, assigned_team_id: assignedTeamId, status: body.status === 'active' || body.status === 'inactive' || body.status === 'sync_error'
        ? body.status
        : undefined, }, session.user.id, env)

  if (result.status >= 400) {
    return jsonResponse(result.data, { status: result.status })
  }

  const location = (result.data as { location?: unknown }).location
  return jsonResponse({
    success: true, location: location ? parseLocationPayload(location) : null, }, { status: result.status })
})
import { defineHandler } from 'nitro';
import { getRouterParam  } from 'nitro/h3';
