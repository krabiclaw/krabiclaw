import type Stripe from 'stripe'
import { HTTPError } from 'nitro'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { loadOwnerPictures } from '~/server/notifications/hero'
import { getStripeConnectedAccount, paymentsStripe } from '~/server/utils/stripe-connect'
import type { CloudflareEnv } from '~/server/utils/auth'
import { authorizePayments, type FinancialPrincipal, type Payment } from './index'

/**
 * The Earnings screens as Airbnb draws them: a payment leads with the picture
 * of what was sold, a month has a total, and a payout lists what it carried.
 * Everything here is read from the payments the business already holds and
 * from Stripe; nothing is stored.
 */

export interface PaymentPicture { title: string; imageUrl: string | null; subjectTitle: string | null; startsAt: string | null; endsAt: string | null; timeZone: string | null }

/** What each payment was for — its immutable title, the thing's picture, and the visit's dates when it paid for one. */
export async function paymentPictures(db: DbClient, organizationId: string, payments: readonly Pick<Payment, 'id' | 'subject_type' | 'subject_id' | 'location_id' | 'price_snapshot_json'>[]): Promise<Map<string, PaymentPicture>> {
  const ids = payments.map(payment => payment.id)
  if (!ids.length) return new Map()
  const json = JSON.stringify(ids)
  const [bookings, reservations, lines] = await Promise.all([
    queryAll<{ payment_id: string; product_id: string; title: string; starts_at: string; ends_at: string; timezone: string }>(db, `SELECT p.id AS payment_id, b.product_id, pr.name AS title, s.starts_at, s.ends_at, s.timezone FROM payments p JOIN bookings b ON b.id = p.subject_id AND b.organization_id = p.organization_id JOIN product_sessions s ON s.id = b.product_session_id JOIN products pr ON pr.id = b.product_id WHERE p.subject_type = 'booking' AND p.id IN (SELECT value FROM json_each(?))`, [json]),
    queryAll<{ payment_id: string; location_id: string; title: string; starts_at: string; ends_at: string; timezone: string }>(db, `SELECT p.id AS payment_id, v.location_id, l.title, v.starts_at, v.ends_at, v.timezone FROM payments p JOIN reservations v ON v.id = p.subject_id AND v.organization_id = p.organization_id JOIN business_locations l ON l.id = v.location_id WHERE p.subject_type = 'reservation' AND p.id IN (SELECT value FROM json_each(?))`, [json]),
    queryAll<{ payment_id: string; product_id: string | null }>(db, `SELECT o.payment_id, (SELECT l.product_id FROM payment_order_lines l WHERE l.order_id = o.id ORDER BY l.rowid LIMIT 1) AS product_id FROM payment_orders o WHERE o.payment_id IN (SELECT value FROM json_each(?))`, [json]),
  ])
  const productIds = [...bookings.map(row => row.product_id), ...lines.map(row => row.product_id).filter((id): id is string => !!id)]
  const locationIds = [...reservations.map(row => row.location_id), ...payments.map(payment => payment.location_id).filter((id): id is string => !!id)]
  const [products, locations, organization] = await Promise.all([
    loadOwnerPictures(db, organizationId, 'product', productIds),
    loadOwnerPictures(db, organizationId, 'business_location', locationIds),
    loadOwnerPictures(db, organizationId, 'organization', [organizationId]),
  ])
  const result = new Map<string, PaymentPicture>()
  for (const payment of payments) {
    const snapshot: unknown = JSON.parse(payment.price_snapshot_json)
    if (!snapshot || typeof snapshot !== 'object' || !('title' in snapshot) || typeof snapshot.title !== 'string' || !snapshot.title.trim()) throw new Error(`Payment ${payment.id} has no immutable title`)
    const booking = bookings.find(row => row.payment_id === payment.id)
    const reservation = reservations.find(row => row.payment_id === payment.id)
    const line = lines.find(row => row.payment_id === payment.id)
    // The picture is the thing sold; failing that, where it was sold; failing that, the business's own mark.
    const imageUrl = (booking && products.get(booking.product_id)?.imageUrl)
      || (reservation && locations.get(reservation.location_id)?.imageUrl)
      || (line?.product_id && products.get(line.product_id)?.imageUrl)
      || (payment.location_id && locations.get(payment.location_id)?.imageUrl)
      || organization.get(organizationId)?.imageUrl
      || null
    const visit = booking ?? reservation ?? null
    result.set(payment.id, { title: snapshot.title, imageUrl, subjectTitle: visit?.title ?? null, startsAt: visit?.starts_at ?? null, endsAt: visit?.ends_at ?? null, timeZone: visit?.timezone ?? null })
  }
  return result
}

export interface MonthEarnings { month: string; paid: number; refunded: number }
export interface EarningsPerformance {
  /** What was earned in; with nothing earned yet, the currency the business sells in. */
  currency: string
  /** Twelve months of the year, every month present. */
  months: MonthEarnings[]
  /** The selected month by what was sold, largest first. */
  items: Array<{ title: string; imageUrl: string | null; paid: number; count: number }>
}

