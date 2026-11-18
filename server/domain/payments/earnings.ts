import type { EarningsPerformance, PayoutDetail, PayoutItem } from '~/shared/earnings-display'
import type Stripe from 'stripe'
import { HTTPError } from 'nitro'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { loadOwnerPictures } from '~/server/notifications/hero'
import { getStripeConnectedAccount, paymentsStripe } from '~/server/utils/stripe-connect'
import type { CloudflareEnv } from '~/server/utils/auth'
import { authorizePayments, type FinancialPrincipal, type Payment, type VisiblePayment } from './index'
import { channelReservationAmounts } from '~/server/domain/stays'

/**
 * The Earnings screens as Airbnb draws them: a payment leads with the picture
 * of what was sold, a month has a total, and a payout lists what it carried.
 * Everything here is read from the payments the business already holds and
 * from Stripe; nothing is stored.
 */

interface PaymentPicture {
  title: string; image_url: string | null; name: string | null; starts_at: string | null; ends_at: string | null; timezone: string | null
  booking_id: string | null; buyer_name: string | null
}

type PaymentSubject = Omit<PaymentPicture, 'title' | 'image_url'> & { id: string; product_id: string | null }

/** The payment's immutable title, its subject's picture and dates, and the buyer when the list presents them: named by what they typed, never an anonymous account's "Anonymous". */
async function paymentPictures(db: DbClient, organizationId: string, payments: readonly Pick<Payment, 'id' | 'location_id' | 'price_snapshot_json'>[], includeBuyer = false): Promise<Map<string, PaymentPicture>> {
  if (!payments.length) return new Map()
  const subjects = await queryAll<PaymentSubject>(db, `
    SELECT p.id, b.id AS booking_id, b.product_id, pr.name, b.starts_at, b.ends_at, b.timezone,
      ${includeBuyer ? `COALESCE(json_extract(r.payload_json, '$.guest.name'), json_extract(bc.payload_json, '$.guest.name'), CASE WHEN COALESCE(u."isAnonymous", 0) = 0 THEN u.name END)` : 'NULL'} AS buyer_name
      FROM payments p
      LEFT JOIN bookings b ON p.subject_type = 'booking' AND b.id = p.subject_id AND b.organization_id = p.organization_id
      LEFT JOIN products pr ON pr.id = b.product_id AND pr.organization_id = b.organization_id
      ${includeBuyer ? `LEFT JOIN user u ON u.id = p.buyer_user_id
      LEFT JOIN payment_checkout_holds h ON h.payment_id = p.id
      LEFT JOIN conversations r ON r.id = h.conversation_id AND r.organization_id = p.organization_id
      LEFT JOIN conversations bc ON bc.booking_id = b.id AND bc.organization_id = p.organization_id AND bc.kind = 'booking'` : ''}
     WHERE p.organization_id = ? AND p.id IN (SELECT value FROM json_each(?))`,
  [organizationId, JSON.stringify(payments.map(payment => payment.id))])
  const byId = new Map(subjects.map(row => [row.id, row]))
  const entries = payments.map(payment => {
    const snapshot: unknown = JSON.parse(payment.price_snapshot_json)
    if (!snapshot || typeof snapshot !== 'object' || !('title' in snapshot) || typeof snapshot.title !== 'string' || !snapshot.title.trim()) throw new Error(`Payment ${payment.id} has no immutable title`)
    const subject = byId.get(payment.id)
    if (!subject) throw new Error(`Payment ${payment.id} is missing from its business`)
    return { id: payment.id, title: snapshot.title, subject, locationId: !subject.booking_id && 'stay' in snapshot ? payment.location_id : null }
  })
  const productIds = entries.flatMap(({ subject }) => subject.product_id ? [subject.product_id] : [])
  const locationIds = entries.flatMap(({ locationId }) => locationId ? [locationId] : [])
  const [products, locations] = await Promise.all([
    loadOwnerPictures(db, organizationId, 'product', productIds),
    loadOwnerPictures(db, organizationId, 'business_location', locationIds),
  ])
  return new Map(entries.map(({ id, title, subject, locationId }) => {
    const { product_id, booking_id, buyer_name, name, starts_at, ends_at, timezone } = subject
    const image = product_id ? products.get(product_id) : locationId ? locations.get(locationId) : null
    return [id, { title, image_url: image?.imageUrl ?? null, booking_id, buyer_name, name, starts_at, ends_at, timezone }]
  }))
}

