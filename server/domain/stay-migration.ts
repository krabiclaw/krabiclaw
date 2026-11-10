import { HTTPError } from 'nitro'
import { parse } from 'csv-parse/browser/esm/sync'
import { executeBatch, queryAll, queryFirst, type DbClient } from '~/server/db'
import { createStay, getStay, listStayHomes, resumeImportedStay, setStayNights, type StayAccess, type StayHome } from '~/server/domain/stays'
import { verifyStayCalendarOccupancy } from '~/server/domain/stays'
import { toE164 } from '~/utils/phone'
import { bookingDay } from '~/server/domain/requests'
import { organizationEventQuery } from '~/server/utils/organization-events'
import { currencyFractionDigits, isCurrencyCode } from '~/shared/currencies'
import { MAX_STAY_NIGHTS, STAY_CALENDAR_DAYS, STAY_PAYMENT_METHODS, type StayChannel } from '~/shared/bookings'
import { MIGRATION_FIELDS, MIGRATION_FIELD_LABELS, MIGRATION_MAX_CSV_BYTES, MIGRATION_MAX_ROWS, isMigrationReceipt, type MigrationContext, type MigrationField, type MigrationHome, type MigrationInput, type MigrationPreview, type MigrationReceipt, type MigrationRow, type MigrationStay, type MigrationVerification } from '~/shared/stay-migration'

