import type Stripe from 'stripe'
import { assertNewSalePlan, PAID_PLAN_PRICES, planPriceTiers } from '~/shared/billing-model'

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

/** The plan amount a canonical price charges for its included locations. */
export function planPriceAmount(price: Stripe.Price): number {
  const amount = price.tiers?.[0]?.flat_amount
  if (typeof amount !== 'number' || amount <= 0) throw new Error(`Stripe price ${price.id} has no plan amount`)
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
