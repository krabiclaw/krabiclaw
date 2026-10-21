// Isomorphic phone parse/format utility — Nuxt's shared client+server auto-import
// directory (see utils/organization-access.ts for precedent). Every phone read/write
// boundary in the app should go through this file rather than a bespoke regex.
//
// Uses libphonenumber-js's `/min` metadata build so this shared client and server
// utility stays light in the client bundle.
import {
  AsYouType,
  getCountries,
  getCountryCallingCode,
  getExampleNumber,
  parsePhoneNumberFromString,
  validatePhoneNumberLength,
  type CountryCode,
} from 'libphonenumber-js/min'
import mobileExamples from 'libphonenumber-js/mobile/examples'

export type { CountryCode }

export interface PhoneCountry {
  code: CountryCode
  /** English region name from `Intl.DisplayNames`, e.g. "Thailand". */
  name: string
  /** Regional-indicator flag derived from the ISO code, e.g. "🇹🇭". */
  emoji: string
  /** Calling code with the plus sign, e.g. "+66". */
  dialCode: string
}

function flagEmoji(code: CountryCode): string {
  return Array.from(code, ch => String.fromCodePoint(0x1F1E6 + ch.charCodeAt(0) - 65)).join('')
}

let phoneCountries: PhoneCountry[] | null = null

/**
 * Every country libphonenumber-js's metadata knows how to parse, named in
 * English and sorted by name. This is the single country list for the app:
 * the onboarding address country and the phone country picker both read it,
 * so the two can never disagree on which countries exist.
 */
