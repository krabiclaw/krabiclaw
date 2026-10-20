import { parseDateTime } from '@internationalized/date'

const UTC_ALIASES = new Set(['UTC', 'Etc/UTC', 'Etc/GMT', 'GMT'])

// Zones a business can actually be in. UTC and the Etc/* zones are coordinate
// systems, not places: nobody opens at 9am UTC, and offering them invites an
// owner to pick one and have every opening hour render an hour or seven off.
export const TIMEZONE_OPTIONS = (() => {
  const options = typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : []
  return options.filter(zone => !UTC_ALIASES.has(zone) && !zone.startsWith('Etc/'))
})()

/**
 * A zone named the way an owner thinks of it — "Bangkok · GMT+7" rather than
 * "Asia/Bangkok". The offset comes from the current date so it follows DST,
 * and carries no clock time: a live time would differ between the server
 * render and hydration.
 */
export function timezoneLabel(zone: string): string {
  const city = zone.split('/').pop()?.replace(/_/g, ' ') ?? zone
  try {
    const offset = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(new Date())
      .find(part => part.type === 'timeZoneName')?.value
    return offset ? `${city} · ${offset}` : city
  } catch {
    return city
  }
}

export function normalizeTimezone(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return UTC_ALIASES.has(trimmed) ? 'UTC' : trimmed
}

export function isValidTimezone(value: string | null | undefined): value is string {
  const normalized = normalizeTimezone(value)
  if (!normalized) return false

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value! })
    return true
  } catch {
    return false
  }
}

// Calendar dates and local times are civil values, never timestamp instants.
// UTC below anchors civil formatting so neither SSR nor the browser moves them.
export const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
export const MINUTE_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/
export const PRECISE_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?$/
export const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
export const calendarDateSchema = { type: 'string', format: 'date', pattern: CALENDAR_DATE_PATTERN.source, description: 'Gregorian calendar date, YYYY-MM-DD. No timezone conversion.' } as const
export const minuteTimeSchema = { type: 'string', pattern: MINUTE_TIME_PATTERN.source, description: 'Local wall-clock time, HH:mm (24-hour), in the explicitly selected location timezone.' } as const
export const preciseTimeSchema = { type: 'string', pattern: PRECISE_TIME_PATTERN.source, description: 'Local wall-clock time, HH:mm:ss with optional fractional seconds. Not a UTC instant.' } as const
export const instantSchema = { type: 'string', format: 'date-time', pattern: INSTANT_PATTERN.source, description: 'RFC 3339 instant with an explicit Z or numeric UTC offset. Offsetless timestamps are invalid.' } as const
export const timezoneSchema = { type: 'string', minLength: 1, description: 'Explicit IANA timezone identifier, such as Asia/Bangkok. Missing timezone is an error, never the browser timezone.' } as const

