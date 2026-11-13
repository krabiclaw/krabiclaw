import { HTTPError } from 'nitro'
import type { OfferingSetupAnswer, OfferingSetupField } from '~/shared/offering-setup'
import { getLocation, updateLocation } from '~/server/utils/location-management'
import { assertRoleAllows } from '~/server/utils/member-access'
import { invalidOfferingAnswer, offeringField, offeringSetupChanged, submittedValue, type OfferingSetupContext } from '~/server/utils/offering-setup'
import { getPhoneCountry, listPhoneCountries } from '~/utils/phone'
import { postalAddressFromAnswers, type PostalAddress } from '~/utils/postal-address'

export function offeringHasStreetAddress(address: PostalAddress | null) {
  if (!address) return false
  const street = address.addressLines[0]?.trim()
  const area = [address.locality, address.administrativeArea].filter(Boolean).join(', ')
  return Boolean(street && street !== area && street !== address.sublocality && street !== address.postalCode)
}

export function offeringAddressFields(address: PostalAddress | null, defaults?: {
  country?: string | null
  city?: string | null
  region?: string | null
  postalCode?: string | null
}): OfferingSetupField[] {
  const street = offeringHasStreetAddress(address)
  return [
    offeringField('country', 'Country', 'country', address?.regionCode ?? defaults?.country ?? '', {
      choices: listPhoneCountries().map(({ code, name, emoji }) => ({ value: code, label: name, flag: emoji })),
    }),
    offeringField('street_address', 'Street address', 'text', street ? address?.addressLines[0] : ''),
    offeringField('address_line_2', 'Unit, floor, or building', 'text', street ? address?.addressLines.slice(1).join(', ') : '', { optional: true }),
    offeringField('city', 'City or town', 'text', address?.locality ?? defaults?.city ?? ''),
    offeringField('region', 'Province or region', 'text', address?.administrativeArea ?? defaults?.region ?? '', { optional: true }),
    offeringField('postal_code', 'Postal code', 'text', address?.postalCode ?? defaults?.postalCode ?? '', { optional: true }),
  ]
}

export async function saveOfferingAddress(context: OfferingSetupContext, locationId: string, answer: OfferingSetupAnswer) {
  const { env, organizationId, actorId, principal } = context
  const db = env.DB
  await assertRoleAllows({ ...principal, permissions: { locations: ['update'] } })
  const current = await getLocation(db, organizationId, locationId)
  if (!current || current.status !== 'active') throw offeringSetupChanged()
  const streetAddress = submittedValue(answer, 'street_address')
  const city = submittedValue(answer, 'city')
  const country = submittedValue(answer, 'country')
  if (!getPhoneCountry(country)) throw invalidOfferingAnswer('Choose the country for this address')
  if (!streetAddress || !city) throw invalidOfferingAnswer('Enter the street address and city or town')
  const address = postalAddressFromAnswers({
    country, streetAddress, city, addressLine2: submittedValue(answer, 'address_line_2'),
    region: submittedValue(answer, 'region'), postalCode: submittedValue(answer, 'postal_code'),
    sublocality: current.address?.sublocality,
  })
  if (!address) throw invalidOfferingAnswer('Enter the street address and city or town')
  if (current.address?.languageCode) address.languageCode = current.address.languageCode
  const result = await updateLocation(db, organizationId, locationId, {
    address,
    updated_at: answer.revision ?? (typeof current.updated_at === 'string' ? current.updated_at : undefined),
  }, actorId, env)
  if (result.status !== 200) throw new HTTPError({
    statusCode: result.status,
    statusMessage: 'error' in result.data ? String(result.data.error) : 'Could not save the address',
  })
}