export function listPhoneCountries(): PhoneCountry[] {
  if (phoneCountries) return phoneCountries
  const regionNames = new Intl.DisplayNames('en', { type: 'region' })
  phoneCountries = getCountries()
    .map(code => {
      const name = regionNames.of(code)
      if (!name) throw new Error(`No English region name for phone country ${code}`)
      return { code, name, emoji: flagEmoji(code), dialCode: `+${getCountryCallingCode(code)}` }
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
  return phoneCountries
}

/** The country for an ISO code, or `null` when the code is not one libphonenumber-js knows. */
export function getPhoneCountry(code: string | null | undefined): PhoneCountry | null {
  if (!code) return null
  return listPhoneCountries().find(country => country.code === code) ?? null
}

/** A mobile number of `country` in its national format, e.g. "081 234 5678", for a field's placeholder. */
export function examplePhone(country: CountryCode): string | null {
  return getExampleNumber(country, mobileExamples)?.formatNational() ?? null
}

/**
 * Format partial national input as the owner types it, e.g. "0812345678" with
 * country TH becomes "081 234 5678". Trunk prefixes ("0" in TH/GB/AU) and a
 * leading "+" (international input) are both understood, so the result always
 * round-trips through `parsePhone(result, { defaultCountry })`.
 */
export function formatPhoneAsTyped(input: string, country?: CountryCode): string {
  return new AsYouType(country).input(input)
}

/**
 * True when `input` already holds more digits than `country`'s numbering plan
 * allows. The formatter happily keeps appending digits past the end of a valid
 * number, which lets an owner type a number no carrier could route and only
 * learn about it from the error under the field; callers use this to refuse
 * the keystroke instead.
 */
export function exceedsPhoneLength(input: string, country: CountryCode): boolean {
  if (validatePhoneNumberLength(input, country) === 'TOO_LONG') return true
  // E.164's hard ceiling: 15 digits including the country calling code. Some
  // countries' metadata still calls longer strings "possible" (Thailand reports
  // possible at 14 national digits), and no such number exists.
  const callingCode = getCountryCallingCode(country)
  const digits = input.replace(/\D/g, '')
  // `digits` is every digit typed, so a number entered in international form
  // already carries the calling code. Adding it again counted it twice and
  // refused valid numbers a digit or two short of the ceiling.
  const nationalDigits = input.trim().startsWith('+') && digits.startsWith(callingCode)
    ? digits.slice(callingCode.length)
    : digits
  return nationalDigits.length + callingCode.length > 15
}

export interface PhoneParseResult {
  e164: string | null
  nationalFormat: string | null
  country: CountryCode | null
  valid: boolean
  possible: boolean
  raw: string
}

function emptyResult(raw: string): PhoneParseResult {
  return { e164: null, nationalFormat: null, country: null, valid: false, possible: false, raw }
}

/**
 * Parse a phone number string into a structured result. Never throws — always
 * returns a result object so callers can decide strict-vs-lenient handling
 * themselves (managers/operational identity paths reject invalid results;
 * guest-facing paths fall back to the raw string).
 */
export function parsePhone(input: string, opts?: { defaultCountry?: CountryCode }): PhoneParseResult {
  const raw = typeof input === 'string' ? input : String(input ?? '')
  const trimmed = raw.trim()
  if (!trimmed) return emptyResult(raw)

  try {
    const parsed = parsePhoneNumberFromString(trimmed, opts?.defaultCountry)
    if (!parsed) return emptyResult(raw)

    return {
      e164: parsed.number,
      nationalFormat: parsed.formatNational(),
      country: parsed.country ?? null,
      valid: parsed.isValid(),
      possible: parsed.isPossible(),
      raw,
    }
  } catch {
    return emptyResult(raw)
  }
}

/**
 * The one rule for a stored phone number: international input with its calling
 * code that names a real number, as E.164; anything else is `null` and the
 * caller refuses it. A national number has no country of its own here — the
 * entry field (components/PhoneInput.vue) is what resolves one.
 */
export function toE164(input: string): string | null {
  const result = parsePhone(input)
  return result.valid ? result.e164 : null
}

/** A stored number as people read it, e.g. "+66 81 234 5678"; text that is not one is shown as it was stored. */
export function formatPhone(value: string): string {
  return parsePhoneNumberFromString(value)?.formatInternational() ?? value
}

/**
 * Strict variant for manager/operational identity paths that must reject an
 * invalid number outright (mirrors the old `server/utils/whatsapp.ts`
 * `normalizePhone`'s throw-based contract). Guest-facing/lenient call sites
 * should use `parsePhone` directly instead and fall back to the raw value.
 */
export function parsePhoneOrThrow(input: string, opts?: { defaultCountry?: CountryCode }): string {
  const result = parsePhone(input, opts)
  if (!result.valid || !result.e164) throw new Error(`Invalid phone number: ${input}`)
  return result.e164
}

/**
 * Masked display format for an already-normalized E.164 number, e.g.
 * "+66 xx-xxx-x123" — used to show "where the reply is going" without
 * fully exposing the recipient's number (see Workstream 5's pre-send
 * disclosure requirement).
 */
export function formatForDisplay(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164)
  if (!parsed) return e164

  const countryCallingCode = `+${parsed.countryCallingCode}`
  const nationalDigits = parsed.nationalNumber
  const visibleTailLength = nationalDigits.length > 4 ? 4 : Math.min(3, nationalDigits.length)
  const maskedLength = Math.max(0, nationalDigits.length - visibleTailLength)
  const masked = 'x'.repeat(maskedLength)
  const visibleTail = nationalDigits.slice(nationalDigits.length - visibleTailLength)

  return `${countryCallingCode} ${masked}${visibleTail}`.trim()
}

/**
 * Identifies the phone metadata implementation that produced a stored E.164
 * value/verification row, so future metadata upgrades can be reasoned about
 * per-row instead of assuming every stored number was normalized the same way.
 * Hardcoded rather than dynamically read from package.json — dynamic reads of
 * package.json aren't reliable in this isomorphic (client + server + Workers)
 * context. Update this string when bumping the libphonenumber-js dependency.
 */
export const PHONE_METADATA_VERSION = 'libphonenumber-js@1.13.12'

/**
 * Meta's WhatsApp webhook `from`/`recipient_id` fields are always a full
 * international MSISDN with no leading "+" (e.g. "14155552671" for a US
 * number, not "+14155552671" or a Thai-local "0812345678"). Parsing that
 * through `parsePhoneOrThrow`'s `defaultCountry` fallback (the convention used
 * elsewhere in this codebase for user-typed input) misinterprets it as a
 * national number for the default country and throws for any sender outside
 * that country. Prepending "+" makes it unambiguous international input,
 * which needs no default-country guess.
 */
export function parseMetaMsisdn(raw: string): string {
  const trimmed = raw.trim()
  return parsePhoneOrThrow(trimmed.startsWith('+') ? trimmed : `+${trimmed}`)
}