/** Airbnb's Performance: the year by month, and one month by what was sold. */
export async function paymentPerformance(db: DbClient, principal: FinancialPrincipal, year: number, month: string): Promise<EarningsPerformance> {
  await authorizePayments(principal, 'read')
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new HTTPError({ statusCode: 400, statusMessage: 'Valid year is required', data: { code: 'INVALID_EARNINGS_PERIOD', field: 'year' } })
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !month.startsWith(`${year}-`)) throw new HTTPError({ statusCode: 400, statusMessage: 'Valid month within the requested year is required', data: { code: 'INVALID_EARNINGS_PERIOD', field: 'month' } })
  const rows = await queryAll<{ month: string; currency: string; paid: number; refunded: number }>(db, `SELECT strftime('%Y-%m', created_at) AS month, currency, SUM(captured_amount) AS paid, SUM(refunded_amount) AS refunded FROM payments WHERE organization_id = ? AND created_at >= ? AND created_at < ? GROUP BY 1, 2 ORDER BY 1`, [principal.organizationId, `${year}-01-01T00:00:00.000Z`, `${year + 1}-01-01T00:00:00.000Z`])
  const currencies = [...new Set(rows.map(row => row.currency))]
  if (currencies.length > 1) throw new HTTPError({ statusCode: 409, statusMessage: 'Earnings in more than one currency cannot be charted together', data: { code: 'MULTIPLE_EARNINGS_CURRENCIES', field: 'currency' } })
  const months = Array.from({ length: 12 }, (_, index) => {
    const key = `${year}-${String(index + 1).padStart(2, '0')}`
    const row = rows.find(entry => entry.month === key)
    return { month: key, paid: row?.paid ?? 0, refunded: row?.refunded ?? 0 }
  })
  const [monthYear, monthNumber] = month.split('-').map(Number)
  const next = new Date(Date.UTC(monthYear!, monthNumber!, 1)).toISOString()
  const payments = await queryAll<Payment>(db, `SELECT * FROM payments WHERE organization_id = ? AND created_at >= ? AND created_at < ? AND captured_amount > 0`, [principal.organizationId, `${month}-01T00:00:00.000Z`, next])
  const pictures = await paymentPictures(db, principal.organizationId, payments)
  const byTitle = new Map<string, { title: string; image_url: string | null; paid: number; count: number }>()
  for (const payment of payments) {
    const picture = pictures.get(payment.id)!
    const entry = byTitle.get(picture.title) ?? { title: picture.title, image_url: picture.image_url, paid: 0, count: 0 }
    entry.paid += payment.captured_amount - payment.refunded_amount
    entry.count += 1
    byTitle.set(picture.title, entry)
  }
  const currency = currencies[0] ?? (await queryFirst<{ default_currency: string }>(db, 'SELECT default_currency FROM organization WHERE id = ?', [principal.organizationId]))?.default_currency
  if (!currency) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
  const channel_reservations = await channelReservationAmounts(db, principal.organizationId, `${month}-01`, next.slice(0, 10))
  return { currency, months, items: [...byTitle.values()].sort((a, b) => b.paid - a.paid), channel_reservations }
}

export async function paymentPayouts(db: DbClient, env: CloudflareEnv, principal: FinancialPrincipal, after?: string, withItems = false) {
  await authorizePayments(principal, 'payouts')
  const account = await getStripeConnectedAccount(db, principal.organizationId)
  if (!account?.stripe_account_id) return { organization_id: principal.organizationId, configured: false, balance: null, payouts: [], next_cursor: null, source: 'Stripe account not connected', refreshed_at: null }
  const stripe = paymentsStripe(env, account.livemode), options = { stripeAccount: account.stripe_account_id }
  const [balance, payouts] = await Promise.all([stripe.balance.retrieve({}, options), stripe.payouts.list({ limit: 50, ...(after ? { starting_after: after } : {}) }, options)])
  if (balance.livemode !== account.livemode || payouts.data.some(row => row.livemode !== account.livemode)) throw new Error('Stripe payout mode does not match connected account')
  const nextCursor = payouts.has_more ? payouts.data.at(-1)?.id : null
  if (payouts.has_more && !nextCursor) throw new Error('Stripe payout list is missing its next cursor')
  const paid = withItems ? payouts.data.filter(row => row.status === 'paid').slice(0, 3) : []
  const items = await Promise.all(paid.map(row => payoutItems(db, stripe, options, principal.organizationId, row)))
  return { ...(withItems ? { items: Object.fromEntries(paid.map((row, index) => [row.id, items[index]!])) } : {}),
    organization_id: principal.organizationId, configured: true, balance, payouts: payouts.data, next_cursor: nextCursor, source: 'Stripe', refreshed_at: new Date().toISOString() }
}
async function connectedStripe(db: DbClient, env: CloudflareEnv, organizationId: string) {
  const account = await getStripeConnectedAccount(db, organizationId)
  if (!account?.stripe_account_id) throw new HTTPError({ statusCode: 404, statusMessage: 'Stripe account not connected' })
  return { stripe: paymentsStripe(env, account.livemode), options: { stripeAccount: account.stripe_account_id } }
}

