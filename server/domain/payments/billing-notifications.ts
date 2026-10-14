import type Stripe from 'stripe'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { stripeLivemodeFromKey } from '~/server/utils/stripe-connect'
import { ownerPaymentMessage } from '~/server/notifications/payment-events'
import { notifyFinancialNotification } from '~/server/utils/notifications'
import { paymentsUsageStatus } from './usage'
import { recordPaymentsFeeInvoicePaid } from '~/server/domain/booking-analytics'

type InvoiceNotificationKind = 'usage_invoice_paid' | 'usage_invoice_payment_failed' | 'usage_invoice_action_required'

async function notifyInvoice(
  db: DbClient, stripe: Stripe, env: CloudflareEnv, organizationId: string,
  nativeInvoiceId: string, eventKind: InvoiceNotificationKind,
): Promise<void> {
  const status = await paymentsUsageStatus(db, env, organizationId)
  if (!status.configured) throw new Error('Payments invoice notification requires its native billing mapping')
  const organization = await queryFirst<{ name: string; slug: string }>(db, 'SELECT name,slug FROM organization WHERE id=?', [organizationId])
  // Retained servicing data has no merchant members to notify after deletion.
  if (!organization) return
  let matched = false
  for (const invoice of status.invoices) {
    const collection = invoice.collection_invoice
    if (!collection || collection.id !== nativeInvoiceId) continue
    matched = true
    const native = await stripe.invoices.retrieve(collection.id)
    if (native.id !== collection.id || native.metadata?.metronome_id !== invoice.id
      || native.livemode !== stripeLivemodeFromKey(env.STRIPE_SECRET_KEY!)
      || (typeof native.customer === 'string' ? native.customer : native.customer?.id) !== status.account?.stripe_billing_customer_id
      || native.currency.toUpperCase() !== 'USD') throw new Error('Payments invoice notification native identity mismatch')
    const kind = native.status === 'paid' ? 'usage_invoice_paid' : eventKind
    if (!kind || native.status === 'void') continue
    if (kind === 'usage_invoice_paid' && native.amount_remaining !== 0) {
      throw new Error('Payments invoice paid notification requires full native collection')
    }
    if (kind !== 'usage_invoice_paid' && (!['open', 'uncollectible'].includes(native.status ?? '') || native.amount_remaining <= 0)) continue
    const deepLink = `/dashboard/${encodeURIComponent(organization.slug)}/payments?tab=plan`
    await notifyFinancialNotification(env, db, {
      organizationId,
      eventKey: `payments.invoice:${Number(native.livemode)}:${native.id}:${kind}`,
      deepLink,
      ownerMessage: ownerPaymentMessage({
        kind, organizationName: organization.name, currency: 'USD',
        amount: kind === 'usage_invoice_paid' ? native.amount_paid : native.amount_remaining,
        action: { label: 'View invoice', url: native.hosted_invoice_url ?? new URL(deepLink, env.NUXT_PUBLIC_PLATFORM_DOMAIN).href },
      }),
    })
  }
  if (!matched) throw new Error('Stripe invoice is absent from its native Metronome contract')
}

/** Better Auth Stripe keeps subscription lifecycle; this hook adds status mail. */
export async function notifyPaymentsInvoiceEvent(db: DbClient, stripe: Stripe, env: CloudflareEnv, event: Stripe.Event): Promise<void> {
  const kinds: Record<string, InvoiceNotificationKind> = {
    'invoice.paid': 'usage_invoice_paid',
    'invoice.payment_succeeded': 'usage_invoice_paid',
    'invoice.payment_failed': 'usage_invoice_payment_failed',
    'invoice.payment_action_required': 'usage_invoice_action_required',
  }
  const kind = kinds[event.type]
  if (!kind || event.account) return
  const object = event.data.object as Stripe.Invoice
  if (!object.metadata?.metronome_id) return
  if (event.livemode !== stripeLivemodeFromKey(env.STRIPE_SECRET_KEY!)) throw new Error('Payments collection event mode mismatch')
  const customerId = typeof object.customer === 'string' ? object.customer : object.customer?.id
  if (!customerId) throw new Error('Payments collection event requires its operating Stripe customer')
  const mappings = await queryAll<{ organization_id: string }>(db,
    'SELECT organization_id FROM payment_billing_accounts WHERE stripe_billing_customer_id=?', [customerId])
  if (mappings.length > 1) throw new Error('Payments operating customer has ambiguous tenant attribution')
  if (!mappings[0]) return
  await notifyInvoice(db, stripe, env, mappings[0].organization_id, object.id, kind)
  if (kind === 'usage_invoice_paid') await recordPaymentsFeeInvoicePaid(db, { organizationId: mappings[0].organization_id, invoiceId: object.id, amountPaid: object.amount_paid, currency: object.currency.toUpperCase() })
}

