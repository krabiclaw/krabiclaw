// Get public business location by slug
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { parsePostalAddress } from '~/utils/postal-address'
import { queryFirst } from '~/server/db'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { projectPublicLocation } from '~/shared/location-sharing'
import { publicLocationPrivacySql } from '~/server/utils/public-location-privacy'

export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined
  const slug = getRouterParam(event, 'slug')

  if (!organizationId || !slug) {
    return jsonResponse({
      error: 'Organization ID and slug are required'
    }, { status: 400 })
  }

  const env = cloudflareEnv(event)
  const db = env.db

  if (!db) {
    return jsonResponse({
      error: 'Database not available'
    }, { status: 500 })
  }

  try {
    const organization = await queryFirst<{ id: string; status: string; default_currency: string }>(
      db, `
      SELECT id, status, default_currency FROM organization
      WHERE id = ? AND status = 'active'
      LIMIT 1
    `, [organizationId], )

    if (!organization) {
      return jsonResponse({
        error: 'Organization not found or inactive'
      }, { status: 404 })
    }

    const location = await queryFirst<ApiRecord>(
      db, `
      SELECT bl.id, bl.slug, bl.title, bl.address, bl.phone, bl.website_url, bl.maps_url, bl.latitude, bl.longitude, ${publicLocationPrivacySql('bl')}, bl.opening_hours, bl.rating, bl.review_count, bl.status, bl.last_synced_at, bl.google_place_id, ma.id AS asset_id, ma.public_url AS media_public_url, ma.kind AS media_kind, ma.thumbnail_url AS media_thumbnail_url
      FROM business_locations bl
      LEFT JOIN media_placements mp ON mp.organization_id = bl.organization_id AND mp.owner_type = 'business_location' AND mp.owner_id = bl.id AND mp.slot = 'hero' AND mp.sort_order = 0 AND mp.status = 'active'
      LEFT JOIN media_assets ma ON mp.asset_id = ma.id AND ma.status = 'active'
        AND ma.organization_id = bl.organization_id
      WHERE bl.organization_id = ? AND bl.slug = ? AND bl.status = 'active'
      LIMIT 1
    `, [organizationId, slug], )

    if (!location) {
      return jsonResponse({
        error: 'Location not found'
      }, { status: 404 })
    }

    // Counts for sub-nav badges
    const photoCount = await queryFirst<{ n: number }>(
      db, `SELECT COUNT(*) as n FROM media_placements mp JOIN media_assets ma ON ma.id = mp.asset_id AND ma.status = 'active' WHERE mp.owner_type = 'business_location' AND mp.owner_id = ? AND mp.slot = 'gallery' AND mp.status = 'active'`, [location.id], )

    const qaCount = await queryFirst<{ n: number }>(
      db, `SELECT COUNT(*) as n FROM content_documents WHERE kind = 'qa' AND row_role = 'root' AND location_id = ? AND status = 'published'`, [location.id], )

    // Derive the Google review-writing URL from the Places ID when available.
    const placeId = location.google_place_id
    const google_review_url = placeId
      ? `https://search.google.com/local/writereview?placeid=${placeId}`
      : null


    // Parse JSON fields and return public-safe data (email excluded)
    const parsedLocation = projectPublicLocation({
      id: location.id, slug: location.slug, title: location.title as string, address: parsePostalAddress(location.address), phone: location.phone, website_url: location.website_url, maps_url: location.maps_url as string | null,
      latitude: location.latitude as number | null, longitude: location.longitude as number | null, opening_hours: location.opening_hours ? JSON.parse(location.opening_hours) : null, rating: location.rating, review_count: location.review_count, photo_count: photoCount?.n ?? 0, qa_count: qaCount?.n ?? 0, status: location.status, media: location.media_public_url ? [{ asset_id: location.asset_id, slot: 'hero', public_url: location.media_public_url, thumbnail_url: location.media_thumbnail_url ?? null, kind: location.media_kind }] : [], currency: organization.default_currency, google_place_id: location.google_place_id, google_review_url
    }, { stay_map_sharing: location.stay_map_sharing, is_stay_location: location.is_stay_location })

    return jsonResponse({
      success: true, location: parsedLocation
    })

  } catch (error) {
    console.error('Failed to get public business location:', error)
    return jsonResponse({
      error: 'Failed to get business location'
    }, { status: 500 })
  }
})
