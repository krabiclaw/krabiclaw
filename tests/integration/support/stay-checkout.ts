import { convertStayHold } from '../../../server/domain/payments/events.ts'
import type { StayPurchase } from '../../../server/domain/payments/checkout.ts'

/**
 * A stay its guest bought on the site: the checkout's payment as Stripe's
 * capture leaves it, then the real conversion that capture runs, which makes
 * the buyer's stay and its conversation. Nothing about the stay is written here.
 */
export async function buyStay(db: D1Database, input: {
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
}): Promise<{ id: string; request_id: string }> {
  const nights: string[] = []
  for (let day = new Date(`${input.checkIn}T00:00:00Z`); day < new Date(`${input.checkOut}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) nights.push(day.toISOString().slice(0, 10))
  const total = nights.length * input.nightlyMinor
  const purchase: StayPurchase = {
    product_id: input.productId, location_id: input.locationId, timezone: input.timezone, check_in_date: input.checkIn, check_out_date: input.checkOut,
    adults: input.adults, children: 0, infants: 0, total_minor: total, currency: input.currency, cancellation_policy: 'moderate',
    nightly: nights.map(date => ({ date, price_minor: input.nightlyMinor })), guest: input.guest,
  }
  const now = new Date().toISOString()
  const paymentId = `${input.id}-payment`, holdId = `${input.id}-hold`
  await db.batch([
    db.prepare(`INSERT INTO payments (id,organization_id,buyer_user_id,stripe_account_id,livemode,subject_type,subject_id,location_id,currency,amount,captured_amount,stripe_payment_intent_id,price_snapshot_json,created_at,updated_at)
      VALUES (?, ?, ?, 'acct_seller', 0, 'stay', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(paymentId, input.organizationId, input.buyerUserId, input.locationId, input.currency, total, total, `pi_${input.id}`, JSON.stringify({ title: 'Stay', quantity: 1, price: { unit_amount: total, currency: input.currency }, stay: purchase }), now, now),
    db.prepare(`INSERT INTO payment_checkout_holds (id, organization_id, product_id, location_id, timezone, buyer_user_id, payment_id, quantity, amount, currency, starts_at, ends_at, status, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '2099-01-01T00:00:00.000Z', ?)`)
      .bind(holdId, input.organizationId, input.productId, input.locationId, input.timezone, input.buyerUserId, paymentId, input.adults, total, input.currency, input.checkIn, input.checkOut, now),
  ])
  const stayId = await convertStayHold(db as never, {
    payment: { id: paymentId, organization_id: input.organizationId, buyer_user_id: input.buyerUserId },
    hold: { id: holdId, product_id: input.productId, location_id: input.locationId, buyer_user_id: input.buyerUserId },
    purchase,
  })
  if (!stayId) throw new Error(`The checkout for ${input.id} did not convert into a stay`)
  const stay = await db.prepare('SELECT id, request_id FROM stays WHERE id = ?').bind(stayId).first<{ id: string; request_id: string | null }>()
  if (!stay?.request_id) throw new Error(`The stay bought by ${input.id} has no conversation`)
  return { id: stay.id, request_id: stay.request_id }
}