/** Airbnb's Performance: the year by month, and one month by what was sold. */
export async function paymentPerformance(db: DbClient, principal: FinancialPrincipal, year: number, month: string): Promise<EarningsPerformance> {
  await authorizePayments(principal, 'read')
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new HTTPError({ statusCode: 400, statusMessage: 'Valid year is required' })
  if (!/^\d{4}-\d{2}$/.test(month) || !month.startsWith(`${year}-`)) throw new HTTPError({ statusCode: 400, statusMessage: 'Valid month within the requested year is required' })
  const rows = await queryAll<{ month: string; currency: string; paid: number; refunded: number }>(db, `SELECT strftime('%Y-%m', created_at) AS month, currency, SUM(captured_amount) AS paid, SUM(refunded_amount) AS refunded FROM payments WHERE organization_id = ? AND created_at >= ? AND created_at < ? GROUP BY 1, 2 ORDER BY 1`, [principal.organizationId, `${year}-01-01T00:00:00.000Z`, `${year + 1}-01-01T00:00:00.000Z`])
  const currencies = [...new Set(rows.map(row => row.currency))]
  if (currencies.length > 1) throw new HTTPError({ statusCode: 409, statusMessage: 'Earnings in more than one currency cannot be charted together' })
  const months = Array.from({ length: 12 }, (_, index) => {
    const key = `${year}-${String(index + 1).padStart(2, '0')}`
    const row = rows.find(entry => entry.month === key)
    return { month: key, paid: row?.paid ?? 0, refunded: row?.refunded ?? 0 }
  })
  const [monthYear, monthNumber] = month.split('-').map(Number)
  const next = new Date(Date.UTC(monthYear!, monthNumber!, 1)).toISOString()
  const payments = await queryAll<Payment>(db, `SELECT * FROM payments WHERE organization_id = ? AND created_at >= ? AND created_at < ? AND captured_amount > 0`, [principal.organizationId, `${month}-01T00:00:00.000Z`, next])
  const pictures = await paymentPictures(db, principal.organizationId, payments)
  const byTitle = new Map<string, { title: string; imageUrl: string | null; paid: number; count: number }>()
  for (const payment of payments) {
    const picture = pictures.get(payment.id)!
    const entry = byTitle.get(picture.title) ?? { title: picture.title, imageUrl: picture.imageUrl, paid: 0, count: 0 }
    entry.paid += payment.captured_amount - payment.refunded_amount
    entry.count += 1
    byTitle.set(picture.title, entry)
  }
  const currency = currencies[0] ?? (await queryFirst<{ default_currency: string }>(db, 'SELECT default_currency FROM organization WHERE id = ?', [principal.organizationId]))?.default_currency
  if (!currency) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
  return { currency, months, items: [...byTitle.values()].sort((a, b) => b.paid - a.paid) }
}

export interface PayoutItem { paymentId: string; title: string; imageUrl: string | null; amount: number; currency: string; startsAt: string | null; endsAt: string | null; timeZone: string | null; subjectTitle: string | null }
export interface PayoutDetail {
  id: string
  amount: number
  currency: string
  status: string
  arrivalDate: number
  bank: { bankName: string | null; last4: string } | null
  items: PayoutItem[]
}

export async function connectedStripe(db: DbClient, env: CloudflareEnv, organizationId: string) {
  const account = await getStripeConnectedAccount(db, organizationId)
  if (!account?.stripeAccountId) throw new HTTPError({ statusCode: 404, statusMessage: 'Stripe account not connected' })
  return { stripe: paymentsStripe(env, account.livemode), options: { stripeAccount: account.stripeAccountId } }
}

/**
 * The payments a payout carried, matched through Stripe's balance transactions
 * to the charges this business recorded. Stripe attributes transactions only to
 * the payouts it schedules itself; a payout someone created by hand carries none.
 */
export async function payoutItems(db: DbClient, stripe: Stripe, options: { stripeAccount: string }, organizationId: string, payoutId: string): Promise<PayoutItem[]> {
  const payout = await stripe.payouts.retrieve(payoutId, {}, options)
  if (!payout.automatic) return []
  const transactions = await stripe.balanceTransactions.list({ payout: payoutId, type: 'charge', limit: 100 }, options)
  const chargeIds = transactions.data.map(row => typeof row.source === 'string' ? row.source : row.source?.id).filter((id): id is string => !!id)
  if (!chargeIds.length) return []
  const payments = await queryAll<Payment>(db, `SELECT * FROM payments WHERE organization_id = ? AND stripe_charge_id IN (SELECT value FROM json_each(?))`, [organizationId, JSON.stringify(chargeIds)])
  const pictures = await paymentPictures(db, organizationId, payments)
  return payments.map((payment) => {
    const picture = pictures.get(payment.id)!
    const transaction = transactions.data.find(row => (typeof row.source === 'string' ? row.source : row.source?.id) === payment.stripe_charge_id)
    return { paymentId: payment.id, title: picture.title, imageUrl: picture.imageUrl, amount: transaction?.net ?? payment.captured_amount, currency: (transaction?.currency ?? payment.currency).toUpperCase(), startsAt: picture.startsAt, endsAt: picture.endsAt, timeZone: picture.timeZone, subjectTitle: picture.subjectTitle }
  })
}

