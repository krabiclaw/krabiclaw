import { queryAll, type DbClient } from '~/server/db'
import { groupMediaPlacements, mediaPlacementsQuery, readMediaPlacements, type StoredMediaPlacementItem } from '~/server/utils/media-asset-manager'
import { mediaStillUrl, resolveOwnerPicture, type MediaPlacementOwnerType } from '~/shared/media-placement-contract'

/**
 * The picture a surface leads with for an owner: a notification's hero, an
 * agenda row, a booking's detail. `resolveOwnerPicture` decides it; this reads
 * the placements it needs. An experience booking leads with the experience and
 * a table reservation with its location, because that is what the guest is
 * looking at.
 * Record photos set organizationFallback to false so the organization's
 * sharing image cannot stand in for the Product or location itself.
 *
 * Null is a first-class answer: nothing is substituted, and no stock or
 * placeholder image is invented — tenant surfaces render the tenant's own
 * content or none.
 */
export interface HeroImage {
  imageUrl: string
  alt: string
}

export async function loadOwnerPictures(
  db: DbClient,
  organizationId: string,
  ownerType: MediaPlacementOwnerType,
  ownerIds: readonly string[],
  options: { organizationFallback?: boolean } = {},
): Promise<Map<string, HeroImage | null>> {
  const ids = [...new Set(ownerIds)]
  if (!ids.length) return new Map()
  const includeOrganizationFallback = options.organizationFallback !== false
  const { query, params } = mediaPlacementsQuery({ organizationId, ownerType, owners: ids, includeOrganizationFallback })
  const rows = await queryAll<{ owner_type: MediaPlacementOwnerType }>(db, query, params)
  const ownerPlacements = groupMediaPlacements(rows.filter(row => row.owner_type === ownerType), ids)
  const organizationMedia = includeOrganizationFallback
    ? groupMediaPlacements(rows.filter(row => row.owner_type === 'organization')).get(organizationId) ?? []
    : []
  return new Map(ids.map(id => [id, ownerPicture(ownerType, ownerPlacements.get(id) ?? [], organizationMedia)]))
}

export type PicturePlacement = Pick<StoredMediaPlacementItem, 'kind' | 'slot' | 'public_url' | 'thumbnail_url' | 'alt_text'>

/** The picture `resolveOwnerPicture` picks from placements already read. */
export function ownerPicture(ownerType: MediaPlacementOwnerType, ownerMedia: PicturePlacement[], organizationMedia: PicturePlacement[]): HeroImage | null {
  const picture = resolveOwnerPicture(ownerType, ownerMedia, organizationMedia)
  const imageUrl = mediaStillUrl(picture)
  return picture && imageUrl ? { imageUrl, alt: picture.alt_text ?? '' } : null
}

/** An organization's brand mark: its `logo`, or none. */
export async function organizationLogo(db: DbClient, organizationId: string): Promise<string | null> {
  const placements = await readMediaPlacements(db, {
    organizationId,
    ownerType: 'organization',
    ownerIds: [organizationId],
    slot: 'logo',
  })
  return mediaStillUrl(placements.get(organizationId)?.[0]) ?? null
}
