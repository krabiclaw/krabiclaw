// Get public business locations for a site
import { defineHandler } from 'nitro'
import { queryAll, queryFirst } from '~/server/db'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { projectPublicLocation, type PublicLocationPrivacySource } from '~/shared/location-sharing'
import { publicLocationPrivacySql } from '~/server/utils/public-location-privacy'
import { parsePostalAddress } from '~/utils/postal-address'

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
interface JsonObject {
  [key: string]: JsonValue
}

interface OrganizationRow {
  id: string
  status: 'active'
}

interface LocationRow extends PublicLocationPrivacySource {
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
  rating: number | null
  review_count: number | null
  status: string
  last_synced_at: string | null
  city: string | null
  public_url: string | null
  kind: string | null
}

export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined

  if (!organizationId) {
    return jsonResponse({
      error: 'Unknown tenant'
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
    const organization = await queryFirst<OrganizationRow>(db, `
      SELECT id, status FROM organization
      WHERE id = ? AND status = 'active'
      LIMIT 1
    `, [organizationId])

    if (!organization) {
      return jsonResponse({
        error: 'Organization not found or inactive'
      }, { status: 404 })
    }

    // Get active business locations for this site
    const locationRows = await queryAll<LocationRow & {
      asset_id: string | null
      media_public_url: string | null
      media_kind: string | null
      media_thumbnail_url: string | null
    }>(db, `
      SELECT bl.id, bl.slug, bl.title, bl.address, bl.phone, bl.website_url, bl.maps_url, bl.latitude, bl.longitude, ${publicLocationPrivacySql('bl')}, bl.opening_hours, bl.rating, bl.review_count, bl.status, bl.last_synced_at, ma.id AS asset_id, ma.public_url AS media_public_url, ma.kind AS media_kind, ma.thumbnail_url AS media_thumbnail_url
      FROM business_locations bl
      LEFT JOIN media_placements mp ON mp.organization_id = bl.organization_id AND mp.owner_type = 'business_location' AND mp.owner_id = bl.id AND mp.slot = 'hero' AND mp.sort_order = 0 AND mp.status = 'active'
      LEFT JOIN media_assets ma ON mp.asset_id = ma.id AND ma.status = 'active'
        AND ma.organization_id = bl.organization_id
      WHERE bl.organization_id = ? AND bl.status = 'active'
      ORDER BY bl.title ASC
    `, [organizationId])


    const parsedLocations = locationRows.map((location) => {
      return projectPublicLocation({
        id: location.id, slug: location.slug, title: location.title, address: parsePostalAddress(location.address), phone: location.phone, website_url: location.website_url, maps_url: location.maps_url,
        latitude: location.latitude, longitude: location.longitude, opening_hours: location.opening_hours ? JSON.parse(location.opening_hours) : null, rating: location.rating, review_count: location.review_count, status: location.status, media: location.media_public_url ? [{ asset_id: location.asset_id, slot: 'hero', public_url: location.media_public_url, thumbnail_url: location.media_thumbnail_url, kind: location.media_kind }] : []
      }, location)
    })

    return jsonResponse({
      success: true, locations: parsedLocations, count: parsedLocations.length
    })

  } catch (error) {
    console.error('Failed to get public business locations:', error)
    return jsonResponse({
      error: 'Failed to get business locations'
    }, { status: 500 })
  }
})
