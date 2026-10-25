// Get a business location for a site
import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { queryFirst } from '~/server/db'
import { requireLocationAccess } from '~/server/utils/location-access'
import { getMediaPlacements } from '~/server/utils/media-placement'

interface LocationRow {
  id: string
  slug: string
  title: string
  address: string | null
  phone: string | null
  website_url: string | null
  maps_url: string | null
  latitude: number | null
  longitude: number | null
  opening_hours: string | null
  special_hours: string | null
  categories: string | null
  description: string | null
  short_description: string | null
  email: string | null
  price_level: string | null
  google_place_id: string | null
  rating: number | null
  review_count: number | null
  status: string
  last_synced_at: string | null
  created_at: string
  updated_at: string
  assigned_member_id: string | null
  assigned_team_id: string | null
}

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const locationId = getRouterParam(event, 'locationId')

  if (!organizationId || !locationId) {
    return jsonResponse({ error: 'Organization ID and location ID are required' }, { status: 400 })
  }

  try {
    const { db, organization } = await requireLocationAccess(event, organizationId, locationId)

    const location = await queryFirst<LocationRow>(db, `
      SELECT bl.id, bl.slug, bl.title, bl.address, bl.phone, bl.website_url, bl.maps_url, bl.latitude, bl.longitude, bl.opening_hours, bl.special_hours, bl.categories, bl.description, bl.short_description, bl.email, bl.price_level, bl.google_place_id, bl.rating, bl.review_count, bl.status, bl.last_synced_at, bl.created_at, bl.updated_at, bl.assigned_member_id, bl.assigned_team_id
      FROM business_locations bl
      WHERE bl.id = ? AND bl.organization_id = ?
      LIMIT 1
    `, [locationId, organization.id])

    if (!location) {
      return jsonResponse({ error: 'Location not found' }, { status: 404 })
    }

    const placements = await getMediaPlacements(db, { organizationId, ownerType: 'business_location', ownerIds: [location.id] })
    return jsonResponse({
      success: true, location: {
        ...location, address: location.address ? JSON.parse(location.address) : null, opening_hours: location.opening_hours ? JSON.parse(location.opening_hours) : null, special_hours: location.special_hours ? JSON.parse(location.special_hours) : null, categories: location.categories ? JSON.parse(location.categories) : null, media: placements.get(location.id) ?? []
      }
    })
  } catch (error) {
    rethrowHttpError(error)
    console.error('Failed to get business location:', error)
    return jsonResponse({ error: 'Failed to get business location' }, { status: 500 })
  }
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
