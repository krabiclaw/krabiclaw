// Get business locations for a site
import { cloudflareEnv, jsonResponse, rethrowHttpError } from '../../../utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { assertOrganizationWideAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { loadMemberOrganizationRow } from '~/server/utils/location-access'
import { queryAll } from '~/server/db'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')

  if (!organizationId) {
    return jsonResponse({
      error: 'Organization ID is required'
    }, { status: 400 })
  }

  const env = cloudflareEnv(event)
  const db = env.DB

  if (!db) {
    return jsonResponse({
      error: 'Database not available'
    }, { status: 500 })
  }

  const session = await getAuthSession(event, env)

  if (!session?.user?.id) {
    return jsonResponse({
      error: 'Authentication required'
    }, { status: 401 })
  }

  try {
    const organization = await loadMemberOrganizationRow(event, db, env, organizationId, session.user.id)

    if (!organization) {
      return jsonResponse({
        error: 'Organization not found or access denied'
      }, { status: 404 })
    }

    await assertOrganizationWideAccess(db, memberAccessPrincipal(organization.membership, { env, event }))

    const locations = await queryAll<ApiValue>(db, `
      SELECT bl.id, bl.slug, bl.title, bl.address, bl.phone, bl.website_url, bl.maps_url, bl.latitude, bl.longitude, bl.opening_hours, bl.description, bl.short_description, bl.email, bl.price_level, bl.google_place_id, bl.rating, bl.review_count, bl.status, bl.last_synced_at, ma.id AS asset_id, ma.public_url AS media_public_url, ma.thumbnail_url AS media_thumbnail_url, ma.kind AS media_kind
      FROM business_locations bl
      LEFT JOIN media_placements mp ON mp.organization_id = bl.organization_id AND mp.owner_type = 'business_location' AND mp.owner_id = bl.id AND mp.slot = 'hero' AND mp.sort_order = 0 AND mp.status = 'active'
      LEFT JOIN media_assets ma ON mp.asset_id = ma.id AND ma.status = 'active'
        AND ma.organization_id = bl.organization_id AND ma.organization_id = bl.organization_id
      WHERE bl.organization_id = ? AND bl.status = 'active'
      ORDER BY bl.title ASC
    `, [organizationId])

    const parsedLocations = (locations || []).map((location: ApiValue) => {
      const { asset_id, media_public_url, media_thumbnail_url, media_kind, ...fields } = location
      return {
        ...fields,
        address: location.address ? JSON.parse(location.address) : null,
        opening_hours: location.opening_hours ? JSON.parse(location.opening_hours) : null,
        media: asset_id ? [{ asset_id, slot: 'hero', public_url: media_public_url, thumbnail_url: media_thumbnail_url, kind: media_kind }] : [],
      }
    })

    return jsonResponse({
      success: true, locations: parsedLocations, count: parsedLocations.length
    })

  } catch (error) {
    rethrowHttpError(error)
    console.error('Failed to get business locations:', error)
    return jsonResponse({
      error: 'Failed to get business locations'
    }, { status: 500 })
  }
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
