import { HTTPError } from 'nitro'
import { executeBatch, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { organizationEventQuery } from '~/server/utils/organization-events'
import { DEPOSIT_ENTRY_KINDS, DEPOSIT_METHODS, depositLabel, type BookingDeposit, type DepositEntry, type DepositEntryKind, type DepositMethod } from '~/shared/deposits'
import type { ProductKind } from '~/shared/product-details'

/**
 * A booking's refundable deposit (#1908): the amount the business asks for
 * (`bookings.deposit_minor`) and what it recorded receiving, returning and
 * keeping (`offline_payments` with purpose `deposit` / `deposit_withheld`).
 * The deposit is a liability, so revenue reads only purpose `payment` and the
 * part the business kept.
 */

/** The booking a deposit read is for: its ID and organization as SQL values, as the agreement read takes them. */
export interface DepositTarget {
  booking: { sql: string; params: unknown[] }
  organization: { sql: string; params: unknown[] }
}

const ENTRY_PURPOSES = `('deposit', 'deposit_withheld')`
const HELD_SQL = `(SELECT COALESCE(SUM(CASE WHEN purpose = 'deposit' THEN amount_minor ELSE -amount_minor END), 0)
  FROM offline_payments WHERE organization_id = ? AND booking_id = ? AND purpose IN ${ENTRY_PURPOSES})`

/** One statement: the booking's deposit terms and every entry, for a booking read's own batch. */
export function depositQuery(target: DepositTarget): BatchQuery {
  return {
    query: `SELECT b.deposit_minor, COALESCE(b.currency, o.default_currency) AS currency, p.kind,
        (SELECT json_group_array(json_object('id', o.id, 'purpose', o.purpose, 'amount_minor', o.amount_minor, 'method', o.method,
          'paid_on', o.paid_on, 'reference', o.reference, 'note', o.note))
          FROM (SELECT * FROM offline_payments WHERE organization_id = b.organization_id AND booking_id = b.id AND purpose IN ${ENTRY_PURPOSES}
                ORDER BY paid_on, created_at) o) AS entries_json
      FROM bookings b JOIN products p ON p.id = b.product_id AND p.organization_id = b.organization_id
      JOIN organization o ON o.id = b.organization_id
     WHERE b.id = ${target.booking.sql} AND b.organization_id = ${target.organization.sql}`,
    params: [...target.booking.params, ...target.organization.params],
  }
}

type DepositRow = { deposit_minor: number | null; currency: string | null; kind: ProductKind; entries_json: string }
type StoredEntry = Omit<DepositEntry, 'kind'> & { purpose: 'deposit' | 'deposit_withheld' }

/**
 * The deposit as every reader presents it, in the booking's currency or, for a
 * booking paid later with no total yet, the business's own. Null only when the
 * business has no currency at all; required_minor is null while it asks for none.
 */
export function presentDeposit(row: unknown): BookingDeposit | null {
  if (!row) return null
  const { deposit_minor: required, currency, kind, entries_json: entriesJson } = row as DepositRow
  const stored = JSON.parse(entriesJson) as StoredEntry[]
  if (!currency) {
    if (required !== null || stored.length) throw new Error('A booking with a deposit has no currency')
    return null
  }
  const entries: DepositEntry[] = stored.map(({ purpose, amount_minor: amount, ...entry }) => ({
    ...entry, kind: purpose === 'deposit_withheld' ? 'withheld' : amount > 0 ? 'received' : 'returned', amount_minor: Math.abs(amount),
  }))
  const total = (which: DepositEntryKind) => entries.filter(entry => entry.kind === which).reduce((sum, entry) => sum + entry.amount_minor, 0)
  const returned = total('returned'), withheld = total('withheld')
  return { label: depositLabel(kind), currency, required_minor: required, held_minor: total('received') - returned - withheld, returned_minor: returned, withheld_minor: withheld, entries }
}

export async function readBookingDeposit(db: DbClient, organizationId: string, bookingId: string): Promise<BookingDeposit | null> {
  const { query, params } = depositQuery({ booking: { sql: '?', params: [bookingId] }, organization: { sql: '?', params: [organizationId] } })
  return presentDeposit(await queryFirst(db, query, params))
}

function fail(statusCode: number, code: string, message: string, field: string): never {
  throw new HTTPError({ statusCode, message, data: { code, field } })
}

export interface DepositActor { organizationId: string; actorId: string }

/** The booking's own facts a deposit write checks: the business owns it, and it has a currency. */
async function depositBooking(db: DbClient, actor: DepositActor, bookingId: string) {
  const booking = await queryFirst<{ owner: 'app' | 'channel'; currency: string | null; location_id: string | null }>(db,
    'SELECT b.owner, COALESCE(b.currency, o.default_currency) AS currency, b.location_id FROM bookings b JOIN organization o ON o.id = b.organization_id WHERE b.organization_id = ? AND b.id = ?', [actor.organizationId, bookingId])
  if (!booking) fail(404, 'BOOKING_NOT_FOUND', 'That booking is not in this organization', 'booking_id')
  // A channel's guest pays its deposit through the channel, as they pay the stay.
  if (booking.owner === 'channel') fail(409, 'CHANNEL_OWNED', 'This booking’s deposit is handled by the channel it came from', 'booking_id')
  if (!booking.currency) fail(409, 'BOOKING_HAS_NO_CURRENCY', 'The business has no currency to hold a deposit in', 'booking_id')
  return booking
}

/** Set the deposit the business asks for, or null for none. What was already recorded stays. */
export async function setBookingDeposit(db: DbClient, actor: DepositActor, bookingId: string, depositMinor: unknown): Promise<BookingDeposit | null> {
  if (depositMinor !== null && (!Number.isSafeInteger(depositMinor) || (depositMinor as number) <= 0)) fail(422, 'INVALID_AMOUNT', 'deposit_minor must be a positive whole amount in the smallest currency unit, or null', 'deposit_minor')
  const booking = await depositBooking(db, actor, bookingId)
  const now = new Date().toISOString()
  await executeBatch(db, [
    { query: `UPDATE bookings SET deposit_minor = ?, version = version + 1, updated_at = ? WHERE organization_id = ? AND id = ? AND deposit_minor IS NOT ?`, params: [depositMinor, now, actor.organizationId, bookingId, depositMinor] },
    organizationEventQuery({ organizationId: actor.organizationId, locationId: booking.location_id, actorId: actor.actorId, eventType: 'booking.deposit_set', entityType: 'booking', entityId: bookingId, metadata: { deposit_minor: depositMinor }, onlyIfPreviousChangedOneRow: true }),
  ], { operation: 'Set booking deposit' })
  const saved = await readBookingDeposit(db, actor.organizationId, bookingId)
  if ((saved?.required_minor ?? null) !== depositMinor) fail(409, 'DEPOSIT_CHANGED', 'The deposit changed before it could be read back. Reload the booking.', 'deposit_minor')
  return saved
}

function text(value: unknown, field: string, max: number, required = false): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) fail(422, 'VALIDATION_ERROR', `${field} is required`, field)
    return null
  }
  if (typeof value !== 'string' || value.trim().length > max) fail(422, 'VALIDATION_ERROR', `${field} must be text of at most ${max} characters`, field)
  return value.trim() || (required ? fail(422, 'VALIDATION_ERROR', `${field} is required`, field) : null)
}

