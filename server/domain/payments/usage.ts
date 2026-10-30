import Stripe from 'stripe'
import { HTTPError } from 'nitro'
import { execute, queryAll, queryFirst, type DbClient } from '~/server/db'
import { getOrganizationBillingStatus, getStripe } from '~/server/utils/billing'
import type { CloudflareEnv } from '~/server/utils/auth'
import { BILLING_METERS, BUSINESS_PLAN_ID, PAYMENTS_FEE, PAYMENT_TERMS, ratePercent, type BillingMeterKey } from '~/shared/billing-model'
import { planSubscriptionItem } from '~/server/utils/stripe-catalog'
import { recordPaymentsVolumeBilled } from '~/server/domain/booking-analytics'
import { tokenHash } from './buyer'
import { readPaymentsBillingBasis } from './fx'

/**
 * Payments usage is billed by Stripe meters on the business's own plan
 * subscription: captured volume, Stripe's costs and managed ad spend are
 * reported in USD cents as they occur, and the subscription's metered prices
 * bill them on its invoice at the end of the period. `payment_usage_events` is
 * only the outbox that delivers each one to its meter once.
 */
type UsageKind = 'captured_volume' | 'stripe_cost' | 'stripe_cost_adjustment' | 'ad_spend'

const USAGE_METER: Record<UsageKind, BillingMeterKey> = {
  captured_volume: 'captured_volume',
  stripe_cost: 'stripe_cost',
  stripe_cost_adjustment: 'stripe_cost',
  ad_spend: 'ad_spend',
}

interface UsageEvent { id: string; payment_id: string | null; kind: UsageKind; currency: string; amount: number; source_id: string; billing_basis_json: string | null }

/**
 * Send each undelivered usage event to its meter, timestamped now so it lands
 * in the period Stripe has open; a cost correction is a negative value. The
 * identifier and idempotency key are the source's, so a repeat after a lost
 * answer is the same event. A rejected event keeps Stripe's reason and stops
 * the delivery; Stripe's own 4xx (other than rate limiting) is not retried.
 */
export async function deliverPaymentsUsage(db: DbClient, env: CloudflareEnv, organizationId: string): Promise<{ delivered: number }> {
  const events = await queryAll<UsageEvent>(db, 'SELECT id,payment_id,kind,currency,amount,source_id,billing_basis_json FROM payment_usage_events WHERE organization_id=? AND delivery_at IS NULL AND dead_letter_at IS NULL ORDER BY created_at', [organizationId])
  if (!events.length) return { delivered: 0 }
  const organization = await queryFirst<{ customer: string | null }>(db, 'SELECT "stripeCustomerId" AS customer FROM organization WHERE id=?', [organizationId])
  if (!organization?.customer) {
    // A deleted business's late costs have no subscription left to bill them;
    // they stay in the outbox with the reason.
    await execute(db, 'UPDATE payment_usage_events SET error=?,dead_letter_at=? WHERE organization_id=? AND delivery_at IS NULL AND dead_letter_at IS NULL', ['The business has no Stripe customer to bill this usage to', new Date().toISOString(), organizationId])
    return { delivered: 0 }
  }
  const stripe = getStripe(env)
  let delivered = 0
  for (const event of events) {
    const basis = readPaymentsBillingBasis(event.billing_basis_json, event.amount, event.currency)
    if (basis.currency !== 'USD') throw new Error(`Payments usage ${event.id} has no USD billing amount`)
    const identifier = `payments:${await tokenHash(event.source_id)}`
    try {
      await stripe.billing.meterEvents.create({
        event_name: BILLING_METERS[USAGE_METER[event.kind]].eventName,
        identifier,
        payload: { stripe_customer_id: organization.customer, value: String(basis.amount) },
      }, { idempotencyKey: identifier })
    } catch (error) {
      const permanent = error instanceof Stripe.errors.StripeError && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 429
      await execute(db, 'UPDATE payment_usage_events SET error=?,dead_letter_at=? WHERE id=?', [error instanceof Error ? error.message : String(error), permanent ? new Date().toISOString() : null, event.id])
      throw error
    }
    if (event.kind === 'captured_volume') {
      if (!event.payment_id) throw new Error(`Captured volume ${event.id} has no payment`)
      await recordPaymentsVolumeBilled(db, { organizationId, paymentId: event.payment_id, volumeMinor: basis.amount, currency: basis.currency })
    }
    await execute(db, 'UPDATE payment_usage_events SET delivery_at=?,error=NULL WHERE id=?', [new Date().toISOString(), event.id])
    delivered++
  }
  return { delivered }
}