export function isValidCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !CALENDAR_DATE_PATTERN.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
export function assertCalendarDate(value: unknown): asserts value is string {
  if (!isValidCalendarDate(value)) throw new Error('A valid Gregorian YYYY-MM-DD calendar date is required')
}
export function isValidInstant(value: unknown): value is string {
  return typeof value === 'string' && INSTANT_PATTERN.test(value) && isValidCalendarDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value))
}
export function instantDate(value: string | Date): Date {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('Invalid timestamp instant')
    return value
  }
  if (!isValidInstant(value)) throw new Error('Timestamp must be RFC 3339 with an explicit UTC offset')
  return new Date(value)
}
export function formatCalendarDate(value: string, locale: string, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }): string {
  assertCalendarDate(value)
  return new Intl.DateTimeFormat(locale, { ...options, calendar: 'gregory', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`))
}
export function formatTime(value: string, locale: string): string {
  if (!MINUTE_TIME_PATTERN.test(value) && !PRECISE_TIME_PATTERN.test(value)) throw new Error('Invalid local wall-clock time')
  const time = MINUTE_TIME_PATTERN.test(value) ? `${value}:00` : value
  const meaningfulSeconds = /[1-9]/.test(time.slice(6))
  const parts = new Intl.DateTimeFormat(locale, { calendar: 'gregory', hour: 'numeric', minute: '2-digit', ...(meaningfulSeconds ? { second: '2-digit' as const } : {}), timeZone: 'UTC' }).formatToParts(new Date(`2000-01-01T${time}Z`))
  const fraction = time.includes('.') ? time.slice(time.indexOf('.')) : ''
  return parts.map(part => part.type === 'second' ? part.value + fraction : part.value).join('').replace(/[\u00a0\u202f]/g, ' ')
}
export function formatTimestamp(value: string | Date, locale: string, timeZone: string, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }): string {
  if (!isValidTimezone(timeZone)) throw new Error('A valid explicit timezone is required')
  return new Intl.DateTimeFormat(locale, { ...options, calendar: 'gregory', timeZone }).format(instantDate(value))
}
export function localPartsAt(instant: Date, timeZone: string) {
  if (!isValidTimezone(timeZone)) throw new Error('A valid explicit timezone is required')
  const parts = new Intl.DateTimeFormat('en-US', { calendar: 'gregory', numberingSystem: 'latn', timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instantDate(instant))
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second) }
}
export function localDateAt(instant: Date, timeZone: string): string {
  const p = localPartsAt(instant, timeZone)
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}
export function localNow(timeZone: string, now: Date = new Date()): { date: string; time: string } {
  const p = localPartsAt(now, timeZone)
  return { date: localDateAt(now, timeZone), time: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}` }
}
export function addLocalDays(value: string, days: number): string {
  assertCalendarDate(value)
  if (!Number.isInteger(days)) throw new Error('Calendar day offset must be an integer')
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

// Bookings must identify exactly one instant. Calendar-day boundaries explicitly
// include the whole day: the earlier repeated midnight or the end of a gap.
export function localDateTimeToInstant(date: string, time: string, timeZone: string, disambiguation: 'reject' | 'compatible' | 'earlier' | 'later' = 'reject'): Date {
  assertCalendarDate(date)
  if (!MINUTE_TIME_PATTERN.test(time) && !PRECISE_TIME_PATTERN.test(time)) throw new Error('Invalid local time')
  if (!isValidTimezone(timeZone)) throw new Error('A valid explicit timezone is required')
  return parseDateTime(`${date}T${time}`).toDate(timeZone, disambiguation)
}

// Countries whose territory lies in exactly one IANA zone, from the tz database's
// zone.tab (one row per country). Multi-zone countries (US, AU, BR, ID, …) are
// deliberately absent: seeding a zone for them would be a guess, so the owner
// picks from the searchable list instead.
const SINGLE_TIMEZONE_BY_COUNTRY: Readonly<Record<string, string>> = {
  AD: 'Europe/Andorra', AE: 'Asia/Dubai', AF: 'Asia/Kabul', AG: 'America/Antigua',
  AI: 'America/Anguilla', AL: 'Europe/Tirane', AM: 'Asia/Yerevan', AO: 'Africa/Luanda',
  AS: 'Pacific/Pago_Pago', AT: 'Europe/Vienna', AW: 'America/Aruba', AX: 'Europe/Mariehamn',
  AZ: 'Asia/Baku', BA: 'Europe/Sarajevo', BB: 'America/Barbados', BD: 'Asia/Dhaka',
  BE: 'Europe/Brussels', BF: 'Africa/Ouagadougou', BG: 'Europe/Sofia', BH: 'Asia/Bahrain',
  BI: 'Africa/Bujumbura', BJ: 'Africa/Porto-Novo', BL: 'America/St_Barthelemy', BM: 'Atlantic/Bermuda',
  BN: 'Asia/Brunei', BO: 'America/La_Paz', BQ: 'America/Kralendijk', BS: 'America/Nassau',
  BT: 'Asia/Thimphu', BW: 'Africa/Gaborone', BY: 'Europe/Minsk', BZ: 'America/Belize',
  CC: 'Indian/Cocos', CF: 'Africa/Bangui', CG: 'Africa/Brazzaville', CH: 'Europe/Zurich',
  CI: 'Africa/Abidjan', CK: 'Pacific/Rarotonga', CM: 'Africa/Douala', CO: 'America/Bogota',
  CR: 'America/Costa_Rica', CU: 'America/Havana', CV: 'Atlantic/Cape_Verde', CW: 'America/Curacao',
  CX: 'Indian/Christmas', CZ: 'Europe/Prague', DJ: 'Africa/Djibouti', DK: 'Europe/Copenhagen',
  DM: 'America/Dominica', DO: 'America/Santo_Domingo', DZ: 'Africa/Algiers', EE: 'Europe/Tallinn',
  EG: 'Africa/Cairo', EH: 'Africa/El_Aaiun', ER: 'Africa/Asmara', ET: 'Africa/Addis_Ababa',
  FI: 'Europe/Helsinki', FJ: 'Pacific/Fiji', FK: 'Atlantic/Stanley', FO: 'Atlantic/Faroe',
  FR: 'Europe/Paris', GA: 'Africa/Libreville', GB: 'Europe/London', GD: 'America/Grenada',
  GE: 'Asia/Tbilisi', GF: 'America/Cayenne', GG: 'Europe/Guernsey', GH: 'Africa/Accra',
  GI: 'Europe/Gibraltar', GM: 'Africa/Banjul', GN: 'Africa/Conakry', GP: 'America/Guadeloupe',
  GQ: 'Africa/Malabo', GR: 'Europe/Athens', GS: 'Atlantic/South_Georgia', GT: 'America/Guatemala',
  GU: 'Pacific/Guam', GW: 'Africa/Bissau', GY: 'America/Guyana', HK: 'Asia/Hong_Kong',
  HN: 'America/Tegucigalpa', HR: 'Europe/Zagreb', HT: 'America/Port-au-Prince', HU: 'Europe/Budapest',
  IE: 'Europe/Dublin', IL: 'Asia/Jerusalem', IM: 'Europe/Isle_of_Man', IN: 'Asia/Kolkata',
  IO: 'Indian/Chagos', IQ: 'Asia/Baghdad', IR: 'Asia/Tehran', IS: 'Atlantic/Reykjavik',
  IT: 'Europe/Rome', JE: 'Europe/Jersey', JM: 'America/Jamaica', JO: 'Asia/Amman',
  JP: 'Asia/Tokyo', KE: 'Africa/Nairobi', KG: 'Asia/Bishkek', KH: 'Asia/Phnom_Penh',
  KM: 'Indian/Comoro', KN: 'America/St_Kitts', KP: 'Asia/Pyongyang', KR: 'Asia/Seoul',
  KW: 'Asia/Kuwait', KY: 'America/Cayman', LA: 'Asia/Vientiane', LB: 'Asia/Beirut',
  LC: 'America/St_Lucia', LI: 'Europe/Vaduz', LK: 'Asia/Colombo', LR: 'Africa/Monrovia',
  LS: 'Africa/Maseru', LT: 'Europe/Vilnius', LU: 'Europe/Luxembourg', LV: 'Europe/Riga',
  LY: 'Africa/Tripoli', MA: 'Africa/Casablanca', MC: 'Europe/Monaco', MD: 'Europe/Chisinau',
  ME: 'Europe/Podgorica', MF: 'America/Marigot', MG: 'Indian/Antananarivo', MK: 'Europe/Skopje',
  ML: 'Africa/Bamako', MM: 'Asia/Yangon', MO: 'Asia/Macau', MP: 'Pacific/Saipan',
  MQ: 'America/Martinique', MR: 'Africa/Nouakchott', MS: 'America/Montserrat', MT: 'Europe/Malta',
  MU: 'Indian/Mauritius', MV: 'Indian/Maldives', MW: 'Africa/Blantyre', MZ: 'Africa/Maputo',
  NA: 'Africa/Windhoek', NC: 'Pacific/Noumea', NE: 'Africa/Niamey', NF: 'Pacific/Norfolk',
  NG: 'Africa/Lagos', NI: 'America/Managua', NL: 'Europe/Amsterdam', NO: 'Europe/Oslo',
  NP: 'Asia/Kathmandu', NR: 'Pacific/Nauru', NU: 'Pacific/Niue', OM: 'Asia/Muscat',
  PA: 'America/Panama', PE: 'America/Lima', PH: 'Asia/Manila', PK: 'Asia/Karachi',
  PL: 'Europe/Warsaw', PM: 'America/Miquelon', PN: 'Pacific/Pitcairn', PR: 'America/Puerto_Rico',
  PW: 'Pacific/Palau', PY: 'America/Asuncion', QA: 'Asia/Qatar', RE: 'Indian/Reunion',
  RO: 'Europe/Bucharest', RS: 'Europe/Belgrade', RW: 'Africa/Kigali', SA: 'Asia/Riyadh',
  SB: 'Pacific/Guadalcanal', SC: 'Indian/Mahe', SD: 'Africa/Khartoum', SE: 'Europe/Stockholm',
  SG: 'Asia/Singapore', SH: 'Atlantic/St_Helena', SI: 'Europe/Ljubljana', SJ: 'Arctic/Longyearbyen',
  SK: 'Europe/Bratislava', SL: 'Africa/Freetown', SM: 'Europe/San_Marino', SN: 'Africa/Dakar',
  SO: 'Africa/Mogadishu', SR: 'America/Paramaribo', SS: 'Africa/Juba', ST: 'Africa/Sao_Tome',
  SV: 'America/El_Salvador', SX: 'America/Lower_Princes', SY: 'Asia/Damascus', SZ: 'Africa/Mbabane',
  TC: 'America/Grand_Turk', TD: 'Africa/Ndjamena', TF: 'Indian/Kerguelen', TG: 'Africa/Lome',
  TH: 'Asia/Bangkok', TJ: 'Asia/Dushanbe', TK: 'Pacific/Fakaofo', TL: 'Asia/Dili',
  TM: 'Asia/Ashgabat', TN: 'Africa/Tunis', TO: 'Pacific/Tongatapu', TR: 'Europe/Istanbul',
  TT: 'America/Port_of_Spain', TV: 'Pacific/Funafuti', TW: 'Asia/Taipei', TZ: 'Africa/Dar_es_Salaam',
  UG: 'Africa/Kampala', UY: 'America/Montevideo', VA: 'Europe/Vatican', VC: 'America/St_Vincent',
  VE: 'America/Caracas', VG: 'America/Tortola', VI: 'America/St_Thomas', VN: 'Asia/Ho_Chi_Minh',
  VU: 'Pacific/Efate', WF: 'Pacific/Wallis', WS: 'Pacific/Apia', YE: 'Asia/Aden',
  YT: 'Indian/Mayotte', ZA: 'Africa/Johannesburg', ZM: 'Africa/Lusaka', ZW: 'Africa/Harare',
}

// The one IANA zone for an ISO-3166 alpha-2 country, spelled the way this
// runtime's Intl lists it (ICU still reports Asia/Calcutta for Asia/Kolkata), or
// null when the input is not a country code or the country spans several zones.
export function singleTimezoneForCountry(country: string): string | null {
  if (!/^[A-Za-z]{2}$/.test(country)) return null
  const zone = SINGLE_TIMEZONE_BY_COUNTRY[country.toUpperCase()]
  if (!zone) return null
  if (TIMEZONE_OPTIONS.includes(zone)) return zone
  const resolved = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone
  return TIMEZONE_OPTIONS.includes(resolved) ? resolved : null
}
