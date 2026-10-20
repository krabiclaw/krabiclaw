import type Stripe from 'stripe'
import { assertNewSalePlan, BILLING_METER_KEYS, BILLING_METERS, isKnownRecurringPlan, PAID_PLAN_PRICES, type BillingMeterKey } from '~/shared/billing-model'

/**
 * Each new-sale plan is one fixed application offer: a flat monthly USD price
 * billed at quantity 1. Stripe catalog metadata may identify the product, but
 * it cannot change this price contract.
 */
export function assertStripeCatalogPrice(planId: string, monthly: Stripe.Price | null | undefined): asserts monthly is Stripe.Price {
  const plan = assertNewSalePlan(planId)
  const amount = PAID_PLAN_PRICES[plan].monthly
  if (!monthly || monthly.currency?.toLowerCase() !== 'usd' || monthly.billing_scheme !== 'per_unit' || monthly.unit_amount !== amount
    || monthly.transform_quantity || monthly.recurring?.interval !== 'month' || monthly.recurring.interval_count !== 1 || monthly.recurring.usage_type !== 'licensed') {
    throw new Error(`${plan} monthly price must be the flat USD ${amount} cent monthly price`)
  }
}

/** Metered prices are read with their tiers, which Stripe lists only when expanded. */
export const PLAN_PRICE_LIST_EXPAND = ['data.tiers']

export interface StripeCatalog { products: Stripe.Product[]; prices: Stripe.Price[]; meters: Stripe.Billing.Meter[] }

/** Every product, recurring price and meter of the account: archived ones too, which still identify existing contracts. */
export async function readStripeCatalog(stripe: Stripe): Promise<StripeCatalog> {
  const [products, prices, meters] = await Promise.all([
    stripe.products.list({ limit: 100 }).autoPagingToArray({ limit: 10_000 }),
    stripe.prices.list({ type: 'recurring', limit: 100, expand: PLAN_PRICE_LIST_EXPAND }).autoPagingToArray({ limit: 10_000 }),
    stripe.billing.meters.list({ limit: 100 }).autoPagingToArray({ limit: 10_000 }),
  ])
  return { products, prices, meters }
}

function priceProductId(price: Stripe.Price): string {
  return typeof price.product === 'string' ? price.product : price.product.id
}

/**
 * The metered price each meter bills through: the one active product of its
 * family, its `monthly_price_id`, on the active meter with the event name and
 * formula `BILLING_METERS` names, at exactly the published tiers or rate.
 */
export function selectMeteredPrices({ products, prices, meters }: StripeCatalog): Record<BillingMeterKey, Stripe.Price> {
  return Object.fromEntries(BILLING_METER_KEYS.map(key => {
    const definition = BILLING_METERS[key]
    const matching = products.filter(product => product.active && product.metadata?.product_family === key)
    if (matching.length !== 1) throw new Error(`Stripe catalog has ${matching.length} active ${definition.name} products; exactly one is required`)
    const product = matching[0]!
    const price = prices.find(row => row.id === product.metadata.monthly_price_id?.trim() && priceProductId(row) === product.id)
    const meter = meters.find(row => row.id === price?.recurring?.meter)
    const tiers = 'tiers' in definition ? definition.tiers : null
    const unitAmountDecimal = 'unitAmountDecimal' in definition ? definition.unitAmountDecimal : null
    const rateMatches = tiers
      ? price?.billing_scheme === 'tiered' && price.tiers_mode === 'graduated' && price.tiers?.length === tiers.length
        && price.tiers.every((tier, index) => (tier.up_to ?? 'inf') === tiers[index]!.up_to && tier.unit_amount === tiers[index]!.unit_amount && tier.flat_amount === null)
      : price?.billing_scheme === 'per_unit' && price.unit_amount_decimal !== null && Number(String(price.unit_amount_decimal)) === Number(unitAmountDecimal)
    if (!price || !price.active || price.currency !== 'usd' || price.recurring?.usage_type !== 'metered' || price.recurring.interval !== 'month'
      || price.recurring.interval_count !== 1 || !rateMatches || !meter || meter.status !== 'active'
      || meter.event_name !== definition.eventName || meter.default_aggregation.formula !== definition.formula) {
      throw new Error(`Stripe product ${product.id} must bill ${definition.name} monthly on the ${definition.eventName} meter at the published rate`)
    }
    return [key, price]
  })) as Record<BillingMeterKey, Stripe.Price>
}

/** A plan subscription's one plan item. Products must be expanded. */
export function planSubscriptionItem(subscription: Stripe.Subscription): Stripe.SubscriptionItem {
  const plans = subscription.items.data.filter(item => {
    if (typeof item.price.product === 'string' || item.price.product.deleted) throw new Error(`Stripe subscription ${subscription.id} item ${item.id} product is not readable`)
    return isKnownRecurringPlan(item.price.product.metadata.plan_id)
  })
  if (plans.length !== 1) throw new Error(`Stripe subscription ${subscription.id} must contain exactly one plan price`)
  return plans[0]!
}

/** The recurring charge a licensed price makes for its subscription quantity, including graduated tiers. */
export function recurringPriceAmount(price: Stripe.Price, quantity: number | null | undefined): number {
  if (!Number.isSafeInteger(quantity) || (quantity as number) < 1 || price.transform_quantity) throw new Error(`Stripe price ${price.id} has an unsupported subscription quantity`)
  let amount: number
  if (price.billing_scheme === 'per_unit' && Number.isSafeInteger(price.unit_amount)) {
    amount = price.unit_amount! * quantity!
  } else if (price.billing_scheme === 'tiered' && price.tiers_mode === 'graduated' && price.tiers?.length) {
    let lower = 0
    amount = 0
    for (const tier of price.tiers) {
      const upper = tier.up_to ?? Infinity
      if (upper <= lower || (tier.flat_amount === null && typeof tier.flat_amount_decimal === 'string')
        || (tier.unit_amount === null && typeof tier.unit_amount_decimal === 'string')) throw new Error(`Stripe price ${price.id} has unsupported subscription tiers`)
      if (quantity! > lower) amount += (tier.flat_amount ?? 0) + (Math.min(quantity!, upper) - lower) * (tier.unit_amount ?? 0)
      lower = upper
    }
    if (quantity! > lower) throw new Error(`Stripe price ${price.id} does not cover its subscription quantity`)
  } else {
    throw new Error(`Stripe price ${price.id} has an unsupported subscription billing scheme`)
  }
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`Stripe price ${price.id} has an invalid subscription amount`)
  return amount
}

/**
 * A plan product's canonical monthly price: its `monthly_price_id`, or the one
 * active flat monthly price when the product names none.
 */
export function selectStripeCatalogPrice(product: Stripe.Product, prices: Stripe.Price[]): Stripe.Price | null {
  const candidates = prices.filter(price => priceProductId(price) === product.id
    && price.active !== false
    && price.recurring?.interval === 'month'
    && price.recurring.interval_count === 1
    && price.recurring.usage_type === 'licensed'
    && price.billing_scheme === 'per_unit')
  const metadataPriceId = product.metadata?.monthly_price_id?.trim()
  if (metadataPriceId) {
    const selected = candidates.find(price => price.id === metadataPriceId)
    if (!selected) throw new Error(`Stripe product ${product.id} has an invalid monthly_price_id canonical price`)
    return selected
  }
  if (candidates.length > 1) throw new Error(`Stripe product ${product.id} must have exactly one canonical month price`)
  return candidates[0] ?? null
}
