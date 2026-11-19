import type { EarningsPerformance, PayoutDetail, PayoutItem } from '~/shared/earnings-display'
import type Stripe from 'stripe'
import { HTTPError } from 'nitro'
import { executeBatch, queryAll, queryFirst, type DbClient } from '~/server/db'
import { loadOwnerPictures, ownerPicturesFromRows } from '~/server/notifications/hero'
import { mediaPlacementsQuery } from '~/server/utils/media-asset-manager'
import { getStripeConnectedAccount, paymentsStripe } from '~/server/utils/stripe-connect'
import type { CloudflareEnv } from '~/server/utils/auth'
import { roleAllows } from '~/server/utils/member-access'
import { authorizePayments, type FinancialPrincipal, type Payment, type VisiblePayment } from './index'
import { channelReservationAmountQuery, channelReservationAmounts } from '~/server/domain/stays'

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
const paymentBookingJoin = "LEFT JOIN bookings b ON p.subject_type = 'booking' AND b.id = p.subject_id AND b.organization_id = p.organization_id"

function paymentSnapshot(payment: Pick<Payment, 'id' | 'price_snapshot_json'>) {
  const snapshot: unknown = JSON.parse(payment.price_snapshot_json)
  if (!snapshot || typeof snapshot !== 'object' || !('title' in snapshot) || typeof snapshot.title !== 'string' || !snapshot.title.trim()) throw new Error(`Payment ${payment.id} has no immutable title`)
  return snapshot as { title: string; stay?: unknown }
}

