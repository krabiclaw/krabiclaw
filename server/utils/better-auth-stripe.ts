/**
 * The Stripe plan catalog Better Auth's Stripe plugin is configured from.
 *
 * Subscription state itself is the plugin's: its webhook handlers own the
 * `subscription` table, and server/utils/billing-access.ts is the only reader.
 * This module resolves plan identity and canonical prices, nothing more.
 *
 * Each plan is a flat monthly price at quantity 1 (Better Auth's `seats` is
 * always 1), and its metered prices are the plan's `lineItems`: Better Auth's
 * Checkout adds them, its `upgrade` adds and removes the ones that differ
 * between two plans, and a metered item carries no quantity. What they bill is
 * reported to their meters (server/utils/billing-meters.ts) and charged on the
 * subscription's invoice at the end of the period.
 */
import type Stripe from 'stripe'
import type { StripePlan } from '@better-auth/stripe'
import { getPlanEntitlements } from '~/server/utils/billing-entitlements'
import { isKnownRecurringPlan, isNewSalePlan, planMeters } from '~/shared/billing-model'
import { assertStripeCatalogPrice, readStripeCatalog, selectMeteredPrices, selectStripeCatalogPrice } from '~/server/utils/stripe-catalog'

export async function getBetterAuthStripePlans(stripe: Stripe): Promise<StripePlan[]> {
  const catalog = await readStripeCatalog(stripe)
  const metered = selectMeteredPrices(catalog)
  const plans: StripePlan[] = []
  const planIds = new Set<string>()

  for (const product of catalog.products) {
    const planId = product.metadata?.plan_id?.trim()
    // Archived products and prices still identify existing contracts. Better
    // Auth needs their exact price IDs to process those subscription webhooks.
    if (!planId || !isKnownRecurringPlan(planId)) continue
    if (planIds.has(planId)) throw new Error(`Stripe has multiple products for plan ${planId}`)
    const productPrices = catalog.prices.filter(price => (typeof price.product === 'string' ? price.product : price.product.id) === product.id)
    let monthly: Stripe.Price | null
    if (isNewSalePlan(planId)) {
      if (!product.active) throw new Error(`Stripe product ${product.id} for plan ${planId} is archived`)
      monthly = selectStripeCatalogPrice(product, productPrices)
      assertStripeCatalogPrice(planId, monthly)
    } else {
      monthly = productPrices.find(price => price.id === product.metadata?.monthly_price_id?.trim()) ?? null
      if (!monthly) throw new Error(`Stripe product ${product.id} has an invalid monthly_price_id contract price`)
    }
    const lineItems = planMeters(planId).map(key => ({ price: metered[key].id }))
    const plan = { limits: getPlanEntitlements(planId), group: 'krabiclaw', ...(lineItems.length ? { lineItems } : {}) }
    // Put the current offer first: Better Auth selects upgrades by plan name,
    // but resolves webhook identity by every configured exact price ID.
    plans.push({ name: planId, priceId: monthly.id, ...plan })
    for (const price of productPrices) {
      if (price.id !== monthly.id) plans.push({ name: planId, priceId: price.id, ...plan })
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
 * Each call answers its own copy, so no request can change another's plans.
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
    if (snapshot && snapshot.expiresAt > now) return copyPlans(snapshot.plans)

    const existing = stripePlanPending.get(key)
    if (existing) return copyPlans(await existing)

    const refresh = getBetterAuthStripePlans(stripe)
      .then((plans) => {
        stripePlanSnapshots.set(key, { plans, expiresAt: Date.now() + ttlMs })
        return plans
      })
      .finally(() => stripePlanPending.delete(key))
    stripePlanPending.set(key, refresh)
    return copyPlans(await refresh)
  }
}

function copyPlans(plans: StripePlan[]): StripePlan[] {
  return plans.map(plan => ({ ...plan, ...(plan.lineItems ? { lineItems: plan.lineItems.map(item => ({ ...item })) } : {}) }))
}
