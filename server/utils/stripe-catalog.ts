import type Stripe from 'stripe'
import { ADDITIONAL_RENTAL_UNIT_PRICE, assertNewSalePlan, BUSINESS_PLAN_ID, isKnownRecurringPlan, PAID_PLAN_PRICES, planPriceTiers } from '~/shared/billing-model'

/**
 * Each new-sale plan is one fixed application offer. Stripe catalog metadata may
 * identify the product, but it cannot change this price contract: a graduated
 * USD price whose first tier is the plan amount for the included locations and
 * whose second is each additional location (`planPriceTiers`).
 */
export function assertStripeCatalogPrices(
  planId: string,
  monthly: Stripe.Price | null | undefined,
  annual?: Stripe.Price | null,
): asserts monthly is Stripe.Price {
  const plan = assertNewSalePlan(planId)
  const amounts = PAID_PLAN_PRICES[plan]
  if (!monthly || !hasPlanTiers(monthly, amounts.monthly, 'month')) {
    throw new Error(`${plan} monthly price must be the graduated USD ${amounts.monthly} cent plan price`)
  }
  if (annual && (amounts.annual === undefined || !hasPlanTiers(annual, amounts.annual, 'year'))) {
    throw new Error(amounts.annual === undefined
      ? `${plan} has no authorized annual price`
      : `${plan} annual price must be the graduated USD ${amounts.annual} cent plan price`)
  }
}

function hasPlanTiers(price: Stripe.Price, amount: number, interval: 'month' | 'year'): boolean {
  const expected = planPriceTiers(amount, interval)
  return price.currency?.trim().toLowerCase() === 'usd'
    && price.billing_scheme === 'tiered'
    && price.tiers_mode === 'graduated'
    && Array.isArray(price.tiers)
    && price.tiers.length === expected.length
    && price.tiers.every((tier, index) => {
      const want = expected[index]!
      return (tier.up_to ?? 'inf') === want.up_to
        && tier.flat_amount === (want.flat_amount ?? null)
        && tier.unit_amount === (want.unit_amount ?? null)
    })
}

/**
 * A Business price is the current offer when it charges the current amount on
 * the current tiers. Business prices sold before it remain the contracts of
 * the subscriptions on them: they bill every location and no rental units.
 */
export function isCurrentBusinessPrice(price: Stripe.Price): boolean {
  return price.recurring?.interval === 'month' && price.recurring.interval_count === 1
    && hasPlanTiers(price, PAID_PLAN_PRICES[BUSINESS_PLAN_ID].monthly, 'month')
}

/** The catalog family of the Additional rental unit product, which never carries a `plan_id`. */
export const RENTAL_UNITS_FAMILY = 'rental_units'

/** The Additional rental unit price Business is sold with: per unit, USD 19, monthly. */
export function assertRentalUnitPrice(price: Stripe.Price | undefined, productId: string): asserts price is Stripe.Price {
  if (!price || price.active === false || price.currency?.toLowerCase() !== 'usd' || price.billing_scheme !== 'per_unit'
    || price.unit_amount !== ADDITIONAL_RENTAL_UNIT_PRICE || price.transform_quantity
    || price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1 || price.recurring.usage_type !== 'licensed') {
    throw new Error(`Stripe product ${productId} must sell additional rental units at the per-unit USD ${ADDITIONAL_RENTAL_UNIT_PRICE} cent monthly price`)
  }
}

/** The one active Additional rental unit product's canonical price, from a catalog listing. */
export function selectRentalUnitPrice(products: Stripe.Product[], prices: Stripe.Price[]): Stripe.Price {
  const matching = products.filter(product => product.active && product.metadata?.product_family === RENTAL_UNITS_FAMILY)
  if (matching.length !== 1) throw new Error(`Stripe catalog has ${matching.length} active Additional rental unit products; exactly one is required`)
  const product = matching[0]!
  const priceId = product.metadata.monthly_price_id?.trim()
  const price = prices.find(row => row.id === priceId && (typeof row.product === 'string' ? row.product : row.product.id) === product.id)
  assertRentalUnitPrice(price, product.id)
  return price
}

