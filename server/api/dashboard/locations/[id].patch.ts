// PATCH /api/dashboard/locations/[id] — Update a location

import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardLocationContext } from '~/server/utils/dashboard-context'
import { updateLocation, type LocationRecord, type UpdateLocationInput } from '~/server/utils/location-management'
import { parseLocationPayload } from '~/server/utils/location-payload'
import { assertMemberScope, memberAccessPrincipal } from '~/server/utils/member-access'

export default defineHandler(async (event) => {
  const locationId = getRouterParam(event, 'id')
  if (!locationId) return jsonResponse({ error: 'Location ID required' }, { status: 400 })

  const { env, db, session, organization, location: locationContext } = await getDashboardLocationContext(event, locationId)
  // The location's own organization, not the one the session happens to be in:
  // the context resolved both, and authorizing against the session's while
  // reading the location's is how a request reaches another tenant's row.
  const organizationId = locationContext.organization_id
  if (organizationId !== organization.id) return jsonResponse({ error: 'Location not found' }, { status: 404 })
  const body = await readBody<Record<string, unknown>>(event)
  if (typeof body !== 'object' || body === null) {
    return jsonResponse({ error: 'Invalid request body' }, { status: 400 })
  }

  await assertMemberScope(db, { ...memberAccessPrincipal(organization, { env, event }), locationId, patch: body })

  const rating = body.rating === undefined || body.rating === null || String(body.rating).trim() === ''
    ? undefined
    : (() => { const n = Number(body.rating); return Number.isFinite(n) ? n : undefined })()
  const reviewCount = body.review_count === undefined || body.review_count === null || String(body.review_count).trim() === ''
    ? undefined
    : (() => { const n = Number(body.review_count); return Number.isFinite(n) ? n : undefined })()
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
    db, organizationId, locationId, {
      stay_map_sharing: body.stay_map_sharing as UpdateLocationInput['stay_map_sharing'],
      latitude: body.latitude as UpdateLocationInput['latitude'],
      longitude: body.longitude as UpdateLocationInput['longitude'],
      title: typeof body.title === 'string' ? body.title : undefined, slug: body.slug as UpdateLocationInput['slug'], address: body.address, phone: typeof body.phone === 'string' ? body.phone : body.phone === null ? null : undefined, email: typeof body.email === 'string' ? body.email : body.email === null ? null : undefined, website_url: typeof body.website_url === 'string' ? body.website_url : body.website_url === null ? null : undefined, maps_url: typeof body.maps_url === 'string' ? body.maps_url : body.maps_url === null ? null : undefined, google_review_url: typeof body.google_review_url === 'string' ? body.google_review_url : body.google_review_url === null ? null : undefined, opening_hours: body.opening_hours === undefined
        ? undefined
        : body.opening_hours === null
          ? null
          : body.opening_hours as UpdateLocationInput['opening_hours'], special_hours: body.special_hours === undefined
        ? undefined
        : body.special_hours === null
          ? null
          : body.special_hours as UpdateLocationInput['special_hours'], expected_updated_at: typeof body.expected_updated_at === 'string' ? body.expected_updated_at : undefined, description: typeof body.description === 'string' ? body.description : body.description === null ? null : undefined, short_description: typeof body.short_description === 'string' ? body.short_description : body.short_description === null ? null : undefined, price_level: typeof body.price_level === 'string' ? body.price_level : body.price_level === null ? null : undefined, google_place_id: typeof body.google_place_id === 'string' ? body.google_place_id : body.google_place_id === null ? null : undefined, timezone: typeof body.timezone === 'string' ? body.timezone.trim() || null : body.timezone === null ? null : undefined, rating, review_count: reviewCount, assigned_member_id: assignedMemberId, assigned_team_id: assignedTeamId, status: body.status === 'active' || body.status === 'inactive' || body.status === 'sync_error'
        ? body.status
        : undefined, }, session.user.id, env, )

  if (result.status >= 400) {
    return jsonResponse(result.data, { status: result.status })
  }

  const { location } = result.data as { location: LocationRecord }
  return jsonResponse({
    success: true,
    location: parseLocationPayload(location),
  }, { status: result.status })
})
import { defineHandler } from 'nitro';
import { getRouterParam, readBody  } from 'nitro/h3';
