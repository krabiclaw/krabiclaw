import type Stripe from 'stripe'
import { executeBatch, queryFirst, type DbClient } from '~/server/db'
import { publishEvent } from '~/server/events'
import type { CloudflareEnv } from '~/server/utils/auth'
import { paymentsStripe, platformLivemode } from '~/server/utils/stripe-connect'
import { isStayInstallments, type StayInstallment } from '~/shared/stay-installments'
import { localDateTimeToInstant } from '~/utils/timezone'
import { quotePaymentsBillingFx, paymentsBillingBasis } from './fx'
import type { Payment } from './index'
import { paymentUsageEventQuery } from './usage'

/**
 * A long stay's later months (#1907). Stripe collects them: each is a draft
 * invoice on the business's connected account that Stripe finalizes and
 * charges to the card saved at checkout on its due date. Blawby runs no
 * charge job; it records each invoice Stripe reports paid as the stay's
 * payment, and removes the unpaid ones when the stay is cancelled.
 */

const BOOKING_KEY = 'blawby_booking_id'

type Plan = { installments: StayInstallment[]; title: string; timezone: string; tax_code: string | null; tax_behavior: string; automatic_tax: boolean }

function checkoutPlan(payment: Payment): Plan | null {
  const snapshot = JSON.parse(payment.price_snapshot_json) as Record<string, unknown>
  if (!isStayInstallments(snapshot.installments) || !snapshot.installments) return null
  const stay = snapshot.stay as { timezone?: unknown } | undefined
  const price = snapshot.price as { tax_behavior?: unknown } | undefined
  if (typeof stay?.timezone !== 'string' || typeof snapshot.title !== 'string' || typeof price?.tax_behavior !== 'string' || typeof snapshot.automatic_tax !== 'boolean') {
    throw new Error(`Monthly stay payment ${payment.id} has no frozen stay terms`)
  }
  return { installments: snapshot.installments, title: snapshot.title, timezone: stay.timezone, tax_code: typeof snapshot.tax_code === 'string' ? snapshot.tax_code : null, tax_behavior: price.tax_behavior, automatic_tax: snapshot.automatic_tax }
}

async function buyerCustomer(db: DbClient, payment: Payment): Promise<string> {
  const row = await queryFirst<{ stripe_customer_id: string }>(db, 'SELECT stripe_customer_id FROM stripe_connected_customers WHERE user_id = ? AND stripe_account_id = ? AND livemode = ?',
    [payment.buyer_user_id, payment.stripe_account_id, payment.livemode])
  if (!row) throw new Error(`Monthly stay payment ${payment.id} has no guest Customer at the business`)
  return row.stripe_customer_id
}

/** After the first month settles: one draft invoice per later month, on the guest's saved card. Idempotent per month. */
export async function scheduleStayInstallments(env: CloudflareEnv, payment: Payment, bookingId: string): Promise<void> {
  const plan = checkoutPlan(payment)
  if (!plan) return
  // A stay cancelled before its months were scheduled gets none.
  const booking = await queryFirst<{ status: string }>(env.DB, 'SELECT status FROM bookings WHERE organization_id = ? AND id = ?', [payment.organization_id, bookingId])
  if (!booking) throw new Error(`Monthly stay ${bookingId} was not found`)
  if (booking.status === 'cancelled') return
  const stripe = paymentsStripe(env, Boolean(payment.livemode))
  const account = { stripeAccount: payment.stripe_account_id }
  const customer = await buyerCustomer(env.DB, payment)
  if (!payment.stripe_payment_intent_id) throw new Error(`Monthly stay payment ${payment.id} has no PaymentIntent`)
  const intent = await stripe.paymentIntents.retrieve(payment.stripe_payment_intent_id, {}, account)
  const card = typeof intent.payment_method === 'string' ? intent.payment_method : intent.payment_method?.id
  if (!card) throw new Error(`Monthly stay payment ${payment.id} saved no card`)
  for (const period of plan.installments.slice(1)) {
    const metadata = { [BOOKING_KEY]: bookingId, blawby_payment_id: payment.id, blawby_period_start: period.period_start, blawby_period_end: period.period_end }
    const description = `${plan.title}, ${period.period_start} to ${period.period_end}`
    const invoice = await stripe.invoices.create({
      customer, currency: payment.currency.toLowerCase(), collection_method: 'charge_automatically', auto_advance: true,
      // Due on the period's first day, in the home's own clock.
      automatically_finalizes_at: Math.floor(localDateTimeToInstant(period.period_start, '09:00', plan.timezone, 'compatible').getTime() / 1000),
      default_payment_method: card, pending_invoice_items_behavior: 'exclude', automatic_tax: { enabled: plan.automatic_tax },
      description, metadata,
    }, { ...account, idempotencyKey: `stay-installment:${bookingId}:${period.period_start}` })
    await stripe.invoiceItems.create({
      customer, invoice: invoice.id, amount: period.amount_minor, currency: payment.currency.toLowerCase(), description, metadata,
      ...(plan.tax_behavior === 'unspecified' ? {} : { tax_behavior: plan.tax_behavior as 'inclusive' | 'exclusive' }),
      ...(plan.tax_code ? { tax_code: plan.tax_code } : {}),
    }, { ...account, idempotencyKey: `stay-installment-item:${bookingId}:${period.period_start}` })
  }
  // A cancellation that committed while these were created removed only what existed then.
  const after = await queryFirst<{ status: string }>(env.DB, 'SELECT status FROM bookings WHERE organization_id = ? AND id = ?', [payment.organization_id, bookingId])
  if (after?.status === 'cancelled') await cancelStayInstallments(env, payment, bookingId)
}

