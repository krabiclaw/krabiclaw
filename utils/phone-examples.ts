import { getExampleNumber, type CountryCode } from 'libphonenumber-js/min'
import mobileExamples from 'libphonenumber-js/mobile/examples'

/** A mobile number of `country` in its national format, e.g. "081 234 5678", for a field's placeholder. */
export function examplePhone(country: CountryCode): string | null {
  return getExampleNumber(country, mobileExamples)?.formatNational() ?? null
}
