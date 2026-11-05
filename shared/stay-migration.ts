import type { StayPaymentMethod, StayChannel } from './bookings'

export const MIGRATION_FIELDS = [
  'source_id', 'source_listing', 'guest_name', 'check_in_date', 'check_out_date', 'adults', 'children', 'infants',
  'total', 'currency', 'status', 'channel', 'channel_booking_id', 'payment_status', 'paid_amount', 'paid_on', 'payment_method',
  'guest_email', 'guest_phone', 'notes',
] as const
export type MigrationField = typeof MIGRATION_FIELDS[number]
export const MIGRATION_REQUIRED_FIELDS: MigrationField[] = ['source_id', 'source_listing', 'guest_name', 'check_in_date', 'check_out_date', 'adults', 'total', 'currency', 'status', 'channel', 'payment_status']
export const MIGRATION_FIELD_LABELS: Record<MigrationField, string> = {
  source_id: 'Hostaway reservation ID', source_listing: 'Hostaway property', guest_name: 'Guest name',
  check_in_date: 'Check-in date', check_out_date: 'Check-out date', adults: 'Adults', children: 'Children', infants: 'Infants',
  total: 'Reservation total', currency: 'Currency', status: 'Reservation status', channel: 'Booking channel',
  channel_booking_id: 'Channel confirmation code', payment_status: 'Payment status', paid_amount: 'Amount already paid',
  paid_on: 'Payment date', payment_method: 'Payment method', guest_email: 'Guest email', guest_phone: 'Guest phone', notes: 'Notes',
}
export const MIGRATION_MAX_ROWS = 500
export const MIGRATION_MAX_CSV_BYTES = 1_000_000
export type MigrationDateFormat = 'iso' | 'mdy' | 'dmy'
export type MigrationDecimalFormat = 'dot' | 'comma'
export interface MigrationPayment {
  amount_minor: number
  paid_on: string
  method: StayPaymentMethod
}
export interface MigrationStay {
  source_id: string
  source_listing: string
  product_id: string
  guest_name: string
  guest_email: string | null
  guest_phone: string | null
  check_in_date: string
  check_out_date: string
  adults: number
  children: number
  infants: number
  total_minor: number
  currency: string
  channel: StayChannel
  channel_booking_id: string | null
  payment_status: 'unpaid' | 'paid' | 'partial' | 'overpaid'
  payment: MigrationPayment | null
  notes: string | null
}
export interface MigrationBlock {
  product_id: string
  from: string
  /** Exclusive, as for a stay checkout date. */
  to: string
  note?: string
}
export interface MigrationInput {
  csv: string
  columns: Partial<Record<MigrationField, string>>
  date_format: MigrationDateFormat
  decimal_format: MigrationDecimalFormat
  homes: Record<string, string>
  /** Explicit host corrections to source cell values, keyed by Hostaway reservation ID. */
  overrides?: Record<string, Partial<Record<MigrationField, string>>>
  blocks: MigrationBlock[]
  /** Homes whose manual blocked dates were checked against Hostaway by the host. */
  blocks_reviewed: string[]
}
export interface MigrationHome {
  product_id: string
  name: string
  currency: string
  timezone: string
  channel_connected: boolean
}
export interface MigrationRow {
  row_number: number
  source_id: string
  source_listing: string
  product_id: string | null
  source: Record<string, string>
  raw: Record<string, string>
  stay: MigrationStay | null
  state: 'ready' | 'existing' | 'skipped' | 'needs_attention'
  issues: string[]
  existing_stay_id: string | null
  /** True only when the canonical stay has this Hostaway idempotency key. */
  imported_source: boolean
  skip_reason: string | null
}
export interface MigrationPreview {
  headers: string[]
  suggested_columns: Partial<Record<MigrationField, string>>
  source_listings: string[]
  rows: MigrationRow[]
  homes: MigrationHome[]
  issues: string[]
  fingerprint: string
  can_import: boolean
  counts: { ready: number; existing: number; skipped: number; needs_attention: number }
}
export interface MigrationReceipt {
  fingerprint: string
  imported: number
  existing: number
  skipped: number
  failed: number
  remaining: number
  has_more: boolean
  outcomes: Array<{ source_id: string; stay_id: string | null; state: 'imported' | 'existing' | 'skipped' | 'failed' | 'pending'; detail: string | null; committed: boolean; completion_pending?: boolean }>
  blocks: Array<{ product_id: string; from: string; to: string; state: 'saved' | 'failed' | 'pending'; detail: string | null; committed: boolean }>
}
export interface MigrationVerification {
  fingerprint: string
  state: 'verified' | 'needs_attention'
  issues: string[]
  checked_at: string
  product_ids: string[]
  all_product_ids: string[]
  scope_complete: boolean
  homes: Array<{ product_id: string; name: string; state: 'verified' | 'needs_attention' | 'not_connected'; checked_dates: string[]; unverified_dates: string[]; mismatches: string[]; detail: string | null }>
}
export interface MigrationContext {
  homes: MigrationHome[]
  recent_import: { fingerprint: string; occurred_at: string; receipt: MigrationReceipt } | null
}