/** One payout as Airbnb's sheet shows it: amount, sent date, the bank it went to, and what it carried. */
export async function paymentPayoutDetail(db: DbClient, env: CloudflareEnv, principal: FinancialPrincipal, payoutId: string): Promise<PayoutDetail> {
  await authorizePayments(principal, 'payouts')
  const { stripe, options } = await connectedStripe(db, env, principal.organizationId)
  const payout = await stripe.payouts.retrieve(payoutId, {}, options)
  const destination = typeof payout.destination === 'string' ? payout.destination : payout.destination?.id
  const external = destination ? await stripe.accounts.retrieveExternalAccount(options.stripeAccount, destination) : null
  const bank = external && external.object === 'bank_account' ? { bankName: external.bank_name ?? null, last4: external.last4 } : null
  const bankByDefault = bank ?? (await (async () => {
    const banks = await stripe.accounts.listExternalAccounts(options.stripeAccount, { object: 'bank_account', limit: 10 })
    const row = banks.data.find(entry => entry.object === 'bank_account' && entry.default_for_currency)
    return row && row.object === 'bank_account' ? { bankName: row.bank_name ?? null, last4: row.last4 } : null
  })())
  return {
    id: payout.id,
    amount: payout.amount,
    currency: payout.currency.toUpperCase(),
    status: payout.status,
    arrivalDate: payout.arrival_date,
    bank: bankByDefault,
    items: await payoutItems(db, stripe, options, principal.organizationId, payout.id),
  }
}

/** Something to read a payout's status in. */
export function payoutStatusLabel(status: string): string {
  return status === 'paid' ? 'Sent' : status === 'failed' ? 'Failed' : status === 'canceled' ? 'Cancelled' : status === 'in_transit' ? 'On its way' : 'Expected'
}

/** The month's transactions as Airbnb's list reads them: the picture, the buyer, and the record each opens. */
export async function paymentTransactions(db: DbClient, principal: FinancialPrincipal, organizationSlug: string, page: { payments: Payment[]; next_cursor: string | null }) {
  const ids = page.payments.map(payment => payment.id)
  const json = JSON.stringify(ids)
  const [pictures, buyers, bookings, orders] = ids.length
    ? await Promise.all([
        paymentPictures(db, principal.organizationId, page.payments),
        queryAll<{ id: string; name: string | null }>(db, `SELECT p.id, COALESCE(json_extract(r.payload_json, '$.guest.name'), u.name) AS name FROM payments p LEFT JOIN user u ON u.id = p.buyer_user_id LEFT JOIN payment_checkout_holds h ON h.payment_id = p.id LEFT JOIN requests r ON r.id = h.request_id WHERE p.id IN (SELECT value FROM json_each(?))`, [json]),
        queryAll<{ payment_id: string; request_id: string | null }>(db, `SELECT p.id AS payment_id, b.request_id FROM payments p JOIN bookings b ON b.id = p.subject_id AND b.organization_id = p.organization_id WHERE p.subject_type = 'booking' AND p.id IN (SELECT value FROM json_each(?)) UNION ALL SELECT p.id, r.request_id FROM payments p JOIN reservations r ON r.id = p.subject_id AND r.organization_id = p.organization_id WHERE p.subject_type = 'reservation' AND p.id IN (SELECT value FROM json_each(?))`, [json,json]),
        queryAll<{ payment_id: string }>(db, `SELECT payment_id FROM payment_orders WHERE payment_id IN (SELECT value FROM json_each(?))`, [json]),
      ])
    : [new Map<string, PaymentPicture>(), [], [], []]
  const base = `/dashboard/${encodeURIComponent(organizationSlug)}/bookings`
  return {
    next_cursor: page.next_cursor,
    payments: page.payments.map((payment) => {
      const picture = pictures.get(payment.id)!
      const request = bookings.find(row => row.payment_id === payment.id)?.request_id
      const to = request ? `${base}/${payment.subject_type}/${encodeURIComponent(request)}` : `${base}/${orders.some(row => row.payment_id === payment.id) ? 'order' : 'payment'}/${encodeURIComponent(payment.id)}`
      return {
        id: payment.id, created_at: payment.created_at, currency: payment.currency, amount: payment.amount, captured_amount: payment.captured_amount, refunded_amount: payment.refunded_amount, state: payment.state,
        title: picture.title, image_url: picture.imageUrl, buyer_name: buyers.find(row => row.id === payment.id)?.name ?? null,
        starts_at: picture.startsAt, ends_at: picture.endsAt, timezone: picture.timeZone, to,
      }
    }),
  }
}
