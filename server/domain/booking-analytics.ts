import { queryFirst, type DbClient } from '~/server/db'
import { recordOrganizationConversionEvent } from '~/server/utils/organization-conversions'
import { getPlatformOrganization } from '~/server/utils/platform-organization'
import { AUTHORIZATION_WINDOW_SECONDS, type Payment } from '~/server/domain/payments'
import type { AttributionTouch } from '~/utils/analytics-attribution'

/**
 * What a business's paid bookings and decisions look like in its analytics: each event is recorded
 * where the thing happens, into the one event store the Insights reports and the analytics MCP tools
 * read. The team member a booking is with is carried as `member_id`.
 */

interface PaymentSubject { productId: string | null; variantId: string | null; memberId: string | null }

async function paymentSubject(db: DbClient, payment: Payment): Promise<PaymentSubject> {
  const snapshot = JSON.parse(payment.price_snapshot_json) as { product_id?: unknown; variant_id?: unknown; stay?: { product_id?: unknown } }
  const held = await queryFirst<{ member_id: string | null }>(db, `SELECT c.assigned_member_id member_id
    FROM payment_checkout_holds h JOIN product_booking_configs c ON c.product_id=h.product_id AND c.organization_id=h.organization_id WHERE h.payment_id=?`, [payment.id])
  return {
    productId: typeof snapshot.product_id === 'string' ? snapshot.product_id : typeof snapshot.stay?.product_id === 'string' ? snapshot.stay.product_id : null,
    variantId: typeof snapshot.variant_id === 'string' ? snapshot.variant_id : null,
    memberId: held?.member_id ?? null,
  }
}

/**
 * A checkout the guest started, read in the guest's own request: how they
 * arrived is its attribution, as for any other website event. The event is
 * once per payment, so a retry, even from another campaign, keeps the first.
 * `savedCardsOffered` is null on a retry that reuses the Checkout already
 * created, where the count was not observed.
 */
export async function recordCheckoutStarted(db: DbClient, payment: Payment, savedCardsOffered: number | null, origin: { request: { headers: Headers }; pageEventId: string | null } | null) {
  const subject = await paymentSubject(db, payment)
  await recordOrganizationConversionEvent(db, origin?.request ?? null, {
    organizationId: payment.organization_id, eventName: 'payment_checkout_started', stage: 'started', surface: 'website',
    locationId: payment.location_id, productId: subject.productId, variantId: subject.variantId,
    entityType: 'payment', entityId: payment.id, originEventId: origin?.pageEventId ?? null,
    value: { basis: 'quoted', amount_minor: payment.amount, currency: payment.currency },
    properties: { member_id: subject.memberId, saved_cards_offered: savedCardsOffered },
  })
}

/**
 * How the guest who started a payment's checkout arrived, as that event
 * recorded it. Stripe's capture and refund events have no browser, so they are
 * credited to the checkout's own source; a payment whose checkout recorded
 * none, or that predates recording one, stays unattributed.
 */
async function checkoutAttribution(db: DbClient, payment: Payment): Promise<{ touch: AttributionTouch; attributedAt: string } | null> {
  const started = await queryFirst<{ touch: string | null; attributed_at: string | null }>(db, `SELECT json_extract(payload_json, '$.attribution') AS touch,
    json_extract(payload_json, '$.attributed_at') AS attributed_at FROM analytics_events
    WHERE organization_id = ? AND kind = 'interaction' AND json_extract(payload_json, '$.event_name') = 'payment_checkout_started'
      AND json_extract(payload_json, '$.entity_type') = 'payment' AND json_extract(payload_json, '$.entity_id') = ?`, [payment.organization_id, payment.id])
  if (!started?.touch) return null
  if (!started.attributed_at) throw new Error(`Checkout of payment ${payment.id} recorded an attribution without its time`)
  return { touch: JSON.parse(started.touch) as AttributionTouch, attributedAt: started.attributed_at }
}

/** A captured payment: its value excludes tax, its collected amount is what the buyer paid. */
export async function recordPaymentPaid(db: DbClient, payment: Payment, intentId: string, savedCard: boolean) {
  const subject = await paymentSubject(db, payment)
  await recordOrganizationConversionEvent(db, null, {
    organizationId: payment.organization_id, eventName: 'payment_paid', stage: 'completed', surface: 'stripe',
    locationId: payment.location_id, productId: subject.productId, variantId: subject.variantId,
    entityType: 'payment', entityId: payment.id, attribution: await checkoutAttribution(db, payment),
    value: { basis: 'purchase', amount_minor: payment.captured_amount - payment.tax_amount, collected_minor: payment.captured_amount, currency: payment.currency, transaction_id: intentId },
    properties: { member_id: subject.memberId, saved_card: savedCard },
  })
}