/**
 * Record money received, returned or kept against the deposit. Returned and
 * kept amounts can never exceed what is held: the insert checks that in the
 * same statement, so two at once cannot overdraw it.
 */
export async function recordDepositEntry(db: DbClient, actor: DepositActor, bookingId: string, input: Record<string, unknown>): Promise<{ deposit: BookingDeposit; entry: DepositEntry }> {
  const kind = input.kind as DepositEntryKind
  if (!DEPOSIT_ENTRY_KINDS.includes(kind)) fail(422, 'VALIDATION_ERROR', `kind must be one of ${DEPOSIT_ENTRY_KINDS.join(', ')}`, 'kind')
  const amount = input.amount_minor
  if (!Number.isSafeInteger(amount) || (amount as number) <= 0) fail(422, 'INVALID_AMOUNT', 'amount_minor must be a positive whole amount in the smallest currency unit', 'amount_minor')
  // What was kept moved no money; it changes whose the held money is.
  const method = kind === 'withheld' ? 'other' : input.method as DepositMethod
  if (!DEPOSIT_METHODS.includes(method)) fail(422, 'VALIDATION_ERROR', `method must be one of ${DEPOSIT_METHODS.join(', ')}`, 'method')
  // A real calendar day: 2026-02-30 parses, but is not one.
  const paidOn = typeof input.paid_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.paid_on) && new Date(`${input.paid_on}T00:00:00Z`).toISOString().slice(0, 10) === input.paid_on ? input.paid_on : fail(422, 'VALIDATION_ERROR', 'paid_on must be a YYYY-MM-DD date', 'paid_on')
  const reference = text(input.reference, 'reference', 200)
  // Keeping part of a deposit needs its reason, as a landlord's itemized statement does.
  const note = text(input.note, 'note', 1000, kind === 'withheld')
  const key = text(input.idempotency_key, 'idempotency_key', 200, true)!
  const booking = await depositBooking(db, actor, bookingId)
  const signed = kind === 'returned' ? -(amount as number) : amount as number
  const purpose = kind === 'withheld' ? 'deposit_withheld' : 'deposit'

  const replay = async () => {
    const existing = await queryFirst<{ id: string; booking_id: string; purpose: string; amount_minor: number; method: string; paid_on: string; reference: string | null; note: string | null }>(db,
      'SELECT id, booking_id, purpose, amount_minor, method, paid_on, reference, note FROM offline_payments WHERE organization_id = ? AND idempotency_key = ?', [actor.organizationId, key])
    if (!existing) return null
    if (existing.booking_id !== bookingId || existing.purpose !== purpose || existing.amount_minor !== signed || existing.method !== method || existing.paid_on !== paidOn || existing.reference !== reference || existing.note !== note) {
      fail(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency_key was already used for a different entry', 'idempotency_key')
    }
    const deposit = await readBookingDeposit(db, actor.organizationId, bookingId)
    const entry = deposit?.entries.find(candidate => candidate.id === existing.id)
    if (!deposit || !entry) fail(409, 'DEPOSIT_CHANGED', 'The entry was recorded but removed before it could be read back. Reload the booking.', 'entry_id')
    return { deposit, entry }
  }
  const earlier = await replay()
  if (earlier) return earlier

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const [inserted] = await executeBatch(db, [
    {
      query: `INSERT INTO offline_payments (id, organization_id, booking_id, amount_minor, currency, method, paid_on, reference, note, purpose, idempotency_key, created_at, created_by)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
               WHERE NOT EXISTS (SELECT 1 FROM offline_payments WHERE organization_id = ? AND idempotency_key = ?)
                 AND (? = 'received' OR ${HELD_SQL} >= ?)`,
      params: [id, actor.organizationId, bookingId, signed, booking.currency, method, paidOn, reference, note, purpose, key, now, actor.actorId,
        actor.organizationId, key, kind, actor.organizationId, bookingId, amount],
    },
    organizationEventQuery({ organizationId: actor.organizationId, locationId: booking.location_id, actorId: actor.actorId, eventType: 'booking.deposit_recorded', entityType: 'booking', entityId: bookingId, metadata: { entry_id: id, kind, amount_minor: amount }, onlyIfPreviousChangedOneRow: true }),
  ], { operation: 'Record deposit entry' })
  if ((inserted?.meta.changes ?? 0) === 0) {
    const concurrent = await replay()
    if (concurrent) return concurrent
    fail(409, 'DEPOSIT_INSUFFICIENT', `Only what is held can be ${kind === 'returned' ? 'returned' : 'kept'}`, 'amount_minor')
  }
  const recorded = await replay()
  if (!recorded) fail(409, 'DEPOSIT_CHANGED', 'The entry was recorded but removed before it could be read back. Reload the booking.', 'entry_id')
  return recorded
}