/**
 * A plan subscription's items by what they bill: the one plan item, and the
 * Additional rental unit item when the business pays for more units than its
 * plan includes. Products must be expanded.
 */
export function planSubscriptionItems(subscription: Stripe.Subscription): { plan: Stripe.SubscriptionItem; rentalUnits: Stripe.SubscriptionItem | null } {
  const product = (item: Stripe.SubscriptionItem) => {
    if (typeof item.price.product === 'string' || item.price.product.deleted) throw new Error(`Stripe subscription ${subscription.id} item ${item.id} product is not readable`)
    return item.price.product
  }
  const plans = subscription.items.data.filter(item => isKnownRecurringPlan(product(item).metadata.plan_id))
  if (plans.length !== 1) throw new Error(`Stripe subscription ${subscription.id} must contain exactly one plan price`)
  const units = subscription.items.data.filter(item => product(item).metadata.product_family === RENTAL_UNITS_FAMILY)
  if (units.length > 1) throw new Error(`Stripe subscription ${subscription.id} has more than one Additional rental unit item`)
  const plan = plans[0]!
  const rentalUnits = units[0] ?? null
  if (rentalUnits && (product(plan).metadata.plan_id !== BUSINESS_PLAN_ID || !isCurrentBusinessPrice(plan.price))) {
    throw new Error(`Stripe subscription ${subscription.id} bills rental units without the current Business price`)
  }
  return { plan, rentalUnits }
}

/** The plan amount a canonical price charges for its included locations. */
export function planPriceAmount(price: Stripe.Price): number {
  const amount = price.tiers?.[0]?.flat_amount
  if (typeof amount !== 'number' || amount <= 0) throw new Error(`Stripe price ${price.id} has no plan amount`)
  return amount
}

/** The recurring charge for the native subscription quantity, including its original price tiers. */
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

/** Plan prices are read with their tiers, which Stripe lists only when expanded. */
export const PLAN_PRICE_LIST_EXPAND = ['data.tiers']

export function selectStripeCatalogPrice(
  product: Stripe.Product,
  prices: Stripe.Price[],
  interval: 'month' | 'year',
): Stripe.Price | null {
  const productPrices = prices.filter(price => {
    const productId = typeof price.product === 'string' ? price.product : price.product?.id
    return productId === product.id
  })
  const candidates = productPrices.filter(price =>
    price.active !== false
    && price.recurring?.interval === interval
    && price.recurring.interval_count === 1
    && price.billing_scheme === 'tiered'
    && typeof price.currency === 'string'
    && price.currency.length > 0,
  )
  if (candidates.length === 0) return null

  const metadataKey = interval === 'month' ? 'monthly_price_id' : 'annual_price_id'
  const metadataPriceId = product.metadata?.[metadataKey]?.trim()
  if (metadataPriceId) {
    const selected = candidates.find(price => price.id === metadataPriceId)
    if (!selected) {
      throw new Error(`Stripe product ${product.id} has an invalid ${metadataKey} canonical price`)
    }
    return selected
  }

  const lookupKeyCandidates = candidates.filter(price => {
    const lookupKey = price.lookup_key?.toLowerCase() ?? ''
    return interval === 'month'
      ? lookupKey.includes('month')
      : lookupKey.includes('annual') || lookupKey.includes('year')
  })
  if (lookupKeyCandidates.length > 1) {
    throw new Error(`Stripe product ${product.id} has multiple ${interval} prices marked by lookup_key`)
  }
  if (lookupKeyCandidates.length === 1) {
    return lookupKeyCandidates[0] ?? null
  }
  if (candidates.length !== 1) {
    throw new Error(`Stripe product ${product.id} must have exactly one canonical ${interval} price`)
  }
  return candidates[0] ?? null
}