type MigrationEnv = Parameters<typeof createStay>[1]
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const keyFor = (sourceId: string) => `hostaway:${sourceId}`
const normalized = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
const headerAliases: Record<MigrationField, string[]> = {
  source_id: ['reservationid', 'hostawayreservationid', 'id'], source_listing: ['listingid', 'hostawaylistingid', 'listingname', 'listing', 'property'],
  guest_name: ['guestname', 'guestfullname', 'name'], check_in_date: ['checkin', 'checkindate', 'arrivaldate'], check_out_date: ['checkout', 'checkoutdate', 'departuredate'],
  adults: ['adults', 'numberofadults'], children: ['children', 'numberofchildren'], infants: ['infants', 'numberofinfants'], total: ['totalprice', 'total', 'reservationtotal'],
  currency: ['currency'], status: ['status', 'reservationstatus'], channel: ['channel', 'channelname', 'sourcechannel'], channel_booking_id: ['confirmationcode', 'channelreservationid', 'channelbookingid', 'confirmationnumber'],
  payment_status: ['paymentstatus', 'paidstatus'], paid_amount: ['amountpaid', 'paidamount'], paid_on: ['paymentdate', 'paidon'], payment_method: ['paymentmethod'],
  guest_email: ['guestemail', 'email'], guest_phone: ['guestphone', 'phonenumber', 'phone'], notes: ['notes', 'hostnote', 'hostnotes'],
}
function fail(status: number, code: string, message: string): never {
  throw new HTTPError({ statusCode: status, message, data: { code } })
}
function manager(access: StayAccess) {
  if (!access.manage) fail(403, 'STAY_ROLE_REQUIRED', 'Only organization owners and admins can migrate stays')
}
function isoDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}
function dateValue(value: string, format: unknown): string {
  if (format === 'iso') {
    if (!isoDay(value)) throw new Error('Use YYYY-MM-DD dates for the selected date format')
    return value
  }
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value)
  if (!match || (format !== 'mdy' && format !== 'dmy')) throw new Error('Choose the date format used in the export; dates must match it')
  const day = format === 'mdy' ? match[2]! : match[1]!
  const month = format === 'mdy' ? match[1]! : match[2]!
  const result = `${match[3]}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  if (!isoDay(result)) throw new Error('This is not a valid calendar date')
  return result
}
function money(value: string, currency: string, decimal: unknown): number {
  if (decimal !== 'dot' && decimal !== 'comma') throw new Error('Choose the decimal format used in the export')
  const separator = decimal === 'dot' ? '.' : ','
  const group = decimal === 'dot' ? ',' : '.'
  const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^(?:[0-9]+|[0-9]{1,3}(?:${escaped(group)}[0-9]{3})+)(?:${escaped(separator)}[0-9]+)?$`)
  if (!pattern.test(value)) throw new Error('Enter a non-negative amount in the selected decimal format, without a currency symbol')
  const [whole, fraction = ''] = value.replaceAll(group, '').split(separator)
  const digits = currencyFractionDigits(currency)
  if (fraction.length > digits) throw new Error(`${currency} supports ${digits} decimal places`)
  const minor = Number(`${whole}${fraction.padEnd(digits, '0')}`)
  if (!Number.isSafeInteger(minor)) throw new Error('Amount is too large')
  return minor
}
function count(value: string, field: string, minimum: number): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) throw new Error(`${field} must be a whole number of at least ${minimum}`)
  return Number(value)
}
function today(timezone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
function days(from: string, to: string): string[] {
  const length = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000
  return Array.from({ length }, (_, offset) => new Date(Date.parse(`${from}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10))
}
function homeFields(home: StayHome): MigrationHome {
  return { product_id: home.product_id, name: home.internal_name, currency: home.currency, timezone: home.timezone, channel_connected: home.channel?.status === 'connected' }
}
async function migrationHomes(db: DbClient, access: StayAccess) {
  manager(access)
  // Listing the homes requires `stays`; a business without places to stay has nothing to migrate.
  return listStayHomes(db, access)
}
export async function getStayMigrationContext(db: DbClient, access: StayAccess): Promise<MigrationContext> {
  const homes = await migrationHomes(db, access)
  const event = await queryFirst<{ occurred_at: string; payload_json: string }>(db, "SELECT occurred_at, payload_json FROM activity_entries WHERE organization_id = ? AND event_name = 'stay.migration_imported' ORDER BY occurred_at DESC, rowid DESC LIMIT 1", [access.organizationId])
  const receipt: unknown = event ? JSON.parse(event.payload_json).afterState : null
  if (event && !isMigrationReceipt(receipt)) fail(500, 'MIGRATION_RECEIPT_INVALID', 'The saved migration receipt is invalid')
  return { homes: homes.map(homeFields), recent_import: event && isMigrationReceipt(receipt) ? { fingerprint: receipt.fingerprint, occurred_at: event.occurred_at, receipt } : null }
}
function readInput(value: unknown): MigrationInput {
  if (!object(value) || typeof value.csv !== 'string' || !object(value.columns) || !object(value.homes) || !Array.isArray(value.blocks) || !Array.isArray(value.blocks_reviewed)) fail(422, 'MIGRATION_INPUT_REQUIRED', 'Upload an export and supply its column, property and manual-block review choices')
  if (new TextEncoder().encode(value.csv).byteLength > MIGRATION_MAX_CSV_BYTES) fail(422, 'MIGRATION_CSV_TOO_LARGE', 'The reservation export must be at most 1 MB; split larger exports into smaller files')
  if (value.blocks.some(block => !object(block))) fail(422, 'MIGRATION_BLOCKS_INVALID', 'Each blocked range must name a home and its dates')
  if (Object.entries(value.columns).some(([key, column]) => !MIGRATION_FIELDS.includes(key as MigrationField) || typeof column !== 'string') || Object.values(value.homes).some(id => typeof id !== 'string') || value.blocks_reviewed.some(id => typeof id !== 'string')) fail(422, 'MIGRATION_MAPPING_INVALID', 'Column and property choices must name exact fields and homes')
  if (value.overrides !== undefined && (!object(value.overrides) || Object.values(value.overrides).some(row => !object(row) || Object.entries(row).some(([key, cell]) => !MIGRATION_FIELDS.includes(key as MigrationField) || key === 'source_id' || key === 'source_listing' || typeof cell !== 'string')))) fail(422, 'MIGRATION_OVERRIDES_INVALID', 'Corrections must name source fields; reservation IDs and source properties cannot be replaced')
  const input = { csv: value.csv, columns: value.columns, homes: value.homes, date_format: value.date_format, decimal_format: value.decimal_format, overrides: value.overrides, blocks: value.blocks, blocks_reviewed: value.blocks_reviewed } as unknown as MigrationInput
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 1_000_000) fail(422, 'MIGRATION_EVIDENCE_TOO_LARGE', 'The export and review choices exceed the 1 MB saved-evidence limit. Split the export into smaller files before importing.')
  return input
}
async function fingerprint(input: MigrationInput) {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(input)))))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
function parseExport(input: MigrationInput) {
  let table: string[][]
  try {
    table = parse(input.csv, { bom: true, columns: false, skip_empty_lines: true, max_record_size: 100_000, relax_column_count: false }) as string[][]
  } catch (error) {
    fail(422, 'MIGRATION_CSV_INVALID', `The export could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  const headers = table.shift()?.map(header => header.trim()) ?? []
  if (!headers.length || headers.some(header => !header) || new Set(headers.map(header => header.toLowerCase())).size !== headers.length) fail(422, 'MIGRATION_CSV_HEADERS', 'The export needs a non-empty, unique name for every column')
  if (table.length > MIGRATION_MAX_ROWS) fail(422, 'MIGRATION_CSV_ROWS', `Upload at most ${MIGRATION_MAX_ROWS} reservations`)
  const suggested_columns: Partial<Record<MigrationField, string>> = {}
  for (const field of MIGRATION_FIELDS) {
    const matching = headers.filter(header => headerAliases[field].includes(normalized(header)))
    if (matching.length === 1) suggested_columns[field] = matching[0]
  }
  return { headers, suggested_columns, records: table.map(cells => Object.fromEntries(headers.map((header, index) => [header, cells[index]!.trim()]))) }
}
function channelValue(value: string): StayChannel {
  const key = normalized(value)
  if (['direct', 'hostaway', 'hostawaydirect', 'bookingengine', 'hostawaybookingengine', 'wordpress'].includes(key)) return 'direct'
  if (key === 'airbnb') return 'airbnb'
  if (['vrbo', 'homeaway'].includes(key)) return 'vrbo'
  if (['bookingcom', 'booking'].includes(key)) return 'booking_com'
  throw new Error('Choose a supported booking channel: Hostaway Direct, Airbnb, Vrbo or Booking.com')
}

interface ExistingStay { id: string; product_id: string; channel: StayChannel; channel_booking_id: string | null; idempotency_key: string | null; check_in_date: string; check_out_date: string; status: string }
/** A stay booking as stored: its days are read in its home's clock. */
type StoredStay = Omit<ExistingStay, 'check_in_date' | 'check_out_date'> & { starts_at: string; ends_at: string; timezone: string }
function storedStay({ starts_at, ends_at, timezone, ...stay }: StoredStay): ExistingStay {
  return { ...stay, check_in_date: bookingDay(starts_at, timezone), check_out_date: bookingDay(ends_at, timezone) }
}
function readCell(source: Record<string, string>, field: MigrationField): string {
  const value = source[field]?.trim() ?? ''
  if (!value) throw new Error(`${MIGRATION_FIELD_LABELS[field]} is missing; choose its column or enter a correction`)
  return value
}
function normalizeStay(source: Record<string, string>, home: StayHome, sourceId: string, sourceListing: string, input: MigrationInput): MigrationStay {
  const currency = readCell(source, 'currency').toUpperCase()
  if (!isCurrencyCode(currency) || currency !== home.currency) throw new Error(`Currency must match this home's ${home.currency}; currency conversion is not performed`)
  const adults = count(readCell(source, 'adults'), 'Adults', 1)
  const children = source.children ? count(source.children, 'Children', 0) : 0
  const infants = source.infants ? count(source.infants, 'Infants', 0) : 0
  if (adults > 99 || children > 99 || infants > 99 || adults + children > home.max_guests) throw new Error(`The party exceeds this home's capacity of ${home.max_guests}`)
  const total = money(readCell(source, 'total'), currency, input.decimal_format)
  const paymentStatus = normalized(readCell(source, 'payment_status'))
  const status = ['unpaid', 'notpaid'].includes(paymentStatus) ? 'unpaid' : paymentStatus === 'paid' ? 'paid' : ['partial', 'partiallypaid'].includes(paymentStatus) ? 'partial' : paymentStatus === 'overpaid' ? 'overpaid' : null
  if (!status) throw new Error('Payment status must explicitly say unpaid, paid, partially paid or overpaid')
  let payment: MigrationStay['payment'] = null
  if (status === 'unpaid') {
    if (source.paid_amount && money(source.paid_amount, currency, input.decimal_format) !== 0) throw new Error('An unpaid stay cannot also have money recorded as paid')
  } else {
    const amount = money(readCell(source, 'paid_amount'), currency, input.decimal_format)
    const method = readCell(source, 'payment_method')
    if (!STAY_PAYMENT_METHODS.includes(method as typeof STAY_PAYMENT_METHODS[number])) throw new Error(`Supply the actual payment method: ${STAY_PAYMENT_METHODS.join(', ')}`)
    if (amount <= 0 || (status === 'paid' && amount !== total) || (status === 'partial' && amount >= total) || (status === 'overpaid' && amount <= total)) throw new Error('The recorded payment amount does not agree with the payment status and total')
    const paidOn = dateValue(readCell(source, 'paid_on'), input.date_format)
    if (paidOn > today(home.timezone)) throw new Error('An already received payment cannot have a future payment date')
    payment = { amount_minor: amount, paid_on: paidOn, method: method as typeof STAY_PAYMENT_METHODS[number] }
  }
  const name = readCell(source, 'guest_name')
  if (name.length > 200 || (source.notes?.length ?? 0) > 2000) throw new Error('Guest names are limited to 200 characters and notes to 2,000')
  const email = source.guest_email || null
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error('Guest email is not a valid email address')
  if (source.guest_phone && !toE164(source.guest_phone)) throw new Error('Guest phone needs its country calling code')
  const channel = channelValue(readCell(source, 'channel'))
  const confirmation = source.channel_booking_id || null
  if (channel !== 'direct' && !confirmation) throw new Error('A channel booking needs its actual channel confirmation code, not its Hostaway ID')
  return {
    source_id: sourceId, source_listing: sourceListing, product_id: home.product_id, guest_name: name, guest_email: email, guest_phone: source.guest_phone || null,
    check_in_date: dateValue(readCell(source, 'check_in_date'), input.date_format), check_out_date: dateValue(readCell(source, 'check_out_date'), input.date_format),
    adults, children, infants, total_minor: total, currency, channel, channel_booking_id: confirmation, payment_status: status, payment, notes: source.notes || null,
  }
}
function validateBlocks(input: MigrationInput, homes: StayHome[]): string[] {
  const issues: string[] = []
  const blockNights = input.blocks.reduce((sum, block) => sum + (typeof block.from === 'string' && typeof block.to === 'string' && isoDay(block.from) && isoDay(block.to) ? Math.max(0, (Date.parse(block.to) - Date.parse(block.from)) / 86_400_000) : 0), 0)
  if (blockNights > 100_000) issues.push('Split blocked dates into batches of at most 100,000 nights')
  if (input.blocks.length > MIGRATION_MAX_ROWS) issues.push(`At most ${MIGRATION_MAX_ROWS} blocked date ranges can be imported at once`)
  for (const [index, block] of input.blocks.entries()) {
    if (!object(block) || typeof block.product_id !== 'string' || !homes.some(home => home.product_id === block.product_id) || typeof block.from !== 'string' || typeof block.to !== 'string' || !isoDay(block.from) || !isoDay(block.to) || block.to <= block.from || (Date.parse(block.to) - Date.parse(block.from)) / 86_400_000 > MAX_STAY_NIGHTS || (block.note !== undefined && (typeof block.note !== 'string' || block.note.length > 1000))) issues.push(`Blocked range ${index + 1} must name an accessible home and valid ISO dates, with checkout after check-in and at most ${MAX_STAY_NIGHTS} nights`)
  }
  const mapped = [...new Set([...Object.values(input.homes), ...input.blocks.map(block => block.product_id)])]
  for (const productId of mapped) {
    if (!homes.some(home => home.product_id === productId)) issues.push('A property match names a home outside this business')
    else if (!input.blocks_reviewed.includes(productId)) issues.push(`Check manual blocked dates for ${homes.find(home => home.product_id === productId)!.internal_name}`)
  }
  if (input.blocks_reviewed.some(id => !homes.some(home => home.product_id === id))) issues.push('Manual-block review names a home outside this business')
  return issues
}
export async function previewStayMigration(db: DbClient, access: StayAccess, value: unknown): Promise<MigrationPreview> {
  const input = readInput(value)
  const homes = await migrationHomes(db, access)
  const parsed = parseExport(input)
  const issues: string[] = []
  for (const [field, header] of Object.entries(input.columns)) if (header && !parsed.headers.includes(header)) issues.push(`${MIGRATION_FIELD_LABELS[field as MigrationField]} names a column that is not in this export`)
  if (new Set(Object.values(input.columns).filter(Boolean)).size !== Object.values(input.columns).filter(Boolean).length) issues.push('Each source column can supply only one field')
  if (!input.columns.source_id || !input.columns.source_listing) issues.push('Choose the Hostaway reservation ID and property columns')
  if (!['iso', 'mdy', 'dmy'].includes(input.date_format)) issues.push('Choose the date format used in the export')
  if (!['dot', 'comma'].includes(input.decimal_format)) issues.push('Choose the decimal format used in the export')
  issues.push(...validateBlocks(input, homes))
  const sources = parsed.records.map(raw => {
    const source = Object.fromEntries(MIGRATION_FIELDS.map(field => [field, input.columns[field] ? raw[input.columns[field]!] ?? '' : '']))
    Object.assign(source, input.overrides?.[source.source_id!.trim()])
    return source
  })
  const existing = (await queryAll<StoredStay>(db, `SELECT id, product_id, channel, channel_booking_id, idempotency_key, starts_at, ends_at, timezone, status FROM bookings WHERE organization_id = ? AND product_session_id IS NULL AND (idempotency_key IN (SELECT value FROM json_each(?)) OR channel_booking_id IN (SELECT value FROM json_each(?)))`, [access.organizationId, JSON.stringify(sources.map(source => keyFor(source.source_id!.trim()))), JSON.stringify(sources.map(source => source.channel_booking_id).filter(Boolean))])).map(storedStay)
  const rows: MigrationRow[] = []
  for (const [index, raw] of parsed.records.entries()) {
    const source = sources[index]!
    const sourceId = source.source_id!.trim()
    const sourceListing = source.source_listing!.trim()
    const productId = input.homes[sourceListing] || null
    const row: MigrationRow = { row_number: index + 2, source_id: sourceId, source_listing: sourceListing, product_id: productId, source, raw, stay: null, state: 'needs_attention', issues: [], existing_stay_id: null, imported_source: false, skip_reason: null }
    rows.push(row)
    try {
      if (!sourceId || keyFor(sourceId).length > 200) throw new Error('A Hostaway reservation ID of at most 191 characters is required')
      const home = homes.find(home => home.product_id === productId)
      const own = existing.find(stay => stay.idempotency_key === keyFor(sourceId))
      if (own) {
        if (!home) throw new Error('Match this Hostaway property to a KrabiClaw home')
        if (own.product_id !== productId) throw new Error('This reservation was already imported at another home; review the existing stay and property match')
        row.state = 'existing'; row.existing_stay_id = own.id; row.imported_source = true; row.skip_reason = 'Already imported. Current host edits are preserved.'
        continue
      }
      const status = normalized(readCell(source, 'status'))
      if (['cancelled', 'canceled', 'inquiry', 'inquiries', 'declined'].includes(status)) { row.state = 'skipped'; row.skip_reason = `Source reservation is ${source.status}`; continue }
      if (!['new', 'modified', 'confirmed'].includes(status)) throw new Error(`Source status “${source.status}” needs review; only confirmed New/Modified stays are imported`)
      const checkIn = dateValue(readCell(source, 'check_in_date'), input.date_format)
      const checkOut = dateValue(readCell(source, 'check_out_date'), input.date_format)
      const length = (Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000
      if (length < 1 || length > MAX_STAY_NIGHTS) throw new Error(`Checkout must be after check-in and a stay is at most ${MAX_STAY_NIGHTS} nights`)
      if (!home && checkOut < new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)) { row.state = 'skipped'; row.skip_reason = 'This stay has already ended; its source row is retained in the migration receipt.'; continue }
      if (!home) throw new Error('Match this Hostaway property to a KrabiClaw home')
      if (checkOut < today(home.timezone)) { row.state = 'skipped'; row.skip_reason = 'This stay has already ended; its source row is retained in the migration receipt.'; continue }
      const channel = channelValue(readCell(source, 'channel'))
      const confirmation = source.channel_booking_id || null
      if (channel !== 'direct' && !confirmation) throw new Error('Choose the source channel confirmation column or supply the actual confirmation code')
      const channelMatches = confirmation && channel !== 'direct' ? existing.filter(stay => stay.channel === channel && stay.channel_booking_id === confirmation) : []
      if (channelMatches.length > 1) throw new Error('More than one existing stay has this channel confirmation code; resolve the duplicate first')
      if (channelMatches[0]) {
        const match = channelMatches[0]
        if (match.product_id !== productId || match.check_in_date !== checkIn || match.check_out_date !== checkOut || match.status !== 'confirmed') throw new Error('The existing channel booking has a different home, dates or status; resolve that difference before migration')
        row.state = 'existing'; row.existing_stay_id = match.id; row.skip_reason = 'The existing channel booking is preserved.'
        continue
      }
      row.stay = normalizeStay(source, home, sourceId, sourceListing, input)
      row.state = 'ready'
    } catch (error) {
      row.issues.push(error instanceof Error ? error.message : String(error))
    }
  }
  for (const id of new Set(rows.map(row => row.source_id).filter(Boolean))) {
    const duplicates = rows.filter(row => row.source_id === id)
    if (duplicates.length > 1) for (const row of duplicates) { row.state = 'needs_attention'; row.issues.push('The Hostaway reservation ID occurs more than once in this file') }
  }
  const sourceClaims = new Map<string, MigrationRow>()
  let totalNights = 0
  for (const row of rows.filter(row => row.state === 'ready' && row.stay)) {
    for (const day of days(row.stay!.check_in_date, row.stay!.check_out_date)) {
      if (++totalNights > 100_000) fail(422, 'MIGRATION_TOO_MANY_NIGHTS', 'Split this export into smaller batches of at most 100,000 occupied nights')
      const key = `${row.product_id}:${day}`
      const other = sourceClaims.get(key)
      if (other) {
        for (const conflict of [other, row]) { conflict.state = 'needs_attention'; if (!conflict.issues.includes('Two source reservations occupy the same home and nights')) conflict.issues.push('Two source reservations occupy the same home and nights') }
      } else sourceClaims.set(key, row)
    }
  }
  // The canonical night claims hold stays, linked calendars and only live checkout holds.
  const ready = rows.filter(row => row.stay !== null)
  const claims = ready.length ? await queryAll<{ product_id: string; date: string; stay_id: string | null }>(db, `SELECT n.product_id, n.date, n.booking_id AS stay_id FROM stay_nights n
    LEFT JOIN payment_checkout_holds h ON h.id = n.hold_id
    WHERE n.organization_id = ? AND n.product_id IN (SELECT value FROM json_each(?)) AND n.date >= ? AND n.date < ? AND (n.booking_id IS NOT NULL OR n.calendar_link_id IS NOT NULL OR (h.status = 'active' AND h.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`, [access.organizationId, JSON.stringify([...new Set(ready.map(row => row.product_id))]), ready.map(row => row.stay!.check_in_date).sort()[0], ready.map(row => row.stay!.check_out_date).sort().at(-1)]) : []
  for (const claim of claims) {
    const row = sourceClaims.get(`${claim.product_id}:${claim.date}`)
    if (row && row.state !== 'existing') {
      row.state = 'needs_attention'
      const message = claim.stay_id ? `Overlaps existing stay ${claim.stay_id}` : 'Overlaps a linked calendar or live checkout hold'
      if (!row.issues.includes(message)) row.issues.push(message)
    }
  }
  const counts = { ready: 0, existing: 0, skipped: 0, needs_attention: 0 }
  for (const row of rows) counts[row.state]++
  return { headers: parsed.headers, suggested_columns: parsed.suggested_columns, source_listings: [...new Set(rows.filter(row => row.state !== 'skipped').map(row => row.source_listing).filter(Boolean))].sort(), rows, homes: homes.map(homeFields), issues, fingerprint: await fingerprint(input), can_import: issues.length === 0 && counts.needs_attention === 0 && (counts.ready + counts.existing > 0 || input.blocks.length > 0 || input.blocks_reviewed.length > 0), counts }
}

function sourceFingerprint(value: unknown): string {
  if (!object(value) || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)) fail(422, 'MIGRATION_PREVIEW_REQUIRED', 'Review the migration preview before importing or verifying it')
  return value.fingerprint
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function committed(error: unknown): boolean {
  return object(error) && object(error.data) && error.data.committed === true
}
function blockChunks(input: MigrationInput) {
  return input.blocks.flatMap(block => {
    const nights = days(block.from, block.to)
    const chunks: Array<{ product_id: string; from: string; to: string }> = []
    for (let index = 0; index < nights.length; index += STAY_CALENDAR_DAYS) {
      const end = nights[Math.min(index + STAY_CALENDAR_DAYS, nights.length) - 1]!
      chunks.push({ product_id: block.product_id, from: nights[index]!, to: new Date(Date.parse(end) + 86_400_000).toISOString().slice(0, 10) })
    }
    return chunks
  })
}
interface BlockNight { product_id: string; date: string; closed: number; state: string | null; sent_closed: number | null; delivery_required: number; timezone: string }
async function blockState(db: DbClient, access: StayAccess, input: MigrationInput) {
  if (!input.blocks.length) return new Map<string, BlockNight>()
  const rows = await queryAll<BlockNight>(db, `SELECT n.product_id, n.date, n.closed, p.state, json_extract(p.sent_json, '$.stop_sell') AS sent_closed, l.timezone, CASE WHEN m.enabled = 1 AND c.status = 'connected' AND m.channel_id = c.channel_id THEN 1 ELSE 0 END AS delivery_required FROM product_nights n
    JOIN product_stay_configs h ON h.organization_id = n.organization_id AND h.product_id = n.product_id
    JOIN business_locations l ON l.organization_id = h.organization_id AND l.id = h.location_id
    LEFT JOIN product_channel_mappings m ON m.organization_id = n.organization_id AND m.product_id = n.product_id AND m.provider = 'channex'
    LEFT JOIN channex_connections c ON c.organization_id = n.organization_id
    LEFT JOIN channel_night_pushes p ON p.organization_id = n.organization_id AND p.product_id = n.product_id AND p.date = n.date AND p.provider = 'channex'
    WHERE n.organization_id = ? AND n.product_id IN (SELECT value FROM json_each(?)) AND n.date >= ? AND n.date < ?`,
  [access.organizationId, JSON.stringify([...new Set(input.blocks.map(block => block.product_id))]), input.blocks.map(block => block.from).sort()[0], input.blocks.map(block => block.to).sort().at(-1)])
  return new Map(rows.map(row => [`${row.product_id}:${row.date}`, row]))
}
function savedBlock(state: Map<string, BlockNight>, block: { product_id: string; from: string; to: string }) {
  return days(block.from, block.to).every(date => { const night = state.get(`${block.product_id}:${date}`); return night?.closed === 1 && (night.delivery_required !== 1 || date < today(night.timezone) || (night.state === 'pushed' && night.sent_closed === 1)) })
}

async function migrationCompletion(db: DbClient, access: StayAccess, preview: MigrationPreview) {
  const previous = await queryAll<{ source_id: string; state: string; committed: number; completion_pending: number }>(db, `SELECT json_extract(o.value, '$.source_id') AS source_id, json_extract(o.value, '$.state') AS state, json_extract(o.value, '$.committed') AS committed, json_extract(o.value, '$.completion_pending') AS completion_pending
    FROM activity_entries e, json_each(e.payload_json, '$.afterState.outcomes') o WHERE e.organization_id = ? AND e.event_name = 'stay.migration_imported' AND json_extract(e.payload_json, '$.metadata.fingerprint') = ? AND json_extract(o.value, '$.source_id') IN (SELECT value FROM json_each(?)) ORDER BY e.rowid DESC`, [access.organizationId, preview.fingerprint, JSON.stringify(preview.rows.filter(row => row.imported_source).map(row => row.source_id))])
  const completion = new Map<string, boolean>()
  for (const prior of previous) if (!completion.has(prior.source_id)) completion.set(prior.source_id, (prior.state === 'failed' && prior.committed === 1) || prior.completion_pending === 1)
  return completion
}

const blockKey = (block: { product_id: string; from: string; to: string }) => JSON.stringify([block.product_id, block.from, block.to])
async function migrationBlockCompletion(db: DbClient, access: StayAccess, input: MigrationInput, source: string) {
  const previous = await queryAll<{ block_key: string; state: string }>(db, `SELECT json_array(json_extract(b.value, '$.product_id'), json_extract(b.value, '$.from'), json_extract(b.value, '$.to')) AS block_key, json_extract(b.value, '$.state') AS state
    FROM activity_entries e, json_each(e.payload_json, '$.afterState.blocks') b WHERE e.organization_id = ? AND e.event_name = 'stay.migration_imported' AND json_extract(e.payload_json, '$.metadata.fingerprint') = ? AND json_array(json_extract(b.value, '$.product_id'), json_extract(b.value, '$.from'), json_extract(b.value, '$.to')) IN (SELECT value FROM json_each(?)) ORDER BY e.rowid DESC`, [access.organizationId, source, JSON.stringify(blockChunks(input).map(blockKey))])
  const saved = new Map<string, boolean>()
  for (const prior of previous) if (!saved.has(prior.block_key)) saved.set(prior.block_key, prior.state === 'saved')
  return saved
}

export async function importStayMigration(db: DbClient, env: MigrationEnv, access: StayAccess, value: unknown): Promise<MigrationReceipt> {
  const expected = sourceFingerprint(value)
  const input = readInput(value)
  const preview = await previewStayMigration(db, access, input)
  if (expected !== preview.fingerprint) fail(409, 'MIGRATION_SOURCE_CHANGED', 'The export or migration choices changed; review the preview again')
  if (!preview.can_import) throw new HTTPError({ statusCode: 409, message: 'Resolve the migration preview issues before importing', data: { code: 'MIGRATION_NEEDS_ATTENTION', preview } })
  const receipt: MigrationReceipt = { fingerprint: expected, imported: 0, existing: 0, skipped: 0, failed: 0, remaining: 0, has_more: false, outcomes: [], blocks: [] }
  const completion = await migrationCompletion(db, access, preview)
  let processed = 0
  for (const row of preview.rows) {
    if (row.state === 'skipped') { receipt.skipped++; receipt.outcomes.push({ source_id: row.source_id, stay_id: null, state: 'skipped', detail: row.skip_reason, committed: false }); continue }
    if (row.state === 'existing') {
      if (row.imported_source && completion.get(row.source_id) !== false) {
        if (processed >= 5) { receipt.remaining++; receipt.outcomes.push({ source_id: row.source_id, stay_id: row.existing_stay_id, state: 'pending', detail: 'Waiting to finish this imported stay', committed: true, completion_pending: true }); continue }
        processed++
        try {
          const resumed = await resumeImportedStay(db, env, access, row.existing_stay_id!)
          receipt.existing++
          receipt.outcomes.push({ source_id: row.source_id, stay_id: row.existing_stay_id, state: 'existing', detail: resumed.channel_push?.state === 'pending' ? resumed.channel_push.detail : row.skip_reason, committed: true, completion_pending: resumed.channel_push?.state === 'pending' })
        } catch (error) { receipt.failed++; receipt.outcomes.push({ source_id: row.source_id, stay_id: row.existing_stay_id, state: 'failed', detail: message(error), committed: true, completion_pending: true }) }
      } else { receipt.existing++; receipt.outcomes.push({ source_id: row.source_id, stay_id: row.existing_stay_id, state: 'existing', detail: row.skip_reason, committed: false }) }
      continue
    }
    if (processed >= 5) { receipt.remaining++; receipt.outcomes.push({ source_id: row.source_id, stay_id: null, state: 'pending', detail: 'Waiting for the next migration batch', committed: false }); continue }
    processed++
    const stay = row.stay!
    try {
      const saved = await createStay(db, env, access, {
        product_id: stay.product_id, idempotency_key: keyFor(stay.source_id), guest_name: stay.guest_name, guest_email: stay.guest_email, guest_phone: stay.guest_phone,
        check_in_date: stay.check_in_date, check_out_date: stay.check_out_date, adults: stay.adults, children: stay.children, infants: stay.infants,
        total_minor: stay.total_minor, private_notes: stay.notes, ...(stay.payment ? { payment: { ...stay.payment, reference: stay.source_id } } : {}),
      }, { imported: { source: 'hostaway', source_id: stay.source_id, row: row.raw, fingerprint: expected, channel: stay.channel, channel_booking_id: stay.channel_booking_id } })
      const readBack = await getStay(db, access, saved.id)
      if (!('owner' in readBack) || readBack.product_id !== stay.product_id || readBack.check_in_date !== stay.check_in_date || readBack.check_out_date !== stay.check_out_date || readBack.status !== 'confirmed') throw new HTTPError({ statusCode: 503, message: 'The saved stay did not read back with the imported property and dates', data: { committed: true } })
      receipt.imported++
      receipt.outcomes.push({ source_id: row.source_id, stay_id: saved.id, state: 'imported', detail: saved.channel_push?.state === 'pending' ? saved.channel_push.detail : null, committed: true, completion_pending: saved.channel_push?.state === 'pending' })
    } catch (error) {
      receipt.failed++
      const persisted = await queryFirst<{ id: string }>(db, 'SELECT id FROM bookings WHERE organization_id = ? AND idempotency_key = ?', [access.organizationId, keyFor(row.source_id)])
      receipt.outcomes.push({ source_id: row.source_id, stay_id: persisted?.id ?? null, state: 'failed', detail: message(error), committed: committed(error) || Boolean(persisted) })
    }
  }
  const [blocked, completedBlocks] = await Promise.all([blockState(db, access, input), migrationBlockCompletion(db, access, input, expected)])
  let blocksProcessed = 0
  for (const block of blockChunks(input)) {
    if (completedBlocks.get(blockKey(block)) === true && savedBlock(blocked, block)) { receipt.blocks.push({ ...block, state: 'saved', detail: null, committed: false }); continue }
    if (blocksProcessed >= 2) { receipt.remaining++; receipt.blocks.push({ ...block, state: 'pending', detail: 'Waiting for the next migration batch', committed: false }); continue }
    blocksProcessed++
    try {
      const saved = await setStayNights(db, env, access, { ...block, closed: true })
      receipt.blocks.push({ ...block, state: 'saved', detail: saved.channel_push?.state === 'pending' ? saved.channel_push.detail : null, committed: true })
    } catch (error) {
      receipt.failed++
      receipt.blocks.push({ ...block, state: 'failed', detail: message(error), committed: committed(error) })
    }
  }
  receipt.has_more = receipt.remaining > 0
  try {
    await executeBatch(db, [organizationEventQuery({ organizationId: access.organizationId, actorId: access.actorId, eventType: 'stay.migration_imported', entityType: 'stay_migration', entityId: expected,
      context: access.audit, metadata: { source: 'hostaway', fingerprint: expected, imported: receipt.imported, existing: receipt.existing, failed: receipt.failed, remaining: receipt.remaining }, beforeState: input, afterState: receipt })], { operation: 'Record Hostaway migration receipt' })
  } catch (error) {
    throw new HTTPError({ statusCode: 503, message: `Migration records were processed but the receipt could not be saved: ${message(error)}`, data: { code: 'MIGRATION_RECEIPT_FAILED', committed: receipt.outcomes.some(row => row.committed) || receipt.blocks.some(row => row.committed), receipt }, cause: error })
  }
  return receipt
}

export async function verifyStayMigration(db: DbClient, env: MigrationEnv, access: StayAccess, value: unknown): Promise<MigrationVerification> {
  const expected = sourceFingerprint(value)
  const input = readInput(value)
  const preview = await previewStayMigration(db, access, input)
  if (expected !== preview.fingerprint) fail(409, 'MIGRATION_SOURCE_CHANGED', 'The export or migration choices changed; review the preview again')
  if (preview.issues.length || preview.counts.needs_attention) throw new HTTPError({ statusCode: 409, message: 'Resolve the migration preview issues before verifying', data: { code: 'MIGRATION_NEEDS_ATTENTION', preview } })
  const allProductIds = [...new Set([...Object.values(input.homes), ...input.blocks_reviewed, ...input.blocks.map(block => block.product_id)])].sort()
  const requested = object(value) ? value.product_ids : undefined
  if (requested !== undefined && (!Array.isArray(requested) || requested.length < 1 || requested.length > 5 || requested.some(id => typeof id !== 'string' || !allProductIds.includes(id)) || new Set(requested).size !== requested.length)) fail(422, 'MIGRATION_VERIFY_SCOPE', 'Choose between one and five homes from this migration to verify')
  if (requested === undefined && allProductIds.length > 5) fail(422, 'MIGRATION_VERIFY_SCOPE', 'Verify this migration in batches of at most five homes')
  const productIds = (requested as string[] | undefined) ?? allProductIds
  const result: MigrationVerification = { fingerprint: expected, state: 'needs_attention', issues: [...preview.issues], checked_at: new Date().toISOString(), product_ids: productIds, all_product_ids: allProductIds, scope_complete: productIds.length === allProductIds.length, homes: [] }
  const completion = await migrationCompletion(db, access, preview)
  for (const row of preview.rows) if (row.imported_source && completion.get(row.source_id) !== false) result.issues.push(`Reservation ${row.source_id} still needs its import completion retried before handover`)
  const datesByHome = new Map<string, Set<string>>()
  const add = (productId: string, dates: string[]) => { const set = datesByHome.get(productId) ?? new Set<string>(); for (const date of dates) set.add(date); datesByHome.set(productId, set) }
  for (const row of preview.rows) if (row.state !== 'skipped' && (row.state !== 'existing' || !row.existing_stay_id)) result.issues.push(`Reservation ${row.source_id || `row ${row.row_number}`} is not imported: ${row.issues.join('; ') || 'Import this reservation first'}`)
  const selectedRows = preview.rows.filter(row => row.state === 'existing' && row.existing_stay_id && productIds.includes(row.product_id!))
  const ids = JSON.stringify(selectedRows.map(row => row.existing_stay_id))
  const [savedStays, claims, blocked, completedBlocks] = await Promise.all([
    queryAll<StoredStay>(db, 'SELECT id, product_id, channel, channel_booking_id, idempotency_key, starts_at, ends_at, timezone, status FROM bookings WHERE organization_id = ? AND id IN (SELECT value FROM json_each(?))', [access.organizationId, ids]).then(rows => rows.map(storedStay)),
    queryAll<{ stay_id: string; date: string }>(db, 'SELECT booking_id AS stay_id, date FROM stay_nights WHERE organization_id = ? AND booking_id IN (SELECT value FROM json_each(?)) ORDER BY date', [access.organizationId, ids]),
    blockState(db, access, input),
    migrationBlockCompletion(db, access, input, expected),
  ])
  for (const row of selectedRows) {
    const saved = savedStays.find(stay => stay.id === row.existing_stay_id)
    if (!saved) { result.issues.push(`Reservation ${row.source_id} could not be read back`); continue }
    if (saved.status === 'cancelled') continue
    const occupied = claims.filter(claim => claim.stay_id === saved.id)
    const expectedDates = days(saved.check_in_date, saved.check_out_date)
    if (occupied.length !== expectedDates.length || occupied.some((claim, index) => claim.date !== expectedDates[index])) result.issues.push(`Reservation ${row.source_id} does not hold all of its occupied nights`)
    add(saved.product_id, expectedDates)
  }
  for (const chunk of blockChunks(input)) if (completedBlocks.get(blockKey(chunk)) !== true) result.issues.push(`Blocked dates ${chunk.from}–${chunk.to} still need their import completion retried before handover`)
  for (const block of input.blocks) {
    if (!savedBlock(blocked, block)) result.issues.push(`Blocked dates ${block.from}–${block.to} have not all been saved and delivered`)
    if (productIds.includes(block.product_id)) add(block.product_id, days(block.from, block.to))
  }
  // A reviewed home with no source occupancy still needs the channel read; it has no dates to claim are blocked.
  for (const productId of input.blocks_reviewed) if (!datesByHome.has(productId)) {
    const home = preview.homes.find(home => home.product_id === productId)
    if (home) datesByHome.set(productId, new Set())
  }
  for (const [productId, dates] of datesByHome) {
    if (!productIds.includes(productId)) continue
    const home = preview.homes.find(home => home.product_id === productId)
    if (!home) { result.issues.push('A verification target is outside this business'); continue }
    const future = [...dates].filter(date => date >= today(home.timezone)).sort()
    try {
      const live = await verifyStayCalendarOccupancy(db, env, access, productId, future)
      result.homes.push({ product_id: productId, name: home.name, ...live })
    } catch (error) {
      result.homes.push({ product_id: productId, name: home.name, state: 'needs_attention', checked_dates: [], unverified_dates: future, mismatches: [], detail: message(error) })
    }
  }
  if (!result.homes.length) result.issues.push('No imported homes are available to verify')
  if (result.scope_complete && result.issues.length === 0 && result.homes.every(home => home.state === 'verified' && home.unverified_dates.length === 0)) result.state = 'verified'
  await executeBatch(db, [organizationEventQuery({ organizationId: access.organizationId, actorId: access.actorId, eventType: 'stay.migration_verified', entityType: 'stay_migration', entityId: expected,
    context: access.audit, metadata: { source: 'hostaway', fingerprint: expected, state: result.state }, afterState: result })], { operation: 'Record Hostaway migration verification' })
  return result
}
