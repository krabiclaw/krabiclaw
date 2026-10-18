import { HTTPError } from 'nitro'
import type Stripe from 'stripe'
import type { DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { getOrganizationBillingStatus, getStripe } from '~/server/utils/billing'

/**
 * SEO and marketing strategy: Julia's service, sold as its own item on the
 * business's plan subscription. Stripe owns it entirely — the item is the
 * agreement, its invoice lines are the record, and reading it back from the
 * subscription is the state. The catalog product carries
 * `product_family=services` and `service=strategy`, never a `plan_id`, so
 * Better Auth keeps resolving the plan from the plan item.
 */
export interface StrategyService { item_id: string; price_id: string; amount: number; currency: string; interval: string; since: string }

const SEARCH = "active:'true' AND metadata['product_family']:'services' AND metadata['service']:'strategy'"

/** The one active Strategy price in this Stripe account's catalog. */
export async function strategyPrice(stripe: Stripe): Promise<Stripe.Price> {
  const products = await stripe.products.search({ query: SEARCH, limit: 2 })
  if (products.data.length !== 1) throw new Error(`Stripe catalog has ${products.data.length} active Strategy products; exactly one is required`)
  const product = products.data[0]!
  const priceId = typeof product.default_price === 'string' ? product.default_price : product.default_price?.id
  if (!priceId) throw new Error(`Stripe product ${product.id} has no default price`)
  const price = await stripe.prices.retrieve(priceId)
  if (!price.active || price.recurring?.interval !== 'month' || typeof price.unit_amount !== 'number') throw new Error(`Stripe price ${price.id} is not an active monthly Strategy price`)
  return price
}

function strategyItem(subscription: Stripe.Subscription): Stripe.SubscriptionItem | null {
  return subscription.items.data.find((item) => {
    const product = item.price.product
    return typeof product === 'object' && !product.deleted && product.metadata?.product_family === 'services' && product.metadata?.service === 'strategy'
  }) ?? null
}

async function planSubscription(env: CloudflareEnv, db: DbClient, organizationId: string): Promise<{ stripe: Stripe; subscription: Stripe.Subscription } | null> {
  const billing = await getOrganizationBillingStatus(env, db, organizationId)
  if (!billing.stripeSubscriptionId) return null
  const stripe = getStripe(env)
  const subscription = await stripe.subscriptions.retrieve(billing.stripeSubscriptionId, { expand: ['items.data.price.product'] })
  return { stripe, subscription }
}

/** What the business is on, read from its subscription; null without a plan or without the item. */
export async function readStrategy(env: CloudflareEnv, db: DbClient, organizationId: string): Promise<StrategyService | null> {
  const found = await planSubscription(env, db, organizationId)
  if (!found) return null
  const item = strategyItem(found.subscription)
  if (!item || typeof item.price.unit_amount !== 'number') return null
  return { item_id: item.id, price_id: item.price.id, amount: item.price.unit_amount, currency: item.price.currency.toUpperCase(), interval: item.price.recurring?.interval ?? 'month', since: new Date(item.created * 1000).toISOString() }
}

export async function startStrategy(env: CloudflareEnv, db: DbClient, organizationId: string): Promise<StrategyService> {
  const found = await planSubscription(env, db, organizationId)
  if (!found || !['active', 'trialing'].includes(found.subscription.status)) throw new HTTPError({ statusCode: 409, statusMessage: 'Choose a plan before adding the strategy service; it is billed with the plan.' })
  if (strategyItem(found.subscription)) throw new HTTPError({ statusCode: 409, statusMessage: 'The strategy service is already on' })
  const price = await strategyPrice(found.stripe)
  // Stripe prorates today's share onto the next invoice and charges the plan's card; a declined card fails here, not later.
  const updated = await found.stripe.subscriptions.update(found.subscription.id, {
    items: [{ price: price.id, quantity: 1 }],
    proration_behavior: 'create_prorations',
    payment_behavior: 'error_if_incomplete',
    expand: ['items.data.price.product'],
  }, { idempotencyKey: `strategy-start:${organizationId}:${found.subscription.id}:${price.id}` })
  const item = strategyItem(updated)
  if (!item) throw new Error('Stripe did not add the strategy item to the subscription')
  const read = await readStrategy(env, db, organizationId)
  if (!read || read.item_id !== item.id) throw new Error('The strategy item did not read back from the subscription')
  return read
}

export async function endStrategy(env: CloudflareEnv, db: DbClient, organizationId: string): Promise<void> {
  const found = await planSubscription(env, db, organizationId)
  const item = found && strategyItem(found.subscription)
  if (!found || !item) throw new HTTPError({ statusCode: 409, statusMessage: 'The strategy service is not on' })
  await found.stripe.subscriptionItems.del(item.id, { proration_behavior: 'create_prorations' }, { idempotencyKey: `strategy-end:${organizationId}:${item.id}` })
  if (await readStrategy(env, db, organizationId)) throw new Error('The strategy item is still on the subscription')
}
