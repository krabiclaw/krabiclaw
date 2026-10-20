import { parseStayMapSharing, type StayMapSharing } from '~/shared/stay-listing'
import type { PublicLocationDisclosure, PublicLocationArea } from '~/types/public-location'
import { calculateMapEmbedUrl, coordinatesFailure } from '~/utils/location-map'
import { getPhoneCountry } from '~/utils/phone'
import type { PostalAddress } from '~/utils/postal-address'

export interface PublicLocationPrivacySource {
  stay_map_sharing: unknown
  is_stay_location: unknown
}

export function publicLocationIsProtected(value: unknown): boolean {
  if (value !== 0 && value !== 1) throw new TypeError('Public location privacy context is unavailable')
  return value === 1
}

export function publicLocationPrivacy(source: PublicLocationPrivacySource): { protected: boolean; mode: StayMapSharing } {
  return { protected: publicLocationIsProtected(source.is_stay_location), mode: parseStayMapSharing(source.stay_map_sharing) }
}

type LocationInput = {
  title: string
  address: PostalAddress | null
  maps_url?: string | null
  latitude: number | null
  longitude: number | null
}

const coordinatePair = (location: LocationInput): { latitude: number; longitude: number } | null => {
  const coordinates = coordinatesFailure(location)
  if (coordinates) throw new TypeError(coordinates.error)
  if (location.latitude == null || location.longitude == null) return null
  return { latitude: location.latitude, longitude: location.longitude }
}

/** Call after localization, before constructing a map or serializing any public location. */
export function projectPublicLocation<T extends LocationInput>(location: T, source: PublicLocationPrivacySource): T & PublicLocationDisclosure {
  const privacy = publicLocationPrivacy(source)
  const pin = coordinatePair(location)
  if (!privacy.protected) return {
    ...location,
    address: location.address,
    maps_url: location.maps_url ?? null,
    latitude: pin?.latitude ?? null,
    longitude: pin?.longitude ?? null,
    map_embed_url: calculateMapEmbedUrl(location),
    stay_map_sharing: null,
    public_area: null,
  }

  const locality = location.address?.locality?.trim() || null
  const administrativeArea = location.address?.administrativeArea?.trim() || null
  const regionCode = location.address?.regionCode ?? null
  const country = regionCode ? getPhoneCountry(regionCode)?.name : null
  if (regionCode && !country) throw new TypeError('Public location country is invalid')
  const label = [...new Set([locality, administrativeArea, country].filter((part): part is string => Boolean(part)))].join(', ') || null
  const approximate = privacy.mode === 'general' || pin === null
  // A fixed cell center does not expose the original point or change between requests.
  const center = pin && approximate ? {
    latitude: Number(Math.min(89.99, Math.max(-89.99, Math.floor(pin.latitude / 0.02) * 0.02 + 0.01)).toFixed(2)),
    longitude: Number(Math.min(179.99, Math.max(-179.99, Math.floor(pin.longitude / 0.02) * 0.02 + 0.01)).toFixed(2)),
  } : pin
  const publicArea: PublicLocationArea = {
    label,
    locality,
    administrative_area: administrativeArea,
    region_code: regionCode,
    center,
    radius_meters: approximate && center ? 2000 : null,
    approximate,
  }
  const mapEmbedUrl = center
    ? calculateMapEmbedUrl({ title: '', latitude: center.latitude, longitude: center.longitude })
    : calculateMapEmbedUrl({ title: '', area_label: label })
  return {
    ...location,
    address: null,
    maps_url: null,
    google_place_id: null,
    google_review_url: null,
    map_embed_url: mapEmbedUrl,
    latitude: approximate ? null : pin?.latitude ?? null,
    longitude: approximate ? null : pin?.longitude ?? null,
    stay_map_sharing: privacy.mode,
    public_area: publicArea,
  }
}
