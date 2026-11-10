import type Stripe from 'stripe'
import { execute, queryAll, queryFirst, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import {
  invoiceLineIsProration,
  invoiceLineIsSubscription,
  invoiceLinePrice,
  invoiceLineQuantity,
  invoiceLineSubscriptionId,
  loadStripeInvoiceLines,
  type StripeInvoiceLine,
} from '~/server/utils/stripe-invoice-lines'
import {
  consumeStripeGa4Intent,
  findConsumedStripeGa4CancellationIntent,
  findPendingInitialStripeGa4Intent,
  findStripeGa4CheckoutAttribution,
  findPendingStripeGa4Intent,
  markStripeGa4IntentLifecycleSent,
  attachStripeGa4IntentToSubscription,
  type StripeGa4Intent,
} from '~/server/utils/stripe-ga4-intents'
import { deliverViaMeasurementProtocol, readGa4Delivery, sendMeasurementProtocol } from '~/server/utils/ga4-delivery'
import { originatingOwnerId, recordOrganizationConversionEvent } from '~/server/utils/organization-conversions'
import { getPlatformOrganization } from '~/server/utils/platform-organization'
import { projectConversionToGa4 } from '~/utils/ga4-projection'
import type { ConversionItem, ConversionValue } from '~/utils/organization-conversion-events'
import type { StripeGa4PurchaseType } from '~/shared/stripe-ga4'

type StripeInvoiceWithSubscription = Stripe.Invoice & {
  subscription?: string | { id: string } | null
}

function stripeMetadataValue(metadata: Stripe.Metadata | null | undefined, ...keys: string[]): string | null {
  if (!metadata) return null
  for (const key of keys) {
    const value = metadata[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function stripeMetadataNumber(metadata: Stripe.Metadata | null | undefined, ...keys: string[]): number | null {
  const value = stripeMetadataValue(metadata, ...keys)
  if (!value) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function gaSessionNumber(value: string | null): number | null {
  const parsed = Number(value)
  return value !== null && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function customerIdValue(customer: Stripe.Subscription['customer'] | Stripe.Invoice['customer']): string | null {
  if (!customer) return null
  return typeof customer === 'string' ? customer : customer.id
}

function billingIntervalLabel(price: Stripe.Price | null): string | null {
  const recurring = price?.recurring
  if (!recurring?.interval) return null
  const labels: Record<string, string> = {
    day: 'daily',
    week: 'weekly',
    month: 'monthly',
    year: 'annual',
  }
  const label = labels[recurring.interval] ?? recurring.interval
  const count = recurring.interval_count ?? 1
  return count === 1 ? label : `${count}_${label}`
}

const sumMinor = (rows: ReadonlyArray<{ amount: number }> | null | undefined) => (rows ?? []).reduce((total, row) => total + row.amount, 0)

/**
 * One invoice line as an item: its exact total (an integer), net of the discounts and pretax credits
 * allocated to it and of any tax its price includes. Unit price is derived later from the total, so
 * fractional per-seat allocations neither throw nor round into a different total.
 */
function itemFromInvoiceLine(line: StripeInvoiceLine): ConversionItem | null {
  const price = invoiceLinePrice(line)
  const priceObject = typeof price === 'string' || !price ? null : price
  const product = priceObject?.product
  const productName = product && typeof product !== 'string' && !product.deleted ? product.name : null
  const itemId = priceObject?.id ?? line.id
  const includedTax = sumMinor((line.taxes ?? []).filter(tax => tax.tax_behavior === 'inclusive'))
  const amountMinor = line.amount - sumMinor(line.discount_amounts) - sumMinor(line.pretax_credit_amounts) - includedTax
  if (!itemId || !Number.isSafeInteger(amountMinor) || amountMinor < 0) return null

  const recurring = priceObject?.recurring
  const interval = billingIntervalLabel(priceObject)
  const metered = recurring?.usage_type === 'metered'
  return {
    item_id: itemId,
    item_name: productName || priceObject?.nickname || line.description || 'Subscription',
    item_category: 'Subscription',
    ...(interval ? { item_category2: interval } : metered ? { item_category2: 'Metered' } : {}),
    ...(metered ? { item_category3: 'Metered' } : {}),
    quantity: invoiceLineQuantity(line),
    amount_minor: amountMinor,
  }
}

function positiveSubscriptionLines(lines: StripeInvoiceLine[], subscriptionId: string): StripeInvoiceLine[] {
  return lines.filter((line) => {
    if (invoiceLineSubscriptionId(line) !== subscriptionId) return false
    if (!invoiceLineIsSubscription(line)) return false
    return typeof line.amount === 'number' && line.amount > 0
  })
}

/**
 * The purchase's value is the invoice total excluding tax (Stripe applies discounts to it and
 * reports tax and shipping separately), which is what GA4 ecommerce `value` means. What was
 * actually collected, tax included, is kept beside it and reported separately. Items are kept only
 * when their totals reconcile with that value exactly; an invoice with credits, one-off charges or
 * unallocated components sends its value without items rather than with a balancing item.
 */
export function buildStripePurchaseValue(invoice: StripeInvoiceWithSubscription, items: ConversionItem[]): ConversionValue {
  if (!Number.isSafeInteger(invoice.amount_paid) || invoice.amount_paid <= 0) throw new Error(`Stripe invoice ${invoice.id} has no positive paid amount`)
  if (typeof invoice.total_excluding_tax !== 'number') throw new Error(`Stripe invoice ${invoice.id} has no total excluding tax`)
  const reconciled = items.length > 0 && items.reduce((total, item) => total + item.amount_minor, 0) === invoice.total_excluding_tax
  return {
    basis: 'purchase', amount_minor: invoice.total_excluding_tax, collected_minor: invoice.amount_paid,
    currency: invoice.currency.toUpperCase(), transaction_id: invoice.id, ...(reconciled ? { items } : {}),
  }
}

/**
 * A refund keeps the purchase's accounting basis: `amount_minor` is the refunded share of the
 * tax-exclusive value (pro rata by cash; exact for a full refund) and `collected_minor` is the
 * cash actually returned, tax included. Stripe does not itemize a refund, so items are sent only
 * when the whole payment is refunded, and they are the purchase's own recorded (reconciled) items;
 * a partial refund names no items rather than substituting the original purchase.
 */
export function buildStripeRefundValue(input: { invoice: StripeInvoiceWithSubscription; refundAmount: number; currency: string; purchaseItems: ConversionItem[] | null }): ConversionValue {
  const { invoice, refundAmount } = input
  if (typeof invoice.total_excluding_tax !== 'number' || invoice.amount_paid <= 0) throw new Error(`Stripe invoice ${invoice.id} cannot be refunded against: missing tax-exclusive total or paid amount`)
  if (!Number.isSafeInteger(refundAmount) || refundAmount <= 0 || refundAmount > invoice.amount_paid) throw new Error(`Refund of ${refundAmount} is outside invoice ${invoice.id}'s paid amount ${invoice.amount_paid}`)
  const full = refundAmount === invoice.amount_paid
  return {
    basis: 'refund', currency: input.currency.toUpperCase(), transaction_id: invoice.id, collected_minor: refundAmount,
    amount_minor: full ? invoice.total_excluding_tax : Math.round(refundAmount * invoice.total_excluding_tax / invoice.amount_paid),
    ...(full && input.purchaseItems ? { items: input.purchaseItems } : {}),
  }
}

/**
 * The first positive payment a customer ever makes is their first paid
 * conversion, whatever Stripe's billing reason says: after a zero-value trial
 * the first charge arrives as a cycle. Payment history is read from Stripe's
 * paid invoices, not from a shadow lifecycle.
 */
async function hasEarlierPositivePayment(stripe: Stripe, invoice: StripeInvoiceWithSubscription): Promise<boolean> {
  const customerId = customerIdValue(invoice.customer)
  if (!customerId) throw new Error(`Stripe invoice ${invoice.id} has no customer`)
  const paidAt = (paid: Stripe.Invoice) => {
    const at = paid.status_transitions?.paid_at
    if (typeof at !== 'number') throw new Error(`Stripe invoice ${paid.id} is paid but has no paid_at`)
    return at
  }
  // "Earlier" is payment order, not creation order: an invoice created first but paid later is
  // not earlier. Equal payment times are ordered by invoice id so exactly one of them is first.
  const current = paidAt(invoice)
  for await (const prior of stripe.invoices.list({ customer: customerId, status: 'paid', limit: 100 })) {
    if (prior.id === invoice.id || prior.amount_paid <= 0) continue
    const priorPaidAt = paidAt(prior)
    if (priorPaidAt < current || (priorPaidAt === current && prior.id < invoice.id)) return true
  }
  return false
}

export async function classifyStripeInvoicePurchase(
  stripe: Stripe,
  invoice: StripeInvoiceWithSubscription,
  intentAction?: StripeGa4Intent['action'] | null,
  metadataAction?: string | null,
): Promise<StripeGa4PurchaseType | null> {
  if (!await hasEarlierPositivePayment(stripe, invoice)) return 'initial_subscription'
  // A new subscription by a customer who has paid before (cancelled, then came back) is revenue,
  // classified apart from first-time acquisition rather than dropped.
  if (invoice.billing_reason === 'subscription_create') return 'resubscription'
  if (invoice.billing_reason === 'subscription_cycle' || invoice.billing_reason === 'subscription_threshold') return 'subscription_renewal'
  // Invoices outside the subscription lifecycle (manual, upcoming) are not a supported payment path.
  if (invoice.billing_reason !== 'subscription_update') return null
  if (intentAction === 'upgrade' || intentAction === 'downgrade') return intentAction
  if (metadataAction === 'upgrade' || metadataAction === 'downgrade') return metadataAction
  return 'plan_change'
}

interface StripeGa4Context {
  organizationId: string | null
  userId: string | null
  clientId: string | null
  intent: StripeGa4Intent | null
  sessionId: string | null
  sessionCapturedAt: number | null
  customerId: string | null
}

async function customerMetadata(
  stripe: Stripe,
  customerId: string | null,
): Promise<Stripe.Metadata | null> {
  if (!customerId) return null
  const customer = await stripe.customers.retrieve(customerId)
  return customer.deleted ? null : customer.metadata
}

async function resolveStripeGa4Context(
  db: DbClient,
  stripe: Stripe,
  subscription: Stripe.Subscription,
  purchaseType?: StripeGa4PurchaseType | null,
): Promise<StripeGa4Context> {
  const metadata = subscription.metadata
  const customerId = customerIdValue(subscription.customer)
  const customerMeta = await customerMetadata(stripe, customerId)
  const organizationId = customerMeta?.customerType === 'organization'
    ? customerMeta.organizationId ?? null
    : null
  if (subscription.status !== 'canceled' && organizationId && metadata.referenceId !== organizationId) {
    throw new Error('Subscription metadata does not match its canonical customer owner')
  }

  let intent = await findPendingStripeGa4Intent(db, subscription.id)
  if (!intent && organizationId && (purchaseType === 'initial_subscription' || purchaseType === 'resubscription')) {
    intent = await findPendingInitialStripeGa4Intent(db, organizationId)
    if (intent) await attachStripeGa4IntentToSubscription(db, intent.id, subscription.id)
  }
  const userId = stripeMetadataValue(metadata, 'user_id', 'userId', 'pending_user_id')
    ?? stripeMetadataValue(customerMeta, 'user_id', 'userId')
    ?? intent?.userId
    ?? null
  const clientId = stripeMetadataValue(metadata, 'ga_client_id', 'pending_ga_client_id')
    ?? stripeMetadataValue(customerMeta, 'ga_client_id')
    ?? intent?.clientId
    ?? null
  const interactiveAction = purchaseType === 'initial_subscription'
    || purchaseType === 'resubscription'
    || purchaseType === 'upgrade'
    || purchaseType === 'downgrade'
  const sessionId = interactiveAction
    ? intent?.sessionId
      ?? stripeMetadataValue(metadata, 'ga_session_id', 'pending_ga_session_id', 'initial_ga_session_id')
      ?? null
    : null
  const sessionCapturedAt = interactiveAction
    ? intent?.sessionCapturedAt
      ?? stripeMetadataNumber(metadata, 'ga_session_captured_at', 'pending_ga_session_captured_at', 'initial_ga_session_captured_at')
      ?? null
    : null

  return { organizationId, userId, clientId, intent, sessionId, sessionCapturedAt, customerId }
}

// KrabiClaw is the seller of every subscription this handler sees, so the
// measuring organization is the platform organization; the organization that
// subscribed is the subject, kept in the event's metadata. Invoice ids are
// unique within the seller's Stripe account, which is that same namespace.
async function recordStripePurchase(
  env: CloudflareEnv,
  db: DbClient,
  stripe: Stripe,
  invoice: StripeInvoiceWithSubscription,
  event: Stripe.Event,
): Promise<void> {
  const subscriptionId = invoiceSubscriptionId(invoice)
  if (!subscriptionId || invoice.amount_paid <= 0) return
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['items.data.price.product'],
  })
  const metadataAction = stripeMetadataValue(subscription.metadata, 'analytics_action', 'pending_change_type')
  let purchaseType = await classifyStripeInvoicePurchase(stripe, invoice, null, metadataAction)
  if (!purchaseType) return
  const context = await resolveStripeGa4Context(db, stripe, subscription, purchaseType)
  if (purchaseType === 'plan_change' && (context.intent?.action === 'upgrade' || context.intent?.action === 'downgrade')) {
    purchaseType = context.intent.action
  }

  const lines = await loadStripeInvoiceLines(stripe, invoice)
  let candidateLines = positiveSubscriptionLines(lines, subscriptionId)
  if (purchaseType === 'initial_subscription' || purchaseType === 'subscription_renewal') {
    candidateLines = candidateLines.filter(line => !invoiceLineIsProration(line))
  }
  const value = buildStripePurchaseValue(invoice, candidateLines.flatMap(line => itemFromInvoiceLine(line) ?? []))

  const platformOrganizationId = (await getPlatformOrganization(db)).id
  const recorded = await recordOrganizationConversionEvent(db, null, {
    organizationId: platformOrganizationId, eventName: 'purchase', stage: 'completed', surface: 'stripe',
    entityType: 'invoice', entityId: invoice.id, value,
    occurredAt: invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000).toISOString() : undefined,
    // The checkout that started this subscription observed the visitor's attribution, found through
    // that subscription whatever the state of its intent by the time the payment arrives. A renewal
    // has none of its own and is attributed through the signup cohort instead.
    attribution: await findStripeGa4CheckoutAttribution(db, subscriptionId, purchaseType),
    metadata: {
      purchase_type: purchaseType, subscription_id: subscriptionId,
      ...(context.organizationId ? { subscribing_organization_id: context.organizationId, originating_user_id: await originatingOwnerId(db, platformOrganizationId, context.organizationId) } : {}),
      ...(context.userId ? { user_id: context.userId } : {}),
    },
  })
  const projection = projectConversionToGa4({ eventName: 'purchase', value, params: { purchase_type: purchaseType, subscription_id: subscriptionId } })
  // Stripe delivers an event at least once. A redelivered invoice is the recorded purchase; only a
  // send Google refused goes again. Everything else (disabled, disconnected, no consent) is a recorded outcome.
  const previous = recorded.created ? null : await readGa4Delivery(db, recorded.id)
  const delivery = previous && previous.status !== 'failed' ? previous : await deliverViaMeasurementProtocol(env, db, {
    eventId: recorded.id, organizationId: platformOrganizationId, event: projection,
    clientId: context.clientId, userId: context.userId, sessionId: gaSessionNumber(context.sessionId), sessionCapturedAt: context.sessionCapturedAt,
  })
  if (delivery.status === 'failed') throw new Error(`GA4 purchase delivery failed for invoice ${invoice.id}: ${delivery.detail}`)

  if (context.intent && (purchaseType === 'upgrade' || purchaseType === 'downgrade' || purchaseType === 'initial_subscription' || purchaseType === 'resubscription')) {
    await consumeStripeGa4Intent(db, context.intent.id, event.id)
  }
  await clearInteractiveStripeMetadata(stripe, subscription)
}

const GA_IDENTIFIER_KEYS = [
  'ga_client_id', 'ga_session_id', 'ga_session_captured_at',
  'initial_ga_session_id', 'initial_ga_session_captured_at',
  'pending_ga_client_id', 'pending_ga_session_id', 'pending_ga_session_captured_at',
]

/**
 * A visitor who withdraws analytics consent no longer has any GA identifier stored for their
 * billing: the intents and the Stripe customer/subscription metadata that later payments and
 * refunds would read it from. Native recording of those payments is unaffected. The identifiers
 * are found through the organizations this user owns and only cleared where this user is the one
 * who captured them.
 */
export async function withdrawStripeGaIdentifiers(db: DbClient, getStripeClient: () => Stripe, userId: string): Promise<void> {
  await execute(db, `UPDATE stripe_ga4_subscription_intents SET client_id = NULL, session_id = NULL, session_captured_at = NULL, updated_at = ? WHERE user_id = ?`, [new Date().toISOString(), userId])
  const customers = await queryAll<{ customerId: string }>(db, `SELECT DISTINCT o."stripeCustomerId" AS customerId FROM member m JOIN organization o ON o.id = m."organizationId"
    WHERE m."userId" = ? AND m.role = 'owner' AND o."stripeCustomerId" IS NOT NULL`, [userId])
  if (customers.length === 0) return
  const stripe = getStripeClient()
  const blank = (metadata: Stripe.Metadata) => Object.fromEntries(GA_IDENTIFIER_KEYS.filter(key => metadata[key] !== undefined).map(key => [key, '']))
  for (const { customerId } of customers) {
    const customer = await stripe.customers.retrieve(customerId)
    if (!customer.deleted && customer.metadata.user_id === userId && Object.keys(blank(customer.metadata)).length > 0) {
      await stripe.customers.update(customerId, { metadata: blank(customer.metadata) })
    }
    for await (const subscription of stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })) {
      const captured = subscription.metadata.user_id === userId || subscription.metadata.pending_user_id === userId
      if (captured && Object.keys(blank(subscription.metadata)).length > 0) {
        await stripe.subscriptions.update(subscription.id, { metadata: blank(subscription.metadata) })
      }
    }
  }
}

async function clearInteractiveStripeMetadata(
  stripe: Stripe,
  subscription: Stripe.Subscription,
): Promise<void> {
  const keys = [
    'analytics_action',
    'ga_session_id',
    'ga_session_captured_at',
    'initial_ga_session_id',
    'initial_ga_session_captured_at',
    'pending_change_type',
    'pending_ga_client_id',
    'pending_ga_session_id',
    'pending_ga_session_captured_at',
    'pending_user_id',
    'previous_price_id',
    'new_price_id',
  ]
  const metadata = { ...subscription.metadata }
  const hasEphemeralMetadata = keys.some(key => metadata[key] !== undefined)
  if (!hasEphemeralMetadata) return
  for (const key of keys) metadata[key] = ''
  // Leaving the ephemeral keys on the subscription is the failure this was
  // reporting to nobody; the caller decides what to do about it.
  await stripe.subscriptions.update(subscription.id, { metadata })
}

async function sendStripeGa4Lifecycle(
  env: CloudflareEnv,
  db: DbClient,
  stripe: Stripe,
  subscription: Stripe.Subscription,
  eventName: string,
  event: Stripe.Event,
  intent: StripeGa4Intent | null,
): Promise<void> {
  if (intent?.lifecycleSentAt) return
  const context = await resolveStripeGa4Context(db, stripe, subscription, null)
  const params: Record<string, unknown> = {
    subscription_id: subscription.id,
    ...(context.organizationId ? { organization_id: context.organizationId } : {}),
  }
  if (intent?.previousPriceId) params.previous_price_id = intent.previousPriceId
  if (intent?.newPriceId) params.new_price_id = intent.newPriceId
  if (intent?.action === 'downgrade') params.effective_timing = intent.effectiveTiming

  // A lifecycle event is GA-only (it is not a business outcome in the native
  // catalog), so a send that could not happen for lack of consent evidence or
  // configuration has no event row to note it on; only a provider failure is an
  // error, and it makes Stripe redeliver.
  const sent = await sendMeasurementProtocol(env, db, {
    organizationId: (await getPlatformOrganization(db)).id,
    clientId: context.clientId, userId: context.userId,
    sessionId: gaSessionNumber(intent?.sessionId ?? null),
    sessionCapturedAt: intent?.sessionCapturedAt ?? null,
    event: { name: eventName, params },
  })
  if (sent.status === 'failed') throw new Error(`GA4 ${eventName} delivery failed for subscription ${subscription.id}: ${sent.detail}`)
  if (intent) {
    await markStripeGa4IntentLifecycleSent(db, intent.id)
    await consumeStripeGa4Intent(db, intent.id, event.id)
  }
}

async function attachCheckoutIntent(
  db: DbClient,
  session: Stripe.Checkout.Session,
): Promise<void> {
  const subscriptionId = typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription?.id ?? null
  if (!subscriptionId) return
  const organizationId = stripeMetadataValue(session.metadata, 'referenceId')
  const userId = stripeMetadataValue(session.metadata, 'user_id', 'userId')
  if (!organizationId) return
  const intent = await findPendingInitialStripeGa4Intent(db, organizationId, userId)
  if (intent) await attachStripeGa4IntentToSubscription(db, intent.id, subscriptionId)
}

async function recordStripeRefund(
  env: CloudflareEnv,
  db: DbClient,
  stripe: Stripe,
  refund: Stripe.Refund,
): Promise<void> {
  const chargeId = typeof refund.charge === 'string' ? refund.charge : refund.charge?.id ?? null
  // Only a refund Stripe reports as succeeded is verified evidence; a pending one arrives again as an update.
  if (refund.amount <= 0 || refund.status !== 'succeeded') return
  const invoiceIdFromMetadata = stripeMetadataValue(refund.metadata, 'invoice_id')
  const paymentIntentId = typeof refund.payment_intent === 'string'
    ? refund.payment_intent
    : refund.payment_intent?.id ?? null
  const invoicePayment = paymentIntentId
    ? (await stripe.invoicePayments.list({
        limit: 100,
        status: 'paid',
        payment: { type: 'payment_intent', payment_intent: paymentIntentId },
      })).data.find(payment => {
        const invoice = payment.invoice
        return Boolean(typeof invoice === 'string' ? invoice : invoice?.id)
      })
    : null
  const charge = chargeId
    ? await stripe.charges.retrieve(chargeId) as unknown as Stripe.Charge & { invoice?: string | { id: string } | null }
    : null
  const invoiceFromCharge = typeof charge?.invoice === 'string' ? charge.invoice : charge?.invoice?.id ?? null
  const invoiceFromPayment = invoicePayment
    ? (typeof invoicePayment.invoice === 'string' ? invoicePayment.invoice : invoicePayment.invoice?.id ?? null)
    : null
  const invoiceId = invoiceIdFromMetadata ?? invoiceFromPayment ?? invoiceFromCharge
  if (!invoiceId) return
  const invoice = await stripe.invoices.retrieve(invoiceId, {
    expand: ['lines.data.pricing.price_details.price'],
  }) as StripeInvoiceWithSubscription
  const subscriptionId = invoiceSubscriptionId(invoice)
  if (!subscriptionId) return
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['items.data.price.product'],
  })
  const context = await resolveStripeGa4Context(db, stripe, subscription, null)
  const platformOrganizationId = (await getPlatformOrganization(db)).id
  // The refund is the purchase's reversal: it keeps that purchase's own identity, attribution,
  // classification and reconciled items. Only a purchase recorded before this coverage has none,
  // and then the established relationship is used.
  const original = await queryFirst<{ purchase_type: string | null; attribution: string | null; attributed_at: string | null; originating_user_id: string | null; items: string | null }>(db,
    `SELECT (payload_json ->> '$.metadata.purchase_type') AS purchase_type, json_extract(payload_json, '$.attribution') AS attribution,
      (payload_json ->> '$.attributed_at') AS attributed_at, (payload_json ->> '$.metadata.originating_user_id') AS originating_user_id,
      json_extract(payload_json, '$.value.items') AS items FROM analytics_events
    WHERE kind = 'conversion' AND organization_id = ? AND (payload_json ->> '$.event_name') = 'purchase'
      AND (payload_json ->> '$.entity_type') = 'invoice' AND (payload_json ->> '$.entity_id') = ?`, [platformOrganizationId, invoiceId])
  const value = buildStripeRefundValue({
    invoice, refundAmount: refund.amount, currency: refund.currency ?? invoice.currency,
    purchaseItems: original?.items ? JSON.parse(original.items) as ConversionItem[] : null,
  })
  const originatingUserId = original ? original.originating_user_id
    : context.organizationId ? await originatingOwnerId(db, platformOrganizationId, context.organizationId) : null
  const recorded = await recordOrganizationConversionEvent(db, null, {
    organizationId: platformOrganizationId, eventName: 'refund', stage: 'completed', surface: 'stripe',
    entityType: 'refund', entityId: refund.id, value,
    occurredAt: new Date(refund.created * 1000).toISOString(),
    attribution: original?.attribution && original.attributed_at ? { touch: JSON.parse(original.attribution), attributedAt: original.attributed_at } : null,
    metadata: {
      subscription_id: subscriptionId, ...(original?.purchase_type ? { purchase_type: original.purchase_type } : {}),
      ...(context.organizationId ? { subscribing_organization_id: context.organizationId, originating_user_id: originatingUserId } : {}),
    },
  })
  const projection = projectConversionToGa4({ eventName: 'refund', value, params: { refund_id: refund.id, subscription_id: subscriptionId } })
  const previous = recorded.created ? null : await readGa4Delivery(db, recorded.id)
  const delivery = previous && previous.status !== 'failed' ? previous : await deliverViaMeasurementProtocol(env, db, {
    eventId: recorded.id, organizationId: platformOrganizationId, event: projection,
    clientId: context.clientId, userId: context.userId, sessionId: null, sessionCapturedAt: null,
  })
  if (delivery.status === 'failed') throw new Error(`GA4 refund delivery failed for refund ${refund.id}: ${delivery.detail}`)
}

