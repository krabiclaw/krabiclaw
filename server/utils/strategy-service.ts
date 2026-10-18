import { HTTPError } from 'nitro'
import type Stripe from 'stripe'
import { execute, queryFirst, type DbClient } from '~/server/db'
import { SERVICE_PRICES } from '~/shared/billing-model'
import type { CloudflareEnv } from '~/server/utils/auth'
import { getOrganizationBillingStatus, getStripe } from '~/server/utils/billing'

/**
 * SEO and marketing strategy: Julia's service, sold as its own item on the
 * business's plan subscription. Stripe owns the billing — the item is what is
 * charged, its invoice lines are the record, and reading it back from the
 * subscription is the state. An `organization_services` row holds what Stripe
 * cannot: who agreed and when, and it serializes activation, since its unique
 * partial index lets only one current agreement exist per organization. The catalog product carries
 * `product_family=services` and `service=strategy`, never a `plan_id`, so
 * Better Auth keeps resolving the plan from the plan item.
 */
export interface StrategyService { item_id: string; price_id: string; amount: number; currency: string; interval: string; since: string }

/** Bump when the terms a business agrees to change. */
export const STRATEGY_TERMS_VERSION = '2026-10-18'
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
  // The consent dialog states the catalog's price; Stripe's must be that price or nobody is charged.
  if (price.unit_amount !== SERVICE_PRICES.strategy.monthly || price.currency !== 'usd') throw new Error(`Stripe Strategy price ${price.id} is ${price.unit_amount} ${price.currency}, not the ${SERVICE_PRICES.strategy.monthly} usd the business was shown`)
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
  const agreement = await queryFirst<{ id: string }>(db, "SELECT id FROM organization_services WHERE organization_id=? AND service='strategy' AND ended_at IS NULL", [organizationId])
  if (!item) {
    if (agreement) throw new Error('A strategy agreement is recorded but its Stripe item is missing')
    return null
  }
  if (!agreement) throw new Error(`Stripe subscription item ${item.id} is the strategy service but no agreement is recorded`)
  if (typeof item.price.unit_amount !== 'number') throw new Error(`Stripe strategy item ${item.id} has no amount`)
  return { item_id: item.id, price_id: item.price.id, amount: item.price.unit_amount, currency: item.price.currency.toUpperCase(), interval: item.price.recurring?.interval ?? 'month', since: new Date(item.created * 1000).toISOString() }
}

/** One consent attempt: the browser names it, so a retry of the same attempt is deduplicated and a later attempt is not. */
export function isAttemptId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{8,64}$/u.test(value)
}

export async function startStrategy(env: CloudflareEnv, db: DbClient, organizationId: string, userId: string, attempt: string): Promise<StrategyService> {
  const found = await planSubscription(env, db, organizationId)
  if (!found || !['active', 'trialing'].includes(found.subscription.status)) throw new HTTPError({ statusCode: 409, statusMessage: 'Choose a plan before adding the strategy service; it is billed with the plan.' })
  if (strategyItem(found.subscription)) throw new HTTPError({ statusCode: 409, statusMessage: 'The strategy service is already on' })
  const price = await strategyPrice(found.stripe)
  // The agreement row goes first: its unique index admits one activation at a time, so two clicks cannot both add an item.
  const agreementId = crypto.randomUUID()
  try {
    await execute(db, 'INSERT INTO organization_services(id,organization_id,service,terms_version,agreed_by_user_id,agreed_at) VALUES(?,?,?,?,?,?)', [agreementId, organizationId, 'strategy', STRATEGY_TERMS_VERSION, userId, new Date().toISOString()])
  } catch (cause) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'The strategy service is already being turned on', cause })
  }
  let updated: Stripe.Subscription
  try {
  // Stripe invoices today's prorated share at once and charges the plan's card; a declined card fails here and adds nothing.
    updated = await found.stripe.subscriptions.update(found.subscription.id, {
      items: [{ price: price.id, quantity: 1 }],
      proration_behavior: 'always_invoice',
      payment_behavior: 'error_if_incomplete',
      expand: ['items.data.price.product'],
    }, { idempotencyKey: `strategy-start:${organizationId}:${attempt}` })
  } catch (cause) {
    // Stripe added nothing, so there is no agreement to keep.
    await execute(db, 'DELETE FROM organization_services WHERE id=?', [agreementId])
    throw cause
  }
  const item = strategyItem(updated)
  if (!item) throw new Error('Stripe did not add the strategy item to the subscription')
  const read = await readStrategy(env, db, organizationId)
  if (!read || read.item_id !== item.id) throw new Error('The strategy item did not read back from the subscription')
  return read
}

export async function endStrategy(env: CloudflareEnv, db: DbClient, organizationId: string, userId: string, attempt: string): Promise<void> {
  const found = await planSubscription(env, db, organizationId)
  const item = found && strategyItem(found.subscription)
  if (!found || !item) throw new HTTPError({ statusCode: 409, statusMessage: 'The strategy service is not on' })
  await found.stripe.subscriptionItems.del(item.id, { proration_behavior: 'create_prorations' }, { idempotencyKey: `strategy-end:${organizationId}:${attempt}` })
  if (await readStrategy(env, db, organizationId)) throw new Error('The strategy item is still on the subscription')
  await execute(db, "UPDATE organization_services SET ended_at=?,ended_by_user_id=? WHERE organization_id=? AND service='strategy' AND ended_at IS NULL", [new Date().toISOString(), userId, organizationId])
}