/**
 * The payments a payout carried, matched through Stripe's balance transactions
 * to the charges this business recorded. Stripe attributes transactions only to
 * the payouts it schedules itself; a payout someone created by hand carries none.
 */
async function payoutItems(db: DbClient, stripe: Stripe, options: { stripeAccount: string }, organizationId: string, payout: Stripe.Payout): Promise<PayoutItem[]> {
  if (!payout.automatic) return []
  const transactions = await stripe.balanceTransactions.list({ payout: payout.id, type: 'charge', limit: 100 }, options).autoPagingToArray({ limit: 10000 })
  const chargeIds = transactions.map(row => {
    const id = typeof row.source === 'string' ? row.source : row.source?.id
    if (!id) throw new HTTPError({ statusCode: 502, statusMessage: 'Stripe payout transaction has no charge source', data: { code: 'PAYOUT_TRANSACTION_SOURCE_MISSING', field: `transactions.${row.id}.source` } })
    return id
  })
  if (!chargeIds.length) return []
  const payments = await queryAll<Payment>(db, `SELECT * FROM payments WHERE organization_id = ? AND stripe_charge_id IN (SELECT value FROM json_each(?))`, [organizationId, JSON.stringify(chargeIds)])
  const pictures = await paymentPictures(db, organizationId, payments)
  return payments.map((payment) => {
    const picture = pictures.get(payment.id)!
    const transaction = transactions.find(row => (typeof row.source === 'string' ? row.source : row.source?.id) === payment.stripe_charge_id)
    if (!transaction) throw new HTTPError({ statusCode: 502, statusMessage: 'Payout payment has no Stripe balance transaction', data: { code: 'PAYOUT_TRANSACTION_MISSING', field: `items.${payment.id}.amount` } })
    return { payment_id: payment.id, title: picture.title, image_url: picture.image_url, amount: transaction.net, currency: transaction.currency.toUpperCase(), starts_at: picture.starts_at, ends_at: picture.ends_at, timezone: picture.timezone, name: picture.name }
  })
}

/** One payout as Airbnb's sheet shows it: amount, sent date, the bank it went to, and what it carried. */
export async function paymentPayoutDetail(db: DbClient, env: CloudflareEnv, principal: FinancialPrincipal, payoutId: string): Promise<PayoutDetail> {
  await authorizePayments(principal, 'payouts')
  const { stripe, options } = await connectedStripe(db, env, principal.organizationId)
  const payout = await stripe.payouts.retrieve(payoutId, {}, options)
  const destination = typeof payout.destination === 'string' ? payout.destination : payout.destination?.id
  const external = destination ? await stripe.accounts.retrieveExternalAccount(options.stripeAccount, destination) : null
  const bank = external && external.object === 'bank_account' ? { bank_name: external.bank_name ?? null, last4: external.last4 } : null
  if (!destination) throw new HTTPError({ statusCode: 502, statusMessage: 'Stripe payout has no destination', data: { code: 'PAYOUT_DESTINATION_MISSING', field: 'payout.destination' } })

  return {
    id: payout.id,
    amount: payout.amount,
    currency: payout.currency.toUpperCase(),
    status: payout.status,
    arrival_date: payout.arrival_date,
    bank,
    items: await payoutItems(db, stripe, options, principal.organizationId, payout),
  }
}

/** Something to read a payout's status in. */
export function payoutStatusLabel(status: string): string {
  return status === 'paid' ? 'Sent' : status === 'failed' ? 'Failed' : status === 'canceled' ? 'Cancelled' : status === 'in_transit' ? 'On its way' : 'Expected'
}

/** The month's transactions as Airbnb's list reads them: the picture, the buyer, and the record each opens. */
export async function paymentTransactions(db: DbClient, principal: FinancialPrincipal, organizationSlug: string, page: { payments: VisiblePayment[]; next_cursor: string | null }) {
  const pictures = await paymentPictures(db, principal.organizationId, page.payments, true)
  const base = `/dashboard/${encodeURIComponent(organizationSlug)}/bookings`
  return {
    next_cursor: page.next_cursor,
    payments: page.payments.map((payment) => {
      const picture = pictures.get(payment.id)!
      // A booking opens at /bookings/<id>, a payment with no booking at /bookings/payment/<id>, as the bookings page routes them.
      const to = picture.booking_id ? `${base}/${encodeURIComponent(picture.booking_id)}` : `${base}/payment/${encodeURIComponent(payment.id)}`
      return {
        id: payment.id, created_at: payment.created_at, currency: payment.currency, amount: payment.amount, captured_amount: payment.captured_amount, refunded_amount: payment.refunded_amount,
        title: picture.title, image_url: picture.image_url, buyer_name: picture.buyer_name,
        starts_at: picture.starts_at, ends_at: picture.ends_at, timezone: picture.timezone, to,
      }
    }),
  }
}