/** The subscription an invoice belongs to, across both Stripe invoice shapes. */
function invoiceSubscriptionId(invoice: {
  subscription?: unknown
  parent?: unknown
}): string | null {
  const parent = invoice.parent as { subscription_details?: { subscription?: unknown } | null } | null | undefined
  const subscriptionValue = invoice.subscription ?? parent?.subscription_details?.subscription
  return typeof subscriptionValue === 'string'
    ? subscriptionValue
    : subscriptionValue && typeof subscriptionValue === 'object' && 'id' in subscriptionValue && typeof subscriptionValue.id === 'string'
      ? subscriptionValue.id
      : null
}

export async function handleStripeGa4Event(
  env: CloudflareEnv,
  db: DbClient,
  stripe: Stripe,
  event: Stripe.Event,
): Promise<void> {
  try {
    if (event.type === 'checkout.session.completed') {
      await attachCheckoutIntent(db, event.data.object as Stripe.Checkout.Session)
      return
    }

    if (event.type === 'invoice.paid') {
      await recordStripePurchase(env, db, stripe, event.data.object as StripeInvoiceWithSubscription, event)
      return
    }

    if (event.type === 'refund.created' || event.type === 'refund.updated') {
      await recordStripeRefund(env, db, stripe, event.data.object as Stripe.Refund)
      return
    }

    if (!event.type.startsWith('customer.subscription.')) return
    const subscription = event.data.object as Stripe.Subscription
    const intent = await findPendingStripeGa4Intent(db, subscription.id)

    if (event.type === 'customer.subscription.updated' && intent?.action === 'downgrade' && intent.effectiveTiming === 'period_end') {
      const lifecycleEvent = intent.newPriceId ? 'subscription_downgrade' : 'subscription_cancelled'
      await sendStripeGa4Lifecycle(env, db, stripe, subscription, lifecycleEvent, event, intent)
      return
    }
    if (event.type === 'customer.subscription.updated' && intent?.action === 'upgrade' && intent.source !== 'browser') {
      await sendStripeGa4Lifecycle(env, db, stripe, subscription, 'subscription_upgrade', event, intent)
      return
    }
    if (event.type === 'customer.subscription.deleted') {
      if (!intent && await findConsumedStripeGa4CancellationIntent(db, subscription.id)) return
      await sendStripeGa4Lifecycle(env, db, stripe, subscription, 'subscription_cancelled', event, intent)
    }
  } catch (error) {
    console.error('stripe_ga4_event_processing_failed', {
      eventId: event.id,
      eventType: event.type,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
