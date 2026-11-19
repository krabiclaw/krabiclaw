import { HTTPError } from 'nitro'
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { isRecord } from '~/server/utils/type-guards'
import type { CloudflareEnv } from '~/server/utils/auth'
import type { Payment } from '~/server/domain/payments'
import { publishChangedJobs, publishEvent } from '~/server/events'
import { revokeReviewRequestQuery } from '~/server/utils/review-requests'
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
  calendar?: boolean
} & ({ status: 'confirmed' | 'pending' } | { status: 'cancelled'; reason: string | null })): BatchQuery {
  const stamps = input.status === 'cancelled' ? ', cancelled_at = ?, cancellation_reason = ?' : ''
  const stampParams = input.status === 'cancelled' ? [input.now, input.reason] : []
  return {
    query: `UPDATE bookings SET status = ?, updated_at = ?, version = version + 1${stamps}
      WHERE organization_id = ? AND id = ? AND (${input.guard.query})`,
    params: [input.status, input.now, ...stampParams, input.organizationId, input.bookingId, ...(input.guard.params ?? [])],
    ...(input.calendar ? { event: { type: 'calendar.changed' as const, organization_id: input.organizationId, booking_id: input.bookingId } } : {}),
  }
}

/** A failed checkout payment cancels the booking its checkout made and releases its inventory. */
export async function cancelFailedCheckoutBooking(db: DbClient, env: CloudflareEnv, payment: Pick<Payment, 'id' | 'organization_id' | 'subject_type' | 'subject_id' | 'stripe_payment_intent_id'>, intentId: string): Promise<void> {
  if (payment.subject_type !== 'booking' || !payment.subject_id || payment.stripe_payment_intent_id !== intentId) return
  const organizationId = payment.organization_id
  const bookingId = payment.subject_id
  const failedCheckout = {
    query: `owner = 'app' AND channel = 'direct' AND EXISTS (
      SELECT 1 FROM payments p
      JOIN payment_checkout_holds h ON h.payment_id = p.id AND h.organization_id = p.organization_id
      WHERE p.id = ? AND p.organization_id = bookings.organization_id AND p.subject_type = 'booking'
        AND p.subject_id = bookings.id AND p.stripe_payment_intent_id = ? AND p.captured_amount = 0
        AND h.status = 'converted' AND h.converted_booking_id = bookings.id)`,
    params: [payment.id, intentId],
  }
  const target = await queryFirst<{ status: string; cancellation_reason: string | null; product_session_id: string | null; conversation_id: string | null }>(db, `
    SELECT status, cancellation_reason, product_session_id,
      (SELECT c.id FROM conversations c WHERE c.organization_id = bookings.organization_id AND c.booking_id = bookings.id AND c.kind = 'booking') AS conversation_id
    FROM bookings WHERE organization_id = ? AND id = ? AND ${failedCheckout.query}`,
  [organizationId, bookingId, ...failedCheckout.params])
  const reason = 'The payment failed.'
  if (!target || (target.status !== 'confirmed' && (target.status !== 'cancelled' || target.cancellation_reason !== reason))) return
  if (!target.conversation_id) throw new Error(`Booking ${bookingId} has no conversation`)
  const now = new Date().toISOString()
  const revokeReview = revokeReviewRequestQuery({
    query: `organization_id = ? AND booking_id = ? AND EXISTS (SELECT 1 FROM bookings b
      WHERE b.organization_id = review_requests.organization_id AND b.id = review_requests.booking_id
        AND b.status = 'cancelled' AND b.cancellation_reason = ?)`,
    params: [organizationId, bookingId, reason],
  }, now)
  if (!target.product_session_id) {
    const { cancelFailedCheckoutStay } = await import('~/server/domain/stays')
    return cancelFailedCheckoutStay(db, env, { organizationId, bookingId, reason, now, guard: failedCheckout, revokeReview })
  }
  if (target.status === 'confirmed') {
    const { conversationTaskQueries } = await import('~/server/domain/guest-threads/repository')
    const [write] = await executeBatch(db, [
      bookingStatusQuery({ organizationId, bookingId, status: 'cancelled', reason, now,
        guard: { query: `status = 'confirmed' AND product_session_id = ? AND ${failedCheckout.query}`,
          params: [target.product_session_id, ...failedCheckout.params] } }),
      revokeReview,
      ...conversationTaskQueries(target.conversation_id, now),
    ], { operation: 'Cancel booking after failed payment' })
    if (write?.meta.changes !== 1) throw new Error(`Booking ${bookingId} changed before payment failure cancellation`)
  }
  const { planSourceMessages } = await import('~/server/domain/scheduled-guest-messages')
  await planSourceMessages(db, organizationId, bookingId)
  const jobs = await queryAll<{ id: string }>(db, `SELECT id FROM tasks WHERE organization_id = ? AND (
      (kind = 'consultation_follow_up' AND subject_type = 'booking' AND subject_id = ?)
      OR (kind = 'consultation_prep' AND subject_type = 'product_session' AND subject_id = ?))`, [organizationId, bookingId, target.product_session_id])
  await publishChangedJobs(env, organizationId, jobs.map(job => job.id))
  await publishEvent(env, { type: 'calendar.changed', organization_id: organizationId, booking_id: bookingId })
}

/** Replace the team's private note only while the booking still matches the version the team read. */
export async function setBookingNote(db: DbClient, scope: BookingScope, body: unknown) {
  if (!isRecord(body)) throw new HTTPError({ statusCode: 400, message: 'private_notes and version are required' })
  if (typeof body.private_notes !== 'string') throw new HTTPError({ statusCode: 400, message: 'private_notes must be text' })
  const note = body.private_notes.trim()
  if (note.length > 2000) throw new HTTPError({ statusCode: 400, message: 'Note must be at most 2000 characters' })
  if (typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1) throw new HTTPError({ statusCode: 400, message: 'Booking version is required' })
  const saved = await queryFirst<{ booking_id: string; private_notes: string | null; version: number }>(db, `
    UPDATE bookings SET private_notes = ?, version = version + 1, updated_at = ?
    WHERE organization_id = ? AND id = ? AND version = ?
    RETURNING id AS booking_id, private_notes, version`, [note || null, new Date().toISOString(), scope.organizationId, scope.bookingId, body.version])
  if (!saved) throw new HTTPError({ statusCode: 409, message: 'This booking changed since you opened it. Reload and try again.' })
  return saved
}

export function timedBookingPricesQuery(organization: BatchQuery, variants: BatchQuery): BatchQuery {
  return { query: `SELECT * FROM prices WHERE organization_id=${organization.query}
    AND product_variant_id IN (${variants.query}) AND stay_date IS NULL AND weekend=0`,
  params: [...organization.params ?? [], ...variants.params ?? []] }
}

export function timedBookingPriceFrom(prices: Price[], input: { variantId: string; locationId: string | null; currency: CurrencyCode; now: string }): Price | null {
  return selectPrice(prices.filter(price => price.product_variant_id === input.variantId).map(price => ({ ...price, active: Boolean(price.active) })), {
    currency: input.currency, location_id: input.locationId, at: input.now, billing: { type: 'one_time' },
  })
}

export async function readTimedBookingPrice(db: DbClient, input: {
  organizationId: string; variantId: string; locationId: string | null; currency: CurrencyCode; now: string
}): Promise<Price | null> {
  const { query, params } = timedBookingPricesQuery({ query: '?', params: [input.organizationId] }, { query: 'SELECT ?', params: [input.variantId] })
  return timedBookingPriceFrom(await queryAll<Price>(db, query, params), input)
}
