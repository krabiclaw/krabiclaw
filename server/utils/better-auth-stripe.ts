/**
 * The Stripe plan catalog Better Auth's Stripe plugin is configured from.
 *
 * Subscription state itself is the plugin's: its webhook handlers own the
 * `subscription` table, and server/utils/billing-access.ts is the only reader.
 * This module resolves plan identity and canonical prices, nothing more.
 *
 * A subscription's quantity is the number of locations it covers (see
 * `planPriceTiers`), which is what Better Auth records as `seats` and what its
 * `upgrade` endpoint changes; no plan has a member-seat price.
 */
import type Stripe from 'stripe'
import type { StripePlan } from '@better-auth/stripe'
import { getPlanEntitlements } from '~/server/utils/billing-entitlements'
import {
  isKnownRecurringPlan,
  isNewSalePlan,
} from '~/shared/billing-model'
import {
  assertStripeCatalogPrices,
  PLAN_PRICE_LIST_EXPAND,
  selectStripeCatalogPrice,
} from '~/server/utils/stripe-catalog'

export async function getBetterAuthStripePlans(
  stripe: Stripe,
  _env?: ApiRecord,
): Promise<StripePlan[]> {
  const products: Stripe.Product[] = []
  let productsStartingAfter: string | undefined
  do {
    const page = await stripe.products.list({
      limit: 100,
      ...(productsStartingAfter ? { starting_after: productsStartingAfter } : {}),
    })
    products.push(...page.data)
    productsStartingAfter = page.has_more ? page.data.at(-1)?.id : undefined
  } while (productsStartingAfter)

  const prices: Stripe.Price[] = []
  let pricesStartingAfter: string | undefined
  do {
    const page = await stripe.prices.list({
      type: 'recurring',
      limit: 100,
      expand: PLAN_PRICE_LIST_EXPAND,
      ...(pricesStartingAfter ? { starting_after: pricesStartingAfter } : {}),
    })
    prices.push(...page.data)
    pricesStartingAfter = page.has_more ? page.data.at(-1)?.id : undefined
  } while (pricesStartingAfter)

  const pricesByProduct = new Map<string, Stripe.Price[]>()
  for (const price of prices) {
    const productId = typeof price.product === 'string' ? price.product : price.product.id
    const productPrices = pricesByProduct.get(productId) ?? []
    productPrices.push(price)
    pricesByProduct.set(productId, productPrices)
  }

  const plans: StripePlan[] = []
  const planIds = new Set<string>()

  for (const product of products) {
    const planId = product.metadata?.plan_id?.trim()
    if (!planId) continue
    // Archived products and prices still identify existing contracts. Better
    // Auth needs their exact price IDs to process those subscription webhooks.
    if (!isKnownRecurringPlan(planId)) continue
    if (planIds.has(planId)) throw new Error(`Stripe has multiple products for plan ${planId}`)

    const billablePrices = pricesByProduct.get(product.id) ?? []
    const retiredPrice = (interval: 'month' | 'year') => {
      const key = interval === 'month' ? 'monthly_price_id' : 'annual_price_id'
      const id = product.metadata?.[key]?.trim()
      if (!id && interval === 'year') return null
      const price = billablePrices.find(row => row.id === id)
      if (!price || price.recurring?.interval !== interval || price.recurring.interval_count !== 1) {
        throw new Error(`Stripe product ${product.id} has an invalid ${key} contract price`)
      }
      return price
    }
    const monthly = isNewSalePlan(planId)
      ? selectStripeCatalogPrice(product, billablePrices, 'month')
      : retiredPrice('month')
    if (!monthly) {
      throw new Error(`Stripe product ${product.id} for plan ${planId} is missing a canonical monthly price`)
    }
    const yearly = isNewSalePlan(planId)
      ? selectStripeCatalogPrice(product, billablePrices, 'year')
      : retiredPrice('year')
    if (isNewSalePlan(planId)) {
      if (!product.active) throw new Error(`Stripe product ${product.id} for plan ${planId} is archived`)
      assertStripeCatalogPrices(planId, monthly, yearly)
    }
    if (yearly && yearly.currency !== monthly.currency) {
      throw new Error(`Stripe product ${product.id} has monthly and annual prices in different currencies`)
    }
    const configuredCurrency = product.metadata?.currency?.trim().toLowerCase()
    if (configuredCurrency && configuredCurrency !== monthly.currency.toLowerCase()) {
      throw new Error(`Stripe product ${product.id} currency metadata does not match its canonical price`)
    }

    plans.push({
      name: planId,
      priceId: monthly.id,
      ...(monthly.lookup_key?.trim() ? { lookupKey: monthly.lookup_key.trim() } : {}),
      annualDiscountPriceId: yearly?.id,
      ...(yearly?.lookup_key?.trim() ? { annualDiscountLookupKey: yearly.lookup_key.trim() } : {}),
      limits: getPlanEntitlements(planId),
      group: 'krabiclaw',
    })
    // Put the current offer first: Better Auth selects upgrades by plan name,
    // but resolves webhook identity by every configured exact price ID.
    for (const price of billablePrices) {
      if (price.id === monthly.id || price.id === yearly?.id) continue
      plans.push({ name: planId, priceId: price.id, limits: getPlanEntitlements(planId), group: 'krabiclaw' })
    }
    planIds.add(planId)
  }

  return plans
}

export type StripePlanLoader = () => Promise<StripePlan[]>

const STRIPE_PLAN_CACHE_TTL_MS = 60_000
const stripePlanSnapshots = new Map<string, { plans: StripePlan[]; expiresAt: number }>()
const stripePlanPending = new Map<string, Promise<StripePlan[]>>()

function stripePlanCacheScope(env?: ApiRecord): string {
  const account = typeof env?.STRIPE_ACCOUNT_ID === 'string' && env.STRIPE_ACCOUNT_ID.trim()
    ? env.STRIPE_ACCOUNT_ID.trim()
    : 'platform'
  const secretKey = typeof env?.STRIPE_SECRET_KEY === 'string' ? env.STRIPE_SECRET_KEY : ''
  const mode = /^(?:sk|rk)_live_/.test(secretKey)
    ? 'live'
    : /^(?:sk|rk)_test_/.test(secretKey)
      ? 'test'
      : 'unknown'
  return `${account}:${mode}`
}

/**
 * Keeps one validated Stripe catalog snapshot per account and coalesces
 * concurrent refreshes. A refresh failure remains an error; callers must not
 * turn an unavailable or invalid catalog into an apparently valid checkout.
 */
export function createStripePlanLoader(
  stripe: Stripe,
  env?: ApiRecord,
  ttlMs = STRIPE_PLAN_CACHE_TTL_MS,
  cacheScope = stripePlanCacheScope(env),
): StripePlanLoader {
  return async () => {
    const key = cacheScope
    const now = Date.now()
    const snapshot = stripePlanSnapshots.get(key)
    if (snapshot && snapshot.expiresAt > now) return snapshot.plans

    const existing = stripePlanPending.get(key)
    if (existing) return existing

    const refresh = getBetterAuthStripePlans(stripe, env)
      .then((plans) => {
        stripePlanSnapshots.set(key, { plans, expiresAt: Date.now() + ttlMs })
        return plans
      })
      .finally(() => stripePlanPending.delete(key))
    stripePlanPending.set(key, refresh)
    return refresh
  }
}
