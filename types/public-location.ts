import type { StayMapSharing } from '~/shared/stay-listing'
import type { PostalAddress } from '~/utils/postal-address'

/** The area a host permits an unconfirmed guest to see, separate from a postal address. */
export type PublicLocationArea = {
  label: string | null
  locality: string | null
  administrative_area: string | null
  region_code: string | null
  center: { latitude: number; longitude: number } | null
  radius_meters: number | null
  approximate: boolean
}

export interface PublicLocationDisclosure {
  address: PostalAddress | null
  maps_url: string | null
  map_embed_url: string | null
  latitude: number | null
  longitude: number | null
  stay_map_sharing: StayMapSharing | null
  public_area: PublicLocationArea | null
}
