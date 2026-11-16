import type Stripe from 'stripe'
import { reconcilePaymentIntent } from '../../../server/domain/payments/events.ts'
import { requirePayment } from '../../../server/domain/payments/index.ts'
import type { StayPurchase } from '../../../server/domain/payments/checkout.ts'
import { stayCheckoutPolicy } from '../../../server/domain/stays.ts'
import { bookingPolicy } from '../../../server/utils/booking-policy-summary.ts'
import { requireBookingConfig } from '../../../server/utils/availability.ts'
import type { CloudflareEnv } from '../../../server/utils/auth.ts'

/**
 * An authorized checkout at the Stripe boundary. Reconciliation saves the stay
 * and its conversation before it asks Stripe to capture the payment.
 */
export async function buyStay(db: D1Database, env: CloudflareEnv, input: {
  id: string
  organizationId: string
  productId: string
  locationId: string
  timezone: string
  checkIn: string
  checkOut: string
  adults: number
  nightlyMinor: number
  currency: string
  buyerUserId: string
  guest: StayPurchase['guest']
}): Promise<{ id: string; conversation_id: string }> {
  const nights: string[] = []
  for (let day = new Date(`${input.checkIn}T00:00:00Z`); day < new Date(`${input.checkOut}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) nights.push(day.toISOString().slice(0, 10))
  const total = nights.length * input.nightlyMinor
  const purchase: StayPurchase = {
    product_id: input.productId, location_id: input.locationId, timezone: input.timezone, check_in_date: input.checkIn, check_out_date: input.checkOut,
    adults: input.adults, children: 0, infants: 0, total_minor: total, currency: input.currency, cancellation_policy: 'moderate',
    nightly: nights.map(date => ({ date, price_minor: input.nightlyMinor })), guest: input.guest,
  }
  // The terms checkout freezes with the purchase, from the home as it stands.
  const policy = stayCheckoutPolicy(bookingPolicy(await requireBookingConfig(db, input.organizationId, purchase.product_id), null), { ...purchase, tax_behavior: 'unspecified' })
  const now = new Date().toISOString()
  const paymentId = `${input.id}-payment`, holdId = `${input.id}-hold`
  const intentId = `pi_${input.id}`
  const expiresAt = new Date(Date.parse(now) + 3_600_000).toISOString()
  await db.batch([
    db.prepare(`INSERT INTO payments (id,organization_id,buyer_user_id,stripe_account_id,livemode,subject_type,subject_id,location_id,currency,amount,stripe_payment_intent_id,price_snapshot_json,checkout_expires_at,created_at,updated_at)
      VALUES (?, ?, ?, 'acct_seller', 0, 'booking', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(paymentId, input.organizationId, input.buyerUserId, input.locationId, input.currency, total, intentId, JSON.stringify({ title: 'Stay', quantity: 1, price: { unit_amount: total, currency: input.currency }, stay: purchase, policy }), expiresAt, now, now),
    db.prepare(`INSERT INTO payment_checkout_holds (id, organization_id, product_id, location_id, timezone, buyer_user_id, payment_id, quantity, amount, currency, starts_at, ends_at, status, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
      .bind(holdId, input.organizationId, input.productId, input.locationId, input.timezone, input.buyerUserId, paymentId, input.adults, total, input.currency, input.checkIn, input.checkOut, expiresAt, now),
  ])
  const created = Math.floor(Date.parse(now) / 1000)
  const charge = { id: `ch_${input.id}`, payment_intent: intentId, livemode: false, amount: total, created,
    billing_details: { email: input.guest.email }, receipt_url: null }
  const authorized = { id: intentId, livemode: false, currency: input.currency.toLowerCase(), amount: total, created,
    status: 'requires_capture', metadata: { krabiclaw_payment_id: paymentId }, latest_charge: charge } as Stripe.PaymentIntent
  const stripe = { paymentIntents: { capture: async () => ({ ...authorized, status: 'succeeded', amount_received: total }) } } as unknown as Stripe
  await reconcilePaymentIntent(db, stripe, await requirePayment(db, input.organizationId, paymentId), authorized, env)
  const { subject_id: stayId } = await requirePayment(db, input.organizationId, paymentId)
  if (!stayId) throw new Error(`The checkout for ${input.id} did not convert into a stay`)
  const stay = await db.prepare("SELECT b.id, c.id AS conversation_id FROM bookings b LEFT JOIN conversations c ON c.booking_id = b.id AND c.kind = 'booking' WHERE b.id = ? AND b.product_session_id IS NULL").bind(stayId).first<{ id: string; conversation_id: string | null }>()
  if (!stay?.conversation_id) throw new Error(`The stay bought by ${input.id} has no conversation`)
  return { id: stay.id, conversation_id: stay.conversation_id }
}
