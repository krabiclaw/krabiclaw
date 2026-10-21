
import type { H3Event } from 'nitro'
import { queryAll } from '~/server/db'
import { loadOwnerPictures } from '~/server/notifications/hero'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { parsePostalAddress } from '~/utils/postal-address'
import type { StayMapSharing } from '~/shared/stay-listing'

export interface DashboardLocationResource {
  id: string
  slug: string
  title: string
  stay_map_sharing: StayMapSharing
  status: string
  address: string | null | Record<string, unknown>
  phone: string | null
  email: string | null
}

export async function listDashboardLocationsResource(
  event: H3Event,
  scope: { organizationSlug?: string } = {},
) {
  const { db, organization } = await getDashboardContext(event, {
    organizationSlug: scope.organizationSlug,
  })
  const locations = await queryAll<DashboardLocationResource>(db, `
    SELECT id, slug, title, status, address, stay_map_sharing, phone, email
      FROM business_locations
     WHERE organization_id = ?
     ORDER BY title ASC
  `, [organization.id])
  // The picture leads a row and a Menu card alike, so the resource carries it.
  const pictures = await loadOwnerPictures(db, organization.id, 'business_location', locations.map(location => location.id))
  return {
    success: true as const,
    locations: locations.map(location => ({
      ...location,
      address: parsePostalAddress(location.address),
      imageUrl: pictures.get(location.id)?.imageUrl ?? null,
    })),
  }
}
