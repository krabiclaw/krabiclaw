import type Stripe from 'stripe'
import { BILLING_METER_KEYS, BILLING_METERS, type BillingMeterKey } from '~/shared/billing-model'
import type { CloudflareEnv } from '~/server/utils/auth'
import { readOrganizationSubscriptions } from '~/server/utils/billing-access'
import { planSubscriptionItem, readStripeCatalog, selectMeteredPrices } from '~/server/utils/stripe-catalog'

export const STRIPE_METER_RENEWAL = 'blawby_meter_renewal'
export const STRIPE_METER_RENEWED = 'blawby_meter_renewed'

interface StripeMeterTransition {
  renewal: number
  completed: boolean
}

export function stripeMeterTransition(contract?: Stripe.Subscription): StripeMeterTransition | undefined {
  const raw = contract?.metadata?.[STRIPE_METER_RENEWAL]
  if (!raw) return
  const renewal = Number(raw)
  if (!Number.isSafeInteger(renewal) || renewal <= 0) throw new Error(`Stripe subscription ${contract.id} has an invalid meter renewal`)
  const completed = contract.metadata[STRIPE_METER_RENEWED] === raw
  // A customer-directed schedule or cancellation supersedes an unstarted swap.
  if (!completed && (contract.schedule || contract.pending_update || contract.cancel_at_period_end
    || (contract.cancel_at !== null && contract.cancel_at <= renewal)
    || !contract.items.data.some(item => item.current_period_end === renewal || item.current_period_start === renewal))) return
  return { renewal, completed }
}

export async function readStripeMeterTransition(
  stripe: Stripe, env: CloudflareEnv, organizationId: string, customer: string,
): Promise<StripeMeterTransition | undefined> {
  if (env.STRIPE_BILLING_METER_MIGRATION !== 'true') return
  const all = (await readOrganizationSubscriptions(env, [organizationId])).get(organizationId) ?? []
  const billed = all.filter(row => ['active', 'trialing', 'past_due'].includes(row.status))
  if (billed.length > 1) throw new Error(`Organization ${organizationId} has more than one billed subscription`)
  const subscriptionId = billed[0]?.stripeSubscriptionId
  if (!subscriptionId) return
  const contract = await stripe.subscriptions.retrieve(subscriptionId)
  if (contract.customer !== customer) throw new Error(`Stripe subscription ${subscriptionId} belongs to a different customer`)
  return stripeMeterTransition(contract)
}

export async function reportStripeMeterUsage(
  stripe: Stripe,
  key: BillingMeterKey,
  customer: string,
  value: number,
  transition?: StripeMeterTransition,
  identifier?: string,
): Promise<void> {
  const { eventName, replacementEventName } = BILLING_METERS[key]
  const payload = { stripe_customer_id: customer, value: String(value) }
  if (transition?.completed && !identifier) {
    await stripe.billing.meterEvents.create({ event_name: replacementEventName, payload })
    return
  }
  const original = await stripe.billing.meterEvents.create({
    event_name: eventName,
    payload,
    ...(identifier ? { identifier } : {}),
  }, identifier ? { idempotencyKey: identifier } : undefined)
  if (!transition || !identifier || original.timestamp < transition.renewal) return

  // The closing invoice only includes usage strictly before renewal. Stripe
  // excludes replacement events sent before the new price becomes effective.
  // Keep these events pending in usage_events until the price has switched.
  if (!transition.completed) throw new Error('Stripe has not yet activated the replacement meter for this billing period')
  const replacementIdentifier = `blawby:${identifier}`
  await stripe.billing.meterEvents.create({
    event_name: replacementEventName,
    payload,
    identifier: replacementIdentifier,
  }, { idempotencyKey: replacementIdentifier })
}

/**
 * A renewal uses Stripe's ordinary subscription and invoice. The metadata
 * arms one exact boundary. The payment webhook runs after the closing invoice
 * has been assembled and before those pending meter events are sent again.
 */
export async function replaceRenewedStripeMeters(stripe: Stripe, event: Stripe.Event): Promise<string | undefined> {
  if (event.account || (event.type !== 'invoice.finalized' && event.type !== 'invoice.paid' && event.type !== 'invoice.payment_failed')) return
  const invoice = event.data.object
  const details = invoice.parent?.subscription_details
  const renewal = details?.metadata?.[STRIPE_METER_RENEWAL]
  if (!renewal || !details || invoice.billing_reason !== 'subscription_cycle' || String(invoice.period_end) !== renewal) return
  const subscriptionId = typeof details.subscription === 'string' ? details.subscription : details.subscription.id
  const contract = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price.product'] })
  const transition = stripeMeterTransition(contract)
  if (!transition || String(transition.renewal) !== renewal) return
  const customer = typeof contract.customer === 'string' ? contract.customer : contract.customer.id
  if (invoice.customer !== customer) throw new Error(`Stripe invoice ${invoice.id} belongs to a different customer`)
  if (transition.completed) return customer
  const plan = planSubscriptionItem(contract)
  if (plan.current_period_start !== transition.renewal) return
  if (contract.billing_mode.type !== 'flexible' || contract.pending_update || contract.schedule
    || contract.items.has_more || !['active', 'past_due'].includes(contract.status)) {
    throw new Error(`Stripe subscription ${subscriptionId} has a pending change or is no longer eligible for its meter renewal`)
  }

  const catalog = await readStripeCatalog(stripe)
  const legacy = selectMeteredPrices(catalog)
  const replacement = selectMeteredPrices(catalog, true)
  const items = []
  for (const key of BILLING_METER_KEYS) {
    const current = contract.items.data.filter(item => item.price.id === legacy[key].id)
    if (!current.length) continue
    const original = current[0]!
    const next = replacement[key]
    if (current.length > 1 || original.current_period_start !== plan.current_period_start
      || original.current_period_end !== plan.current_period_end || original.price.tax_behavior !== next.tax_behavior) {
      throw new Error(`Stripe subscription ${subscriptionId} has different billing terms for ${key}`)
    }
    items.push({ id: original.id, price: next.id })
  }
  if (!items.length) throw new Error(`Stripe subscription ${subscriptionId} has no legacy meter prices to replace`)

  await stripe.subscriptions.update(subscriptionId, {
    items,
    billing_cycle_anchor: 'unchanged',
    proration_behavior: 'none',
    metadata: { [STRIPE_METER_RENEWED]: renewal },
  }, { idempotencyKey: `blawby:meter-renewal:${subscriptionId}:${renewal}` })
  return customer
}
