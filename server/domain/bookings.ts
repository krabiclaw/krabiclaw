import { HTTPError } from 'nitro'
import { execute, queryAll, type BatchQuery, type DbClient } from '~/server/db'
import { isRecord } from '~/server/utils/type-guards'
import type { CurrencyCode } from '~/shared/currencies'
import { selectPrice, type Price } from '~/shared/prices'

interface BookingScope {
  organizationId: string
  bookingId: string
}

/** The booking owns its status and version. Its unit determines what the transaction releases. */
export function bookingStatusQuery(input: BookingScope & {
  now: string
  guard: BatchQuery
} & ({ status: 'confirmed' | 'pending' } | { status: 'cancelled'; reason: string | null })): BatchQuery {
  const stamps = input.status === 'cancelled' ? ', cancelled_at = ?, cancellation_reason = ?' : ''
  const stampParams = input.status === 'cancelled' ? [input.now, input.reason] : []
  return {
    query: `UPDATE bookings SET status = ?, updated_at = ?, version = version + 1${stamps}
      WHERE organization_id = ? AND id = ? AND (${input.guard.query})`,
    params: [input.status, input.now, ...stampParams, input.organizationId, input.bookingId, ...(input.guard.params ?? [])],
  }
}

/** Replace the team's private note only while the booking still matches the version the team read. */
export async function setBookingNote(db: DbClient, scope: BookingScope, body: unknown): Promise<void> {
  if (!isRecord(body)) throw new HTTPError({ statusCode: 400, message: 'private_notes and version are required' })
  if (typeof body.private_notes !== 'string') throw new HTTPError({ statusCode: 400, message: 'private_notes must be text' })
  const note = body.private_notes.trim()
  if (note.length > 2000) throw new HTTPError({ statusCode: 400, message: 'Note must be at most 2000 characters' })
  if (typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1) throw new HTTPError({ statusCode: 400, message: 'Booking version is required' })
  const written = await execute(db, `UPDATE bookings SET private_notes = ?, version = version + 1, updated_at = ?
    WHERE organization_id = ? AND id = ? AND version = ?`, [note || null, new Date().toISOString(), scope.organizationId, scope.bookingId, body.version])
  if (written.meta.changes !== 1) throw new HTTPError({ statusCode: 409, message: 'This booking changed since you opened it. Reload and try again.' })
}

export async function readTimedBookingPrice(db: DbClient, input: {
  organizationId: string; variantId: string; locationId: string | null; currency: CurrencyCode; now: string
}): Promise<Price | null> {
  const prices = await queryAll<Price>(db, 'SELECT * FROM prices WHERE organization_id=? AND product_variant_id=? AND stay_date IS NULL AND weekend=0', [input.organizationId, input.variantId])
  return selectPrice(prices.map(price => ({ ...price, active: Boolean(price.active) })), {
    currency: input.currency, location_id: input.locationId, at: input.now, billing: { type: 'one_time' },
  })
}