/** The payment's immutable title, its subject's picture and dates, and the buyer when the list presents them: named by what they typed, never an anonymous account's "Anonymous". */
async function paymentPictures(db: DbClient, organizationId: string, payments: readonly Pick<Payment, 'id' | 'location_id' | 'price_snapshot_json'>[], includeBuyer = false): Promise<Map<string, PaymentPicture>> {
  if (!payments.length) return new Map()
  const subjects = await queryAll<PaymentSubject>(db, `
    SELECT p.id, b.id AS booking_id, b.product_id, pr.name, b.starts_at, b.ends_at, b.timezone,
      ${includeBuyer ? `COALESCE(json_extract(r.payload_json, '$.guest.name'), json_extract(bc.payload_json, '$.guest.name'), CASE WHEN COALESCE(u."isAnonymous", 0) = 0 THEN u.name END)` : 'NULL'} AS buyer_name
      FROM payments p
      ${paymentBookingJoin}
      LEFT JOIN products pr ON pr.id = b.product_id AND pr.organization_id = b.organization_id
      ${includeBuyer ? `LEFT JOIN user u ON u.id = p.buyer_user_id
      LEFT JOIN payment_checkout_holds h ON h.payment_id = p.id
      LEFT JOIN conversations r ON r.id = h.conversation_id AND r.organization_id = p.organization_id
      LEFT JOIN conversations bc ON bc.booking_id = b.id AND bc.organization_id = p.organization_id AND bc.kind = 'booking'` : ''}
     WHERE p.organization_id = ? AND p.id IN (SELECT value FROM json_each(?))`,
  [organizationId, JSON.stringify(payments.map(payment => payment.id))])
  const byId = new Map(subjects.map(row => [row.id, row]))
  const entries = payments.map(payment => {
    const snapshot = paymentSnapshot(payment)
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
  const plan = preparePaymentPerformance(principal.organizationId, year, month, await roleAllows({
    ...principal, permissions: { payments: ['payouts'] },
  }))
  return plan.read(await executeBatch(db, plan.queries, { operation: 'Read the earnings period' }), principal.organizationId)
}

export function preparePaymentPerformance(
  organization: string | { sql: string }, year: number, month: string, payoutAccess: boolean | { sql: string },
) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new HTTPError({ statusCode: 400, statusMessage: 'Valid year is required', data: { code: 'INVALID_EARNINGS_PERIOD', field: 'year' } })
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !month.startsWith(`${year}-`)) throw new HTTPError({ statusCode: 400, statusMessage: 'Valid month within the requested year is required', data: { code: 'INVALID_EARNINGS_PERIOD', field: 'month' } })
  const org = typeof organization === 'string' ? '?' : organization.sql
  const orgParams = typeof organization === 'string' ? [organization] : []
  const payoutGuard = typeof payoutAccess === 'boolean' ? payoutAccess ? '1' : '0' : payoutAccess.sql
  const [monthYear, monthNumber] = month.split('-').map(Number)
  const monthStart = `${month}-01`
  const next = new Date(Date.UTC(monthYear!, monthNumber!, 1)).toISOString()
  const monthEnd = next.slice(0, 10)
  const period = `FROM payments p ${paymentBookingJoin}
    WHERE p.organization_id = ${org} AND p.created_at >= ? AND p.created_at < ? AND p.captured_amount > 0`
  const periodParams = [...orgParams, `${monthStart}T00:00:00.000Z`, next]
  const imagesFor = (ownerType: 'product' | 'business_location', selection: string) =>
    mediaPlacementsQuery({ organizationId: organization, ownerType, includeOrganizationFallback: true, owners: { sql: selection, params: periodParams } })
  const queries = [
    { query: `SELECT strftime('%Y-%m', created_at) AS month, currency, SUM(captured_amount) AS paid, SUM(refunded_amount) AS refunded
        FROM payments WHERE organization_id = ${org} AND created_at >= ? AND created_at < ? GROUP BY 1, 2 ORDER BY 1`,
      params: [...orgParams, `${year}-01-01T00:00:00.000Z`, `${year + 1}-01-01T00:00:00.000Z`] },
    { query: `SELECT p.id, p.location_id, p.price_snapshot_json, p.captured_amount, p.refunded_amount,
        b.id AS booking_id, b.product_id ${period}`, params: periodParams },
    { query: `SELECT o.default_currency, CASE WHEN ${payoutGuard} THEN EXISTS (
      SELECT 1 FROM stripe_connected_accounts s WHERE s.organization_id = o.id AND s.stripe_account_id IS NOT NULL
    ) END AS payouts_connected FROM organization o WHERE o.id = ${org}`, params: orgParams },
    channelReservationAmountQuery(organization, monthStart, monthEnd),
    imagesFor('product', `SELECT b.product_id ${period} AND b.product_id IS NOT NULL`),
    imagesFor('business_location', `SELECT p.location_id ${period} AND b.id IS NULL AND json_type(p.price_snapshot_json, '$.stay') IS NOT NULL`),
  ]
  return { queries, read }

  function read([yearResult, monthResult, organizationResult, channel, productMedia, locationMedia]: D1Result[], organizationId: string): EarningsPerformance {
    const rows = yearResult!.results as Array<{ month: string; currency: string; paid: number; refunded: number }>
    const currencies = [...new Set(rows.map(row => row.currency))]
    if (currencies.length > 1) throw new HTTPError({ statusCode: 409, statusMessage: 'Earnings in more than one currency cannot be charted together', data: { code: 'MULTIPLE_EARNINGS_CURRENCIES', field: 'currency' } })
    const months = Array.from({ length: 12 }, (_, index) => {
      const key = `${year}-${String(index + 1).padStart(2, '0')}`
      const row = rows.find(entry => entry.month === key)
      return { month: key, paid: row?.paid ?? 0, refunded: row?.refunded ?? 0 }
    })
    const payments = monthResult!.results as Array<Pick<Payment, 'id' | 'location_id' | 'price_snapshot_json' | 'captured_amount' | 'refunded_amount'>
      & { booking_id: string | null; product_id: string | null }>
    const productIds = payments.flatMap(payment => payment.product_id ? [payment.product_id] : [])
    const locationIds = payments.flatMap(payment => payment.location_id ? [payment.location_id] : [])
    const products = ownerPicturesFromRows(organizationId, 'product', productIds, productMedia!.results)
    const locations = ownerPicturesFromRows(organizationId, 'business_location', locationIds, locationMedia!.results)
    const byTitle = new Map<string, { title: string; image_url: string | null; paid: number; count: number }>()
    for (const payment of payments) {
      const snapshot = paymentSnapshot(payment)
      const picture = payment.product_id ? products.get(payment.product_id)
        : !payment.booking_id && 'stay' in snapshot && payment.location_id ? locations.get(payment.location_id) : null
      const entry = byTitle.get(snapshot.title) ?? { title: snapshot.title, image_url: picture?.imageUrl ?? null, paid: 0, count: 0 }
      entry.paid += payment.captured_amount - payment.refunded_amount
      entry.count += 1
      byTitle.set(snapshot.title, entry)
    }
    const account = organizationResult!.results[0] as { default_currency: string; payouts_connected: number | null } | undefined
    const currency = currencies[0] ?? account?.default_currency
    if (!currency) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
    const channel_reservations = channelReservationAmounts(channel!, monthStart, monthEnd)
    return { currency, payouts_connected: account?.payouts_connected == null ? null : account.payouts_connected === 1, months, items: [...byTitle.values()].sort((a, b) => b.paid - a.paid), channel_reservations }
  }
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
  if (!destination) throw new HTTPError({ statusCode: 502, statusMessage: 'Stripe payout has no destination', data: { code: 'PAYOUT_DESTINATION_MISSING', field: 'payout.destination' } })

  const [external, items] = await Promise.all([
    stripe.accounts.retrieveExternalAccount(options.stripeAccount, destination),
    payoutItems(db, stripe, options, principal.organizationId, payout),
  ])
  const bank = external.object === 'bank_account' ? { bank_name: external.bank_name ?? null, last4: external.last4 } : null
  return {
    id: payout.id,
    amount: payout.amount,
    currency: payout.currency.toUpperCase(),
    status: payout.status,
    arrival_date: payout.arrival_date,
    bank,
    items,
    failure_code: payout.failure_code ?? null,
    failure_message: payout.failure_message ?? null,
  }
}