export type MigrationImportResult = MigrationReceipt
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
const migrationHome = (value: unknown): value is MigrationHome => record(value) && typeof value.product_id === 'string' && typeof value.name === 'string' && typeof value.currency === 'string' && typeof value.timezone === 'string' && typeof value.channel_connected === 'boolean'
export function isMigrationContext(value: unknown): value is MigrationContext {
  return record(value) && Array.isArray(value.homes) && value.homes.every(migrationHome)
    && (value.recent_import === null || (record(value.recent_import) && typeof value.recent_import.fingerprint === 'string' && typeof value.recent_import.occurred_at === 'string' && isMigrationReceipt(value.recent_import.receipt)))
}
export function isMigrationPreview(value: unknown): value is MigrationPreview {
  return record(value) && stringArray(value.headers) && record(value.suggested_columns) && stringArray(value.source_listings)
    && Array.isArray(value.rows) && value.rows.every(row => record(row) && typeof row.row_number === 'number' && typeof row.source_id === 'string' && typeof row.source_listing === 'string' && record(row.source) && stringArray(row.issues) && ['ready', 'existing', 'skipped', 'needs_attention'].includes(String(row.state)))
    && Array.isArray(value.homes) && value.homes.every(migrationHome) && stringArray(value.issues) && typeof value.fingerprint === 'string' && typeof value.can_import === 'boolean' && record(value.counts)
}
export function isMigrationReceipt(value: unknown): value is MigrationReceipt {
  return record(value) && typeof value.fingerprint === 'string' && ['imported', 'existing', 'skipped', 'failed', 'remaining'].every(key => typeof value[key] === 'number')
    && typeof value.has_more === 'boolean' && Array.isArray(value.outcomes) && value.outcomes.every(row => record(row) && typeof row.source_id === 'string' && ['imported', 'existing', 'skipped', 'failed', 'pending'].includes(String(row.state)) && typeof row.committed === 'boolean')
    && Array.isArray(value.blocks) && value.blocks.every(row => record(row) && typeof row.product_id === 'string' && typeof row.from === 'string' && typeof row.to === 'string' && ['saved', 'failed', 'pending'].includes(String(row.state)) && typeof row.committed === 'boolean')
}
export function isMigrationVerification(value: unknown): value is MigrationVerification {
  return record(value) && typeof value.fingerprint === 'string' && ['verified', 'needs_attention'].includes(String(value.state)) && stringArray(value.issues)
    && typeof value.checked_at === 'string' && stringArray(value.product_ids) && stringArray(value.all_product_ids) && typeof value.scope_complete === 'boolean'
    && Array.isArray(value.homes) && value.homes.every(home => record(home) && typeof home.product_id === 'string' && typeof home.name === 'string' && ['verified', 'needs_attention', 'not_connected'].includes(String(home.state)) && stringArray(home.checked_dates) && stringArray(home.unverified_dates) && stringArray(home.mismatches))
}