/** A refund that reached the buyer. Approval time is from the business's request to its approval. */
export async function recordPaymentRefunded(db: DbClient, payment: Payment, refund: { id: string; amount: number }, refundRowId: string) {
  const subject = await paymentSubject(db, payment)
  const origin = await queryFirst<{ idempotency_key: string; created_by: string | null; approval_seconds: number | null }>(db, `
    SELECT r.idempotency_key, r.created_by, (SELECT CAST(ROUND((julianday(a.approved_at)-julianday(a.expires_at))*86400) AS INTEGER)+? FROM payment_authorizations a
      WHERE a.payment_id=r.payment_id AND a.approved_at IS NOT NULL AND (r.idempotency_key='approved:'||a.id
        OR (a.action='reject_booking' AND r.idempotency_key LIKE 'rejected:%') OR (a.action='cancel_booking' AND r.idempotency_key LIKE 'cancelled:%'))
      ORDER BY a.approved_at DESC LIMIT 1) approval_seconds
    FROM payment_refunds r WHERE r.id=?`, [AUTHORIZATION_WINDOW_SECONDS, refundRowId])
  await recordOrganizationConversionEvent(db, null, {
    organizationId: payment.organization_id, eventName: 'payment_refunded', stage: 'completed', surface: 'stripe',
    locationId: payment.location_id, productId: subject.productId, variantId: subject.variantId,
    entityType: 'refund', entityId: refund.id, attribution: await checkoutAttribution(db, payment),
    value: { basis: 'refund', amount_minor: refund.amount, collected_minor: refund.amount, currency: payment.currency, transaction_id: refund.id },
    actor: origin?.created_by ? { type: 'staff', id: origin.created_by } : null,
    properties: {
      member_id: subject.memberId,
      full: refund.amount === payment.captured_amount,
      with_cancellation: Boolean(origin && /^(rejected|cancelled):/.test(origin.idempotency_key)),
      approval_seconds: origin?.approval_seconds ?? null,
    },
  })
}

interface BookingSubject { product_id: string; product_variant_id: string | null; assigned_member_id: string | null; location_id: string | null; created_at: string }

async function bookingSubject(db: DbClient, organizationId: string, bookingId: string): Promise<BookingSubject> {
  const booking = await queryFirst<BookingSubject>(db, `SELECT b.product_id, b.product_variant_id, c.assigned_member_id, s.location_id, b.created_at
    FROM bookings b JOIN product_sessions s ON s.id=b.product_session_id AND s.organization_id=b.organization_id
    JOIN product_booking_configs c ON c.product_id=b.product_id AND c.organization_id=b.organization_id WHERE b.id=? AND b.organization_id=?`, [bookingId, organizationId])
  if (!booking) throw new Error(`Booking ${bookingId} is not in organization ${organizationId}`)
  return booking
}

/** A business confirmed or declined a booking it was reviewing; decision time runs from the request. */
export async function recordBookingDecision(db: DbClient, input: { organizationId: string; bookingId: string; decision: 'confirmed' | 'declined'; actorUserId: string | null; decidedAt: string }) {
  const booking = await bookingSubject(db, input.organizationId, input.bookingId)
  await recordOrganizationConversionEvent(db, null, {
    organizationId: input.organizationId, eventName: input.decision === 'confirmed' ? 'booking_confirmed' : 'booking_declined', stage: 'completed', surface: 'dashboard',
    locationId: booking.location_id, productId: booking.product_id, variantId: booking.product_variant_id,
    entityType: 'booking', entityId: input.bookingId,
    actor: input.actorUserId ? { type: 'staff', id: input.actorUserId } : null,
    properties: { member_id: booking.assigned_member_id, decision_seconds: Math.max(0, Math.round((Date.parse(input.decidedAt) - Date.parse(booking.created_at)) / 1000)) },
  })
}

export async function recordBookingCancelled(db: DbClient, input: { organizationId: string; bookingId: string; cancelledBy: 'guest' | 'business'; actorUserId: string | null }) {
  const booking = await bookingSubject(db, input.organizationId, input.bookingId)
  await recordOrganizationConversionEvent(db, null, {
    organizationId: input.organizationId, eventName: 'booking_cancelled', stage: 'completed', surface: input.cancelledBy === 'guest' ? 'website' : 'dashboard',
    locationId: booking.location_id, productId: booking.product_id, variantId: booking.product_variant_id,
    entityType: 'booking', entityId: input.bookingId,
    actor: input.actorUserId ? { type: input.cancelledBy === 'guest' ? 'user' : 'staff', id: input.actorUserId } : null,
    properties: { member_id: booking.assigned_member_id, cancelled_by: input.cancelledBy },
  })
}

/** The guest answered a change the business proposed; the change request is the subject. */
export async function recordBookingChangeAnswer(db: DbClient, input: { organizationId: string; bookingId: string; changeRequestId: string; accepted: boolean }) {
  const booking = await bookingSubject(db, input.organizationId, input.bookingId)
  await recordOrganizationConversionEvent(db, null, {
    organizationId: input.organizationId, eventName: input.accepted ? 'booking_change_accepted' : 'booking_change_declined', stage: 'completed', surface: 'website',
    locationId: booking.location_id, productId: booking.product_id, variantId: booking.product_variant_id,
    entityType: 'request', entityId: input.changeRequestId,
    properties: { member_id: booking.assigned_member_id },
  })
}

/** A business’s captured volume, reported to its Stripe meter for its Payments fee, on the platform’s analytics. */
export async function recordPaymentsVolumeBilled(db: DbClient, input: { organizationId: string; paymentId: string; volumeMinor: number; currency: string }) {
  await recordOrganizationConversionEvent(db, null, {
    organizationId: (await getPlatformOrganization(db)).id, eventName: 'payments_volume_billed', stage: 'occurred', surface: 'stripe',
    entityType: 'payment', entityId: input.paymentId,
    properties: { tenant_organization_id: input.organizationId, volume_minor: input.volumeMinor, currency: input.currency },
  })
}