/** Remove an entry recorded by mistake. A receipt that is already returned or kept stays until those are removed. */
export async function deleteDepositEntry(db: DbClient, actor: DepositActor, bookingId: string, entryId: string): Promise<BookingDeposit | null> {
  const booking = await depositBooking(db, actor, bookingId)
  const [deleted] = await executeBatch(db, [
    {
      query: `DELETE FROM offline_payments WHERE organization_id = ? AND booking_id = ? AND id = ? AND purpose IN ${ENTRY_PURPOSES}
                AND (purpose <> 'deposit' OR amount_minor < 0 OR ${HELD_SQL} >= amount_minor)`,
      params: [actor.organizationId, bookingId, entryId, actor.organizationId, bookingId],
    },
    organizationEventQuery({ organizationId: actor.organizationId, locationId: booking.location_id, actorId: actor.actorId, eventType: 'booking.deposit_deleted', entityType: 'booking', entityId: bookingId, metadata: { entry_id: entryId }, onlyIfPreviousChangedOneRow: true }),
  ], { operation: 'Delete deposit entry' })
  const deposit = await readBookingDeposit(db, actor.organizationId, bookingId)
  if ((deleted?.meta.changes ?? 0) === 0) {
    if (deposit?.entries.some(entry => entry.id === entryId)) fail(409, 'DEPOSIT_IN_USE', 'Part of this receipt was already returned or kept. Remove those entries first.', 'entry_id')
    fail(404, 'ENTRY_NOT_FOUND', 'That deposit entry is not on this booking', 'entry_id')
  }
  return deposit
}