/**
 * What Payments usage costs this business and what is still to be delivered:
 * the rates are its subscription's own metered prices, read from Stripe, and
 * `configured` says the subscription carries them.
 */
export async function paymentsUsage(db: DbClient, env: CloudflareEnv, organizationId: string) {
  const undelivered = await queryAll<{ currency: string; kind: string; amount: number; billing_basis_json: string | null; error: string | null }>(db,
    'SELECT currency,kind,amount,billing_basis_json,error FROM payment_usage_events WHERE organization_id=? AND delivery_at IS NULL ORDER BY kind,currency', [organizationId])
  const pending: Array<{ currency: string; kind: string; event_count: number; amount: number; billing_amount: number; action_required: boolean }> = []
  for (const event of undelivered) {
    const basis = readPaymentsBillingBasis(event.billing_basis_json, event.amount, event.currency)
    let row = pending.find(entry => entry.kind === event.kind && entry.currency === event.currency)
    if (!row) pending.push(row = { currency: event.currency, kind: event.kind, event_count: 0, amount: 0, billing_amount: 0, action_required: false })
    row.event_count++
    row.amount += event.amount
    row.billing_amount += basis.amount
    row.action_required ||= event.error !== null
  }
  const billing = await getOrganizationBillingStatus(env, db, organizationId)
  const refreshed_at = new Date().toISOString()
  // Only Business carries the fee prices; any other plan has nothing to read from Stripe.
  if (billing.plan !== BUSINESS_PLAN_ID) return { configured: false, pricing: null, pending, source: 'Stripe', refreshed_at, terms: { ...PAYMENT_TERMS, fee: PAYMENTS_FEE, source: 'offer' } }
  if (!billing.stripeSubscriptionId) throw new HTTPError({ statusCode: 409, statusMessage: 'Business subscription is missing', data: { code: 'PAYMENT_PRICING_UNAVAILABLE', field: 'stripeSubscriptionId' } })
  const subscription = await getStripe(env).subscriptions.retrieve(billing.stripeSubscriptionId, { expand: ['items.data.price.product'] })
  planSubscriptionItem(subscription)
  const rate = (key: BillingMeterKey): number | null => {
    const item = subscription.items.data.find(row => typeof row.price.product !== 'string' && !row.price.product.deleted && row.price.product.metadata.product_family === key)
    if (!item) return null
    // The SDK reads a decimal amount as a Decimal; its string is the exact amount.
    const value = item.price.unit_amount_decimal === null ? NaN : Number(String(item.price.unit_amount_decimal))
    if (item.price.recurring?.usage_type !== 'metered' || item.price.billing_scheme !== 'per_unit' || !Number.isFinite(value) || value < 0) throw new HTTPError({ statusCode: 502, statusMessage: 'Stripe subscription has invalid payment pricing', data: { code: 'PAYMENT_PRICING_INVALID', field: key } })
    return value
  }
  const capturedVolume = rate('captured_volume')
  const stripeCost = rate('stripe_cost')
  const adSpend = rate('ad_spend')
  if (capturedVolume === null || stripeCost === null) throw new HTTPError({ statusCode: 502, statusMessage: 'The subscription is missing required payment prices', data: { code: 'PAYMENT_PRICING_INVALID', field: capturedVolume === null ? 'captured_volume' : 'stripe_cost' } })
  return {
    terms: { ...PAYMENT_TERMS, fee: `${ratePercent(capturedVolume)}% of payment volume, plus Stripe fees`, stripe: `${ratePercent(stripeCost)}% of Stripe processing costs. The underlying fees depend on the payment method and transaction.`, source: 'subscription' },
    configured: true,
    pricing: {
      currency: 'USD' as const,
      units: 'cents' as const,
      captured_volume_rate: capturedVolume,
      captured_volume_rate_percent: ratePercent(capturedVolume),
      stripe_cost_rate: stripeCost,
      ad_spend_rate: adSpend,
      ad_spend_rate_percent: adSpend === null ? null : ratePercent(adSpend),
      livemode: subscription.livemode,
    },
    pending,
    source: 'Stripe',
    refreshed_at,
  }
}