/** Something to read a payout's status in. */
export function payoutStatusLabel(status: string): string {
  return status === 'paid' ? 'Sent' : status === 'failed' ? 'Failed' : status === 'canceled' ? 'Cancelled' : status === 'in_transit' ? 'On its way' : 'Expected'
}

function paymentTransactionPath(organizationSlug: string, paymentId: string, bookingId: string | null) {
  const base = `/dashboard/${encodeURIComponent(organizationSlug)}/bookings`
  return bookingId ? `${base}/${encodeURIComponent(bookingId)}` : `${base}/payment/${encodeURIComponent(paymentId)}`
}

/** Links from payout and refund detail only need the record the transaction paid. */
export async function paymentTransactionDestination(db: DbClient, organizationId: string, organizationSlug: string, paymentId: string) {
  const row = await queryFirst<{ booking_id: string | null }>(db, `SELECT b.id AS booking_id FROM payments p
    ${paymentBookingJoin} WHERE p.organization_id = ? AND p.id = ?`, [organizationId, paymentId])
  if (!row) throw new HTTPError({ statusCode: 404, statusMessage: 'Payment not found' })
  return { to: paymentTransactionPath(organizationSlug, paymentId, row.booking_id) }
}

/** The month's transactions as Airbnb's list reads them: the picture, the buyer, and the record each opens. */
export async function paymentTransactions(db: DbClient, principal: FinancialPrincipal, organizationSlug: string, page: { payments: VisiblePayment[]; next_cursor: string | null }) {
  const pictures = await paymentPictures(db, principal.organizationId, page.payments, true)
  return {
    next_cursor: page.next_cursor,
    payments: page.payments.map((payment) => {
      const picture = pictures.get(payment.id)!
      return {
        id: payment.id, created_at: payment.created_at, currency: payment.currency, amount: payment.amount, captured_amount: payment.captured_amount, refunded_amount: payment.refunded_amount,
        title: picture.title, image_url: picture.image_url, buyer_name: picture.buyer_name,
        starts_at: picture.starts_at, ends_at: picture.ends_at, timezone: picture.timezone,
        to: paymentTransactionPath(organizationSlug, payment.id, picture.booking_id),
      }
    }),
  }
}
