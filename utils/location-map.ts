import { formatPostalAddress, type PostalAddress } from '~/utils/postal-address'

/** A pin is a latitude and longitude set together, or both cleared; null when the input names a valid one or none. */
export function coordinatesFailure(input: { latitude?: number | null; longitude?: number | null }): { error: string; field: 'latitude' | 'longitude' } | null {
  if ((input.latitude === undefined) !== (input.longitude === undefined) || (input.latitude === null) !== (input.longitude === null)) {
    return { error: "latitude and longitude are set together.", field: input.latitude === undefined || input.latitude === null ? 'latitude' : 'longitude' };
  }
  for (const [field, limit] of [["latitude", 90], ["longitude", 180]] as const) {
    const value = input[field];
    if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > limit)) {
      return { error: `${field} must be a number from -${limit} to ${limit}.`, field };
    }
  }
  return null;
}

/** Read a saved or submitted map URL; an empty value clears the destination. */
export function parseMapUrl(value: unknown): URL | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new TypeError('A map URL must use HTTP or HTTPS')
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('A map URL must use HTTP or HTTPS')
  return url
}

// Generate a canonical Google Maps embed URL from the location data already
// stored by the Places importer. This helper does not call Google.
interface MapLocation {
  title: string
  maps_url?: string | null
  latitude?: number | null
  longitude?: number | null
  address?: PostalAddress | null
  area_label?: string | null
}

export const calculateMapEmbedUrl = (loc: MapLocation) => {
  const coordinates = coordinatesFailure(loc)
  if (coordinates) throw new TypeError(coordinates.error)
  const mapsUrl = parseMapUrl(loc.maps_url)
  if (loc.latitude != null && loc.longitude != null) {
    return `https://maps.google.com/maps?q=${loc.latitude},${loc.longitude}&output=embed`
  }

  const cid = mapsUrl?.searchParams.get('cid')
  if (cid) return `https://maps.google.com/maps?cid=${encodeURIComponent(cid)}&output=embed`

  if (loc.area_label) return `https://maps.google.com/maps?q=${encodeURIComponent(loc.area_label)}&output=embed`

  const address = formatPostalAddress(loc.address ?? null)
  if (!address) return null
  const query = loc.title ? `${loc.title}, ${address}` : address
  return `https://maps.google.com/maps?q=${encodeURIComponent(String(query))}&output=embed`
}

/** The same saved map destination as the embed, opened as a guest action. */
export const calculateMapUrl = (loc: MapLocation): string | null => {
  const embed = calculateMapEmbedUrl(loc)
  if (!embed) return loc.maps_url || null
  const url = new URL(embed)
  url.searchParams.delete('output')
  return url.toString()
}