/** A month Stripe collected: the stay's payment for that period, counted once as captured volume, as a checkout capture is. */
export async function recordInstallmentPayment(db: DbClient, stripe: Stripe, env: CloudflareEnv, organizationId: string, invoiceId: string, stripeAccount: string): Promise<void> {
  const invoice = await stripe.invoices.retrieve(invoiceId, { expand: ['payments'] }, { stripeAccount })
  const bookingId = invoice.metadata?.[BOOKING_KEY]
  if (!bookingId) return
  const first = await queryFirst<Payment>(db, "SELECT * FROM payments WHERE id = ? AND organization_id = ? AND subject_type = 'booking' AND subject_id = ?", [invoice.metadata?.blawby_payment_id, organizationId, bookingId])
  if (!first || first.stripe_account_id !== stripeAccount || Boolean(first.livemode) !== invoice.livemode) throw new Error(`Invoice ${invoice.id} names no payment of its stay`)
  const paid = invoice.payments?.data.find(entry => entry.status === 'paid')
  const intentId = typeof paid?.payment.payment_intent === 'string' ? paid.payment.payment_intent : paid?.payment.payment_intent?.id
  if (!intentId) throw new Error(`Paid invoice ${invoice.id} has no PaymentIntent`)
  // Stripe expands at most four levels, so the charge is read with its PaymentIntent.
  const intent = await stripe.paymentIntents.retrieve(intentId, { expand: ['latest_charge'] }, { stripeAccount })
  const charge = intent.latest_charge
  if (!charge || typeof charge === 'string' || charge.amount !== invoice.amount_paid) throw new Error(`Paid invoice ${invoice.id} has no matching charge`)
  const now = new Date().toISOString()
  const paidAt = new Date((invoice.status_transitions.paid_at ?? charge.created) * 1000).toISOString()
  const billingFx = await quotePaymentsBillingFx(stripe, first.currency as Parameters<typeof quotePaymentsBillingFx>[1])
  const id = crypto.randomUUID()
  const tax = (invoice.total_taxes ?? []).reduce((sum, entry) => sum + entry.amount, 0)
  const snapshot = { title: invoice.description, invoice_id: invoice.id, checkout_payment_id: first.id, billing_fx: billingFx,
    installment: { period_start: invoice.metadata?.blawby_period_start, period_end: invoice.metadata?.blawby_period_end } }
  const insert = { query: `INSERT INTO payments (id, organization_id, buyer_user_id, stripe_account_id, livemode, subject_type, subject_id, location_id, currency, amount, price_snapshot_json,
      tax_amount, captured_amount, stripe_payment_intent_id, stripe_charge_id, receipt_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'booking', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (stripe_account_id, livemode, stripe_payment_intent_id) DO NOTHING`,
    params: [id, organizationId, first.buyer_user_id, stripeAccount, first.livemode, bookingId, first.location_id, first.currency, invoice.amount_paid, JSON.stringify(snapshot),
      tax, invoice.amount_paid, intent.id, charge.id, charge.receipt_url, paidAt, now] }
  // Usage is billed in the platform's mode only, and only with the payment it counts.
  const usage = Boolean(first.livemode) === platformLivemode(env) ? [paymentUsageEventQuery({
    organizationId, paymentId: id, kind: 'captured_volume', currency: first.currency, amount: invoice.amount_paid,
    billingBasis: paymentsBillingBasis(invoice.amount_paid, first.currency, billingFx), sourceId: `capture:${stripeAccount}:${first.livemode}:${intent.id}`,
    occurredAt: paidAt, createdAt: now,
  }, { query: 'SELECT 1 WHERE changes()=1', params: [] })] : []
  const [inserted] = await executeBatch(db, [insert, ...usage], { operation: 'Record monthly stay payment' })
  // A redelivered event whose earlier attempt saved the row but failed to publish publishes it now.
  const recorded = (inserted?.meta.changes ?? 0) === 1 ? id
    : (await queryFirst<{ id: string }>(db, 'SELECT id FROM payments WHERE stripe_account_id = ? AND livemode = ? AND stripe_payment_intent_id = ?', [stripeAccount, first.livemode, intent.id]))?.id
  if (!recorded) throw new Error(`Monthly payment for invoice ${invoice.id} was not recorded`)
  await publishEvent(env, {
    type: 'payment.captured', organization_id: organizationId, payment_id: recorded, intent_created: intent.created, saved_method_id: null, booking: null,
    notice: { kind: 'payment_captured', nativeId: intent.id, status: intent.status, amount: invoice.amount_paid, email: charge.billing_details.email ?? null },
  })
}

/** A cancelled stay's months Stripe has not collected: drafts are deleted, finalized ones voided. */
export async function cancelStayInstallments(env: CloudflareEnv, payment: Payment, bookingId: string): Promise<void> {
  if (!checkoutPlan(payment)) return
  const stripe = paymentsStripe(env, Boolean(payment.livemode))
  const account = { stripeAccount: payment.stripe_account_id }
  const customer = await buyerCustomer(env.DB, payment)
  for (const status of ['draft', 'open'] as const) {
    for await (const invoice of stripe.invoices.list({ customer, status, limit: 100 }, account)) {
      if (invoice.metadata?.[BOOKING_KEY] !== bookingId) continue
      if (status === 'draft') await stripe.invoices.del(invoice.id, account)
      else await stripe.invoices.voidInvoice(invoice.id, {}, account)
    }
  }
}
