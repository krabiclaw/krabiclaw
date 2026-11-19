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
 * reported to their meters (server/utils/stripe-meter-usage.ts) and charged on the
 * subscription's invoice at the end of the period.
 */
import type Stripe from 'stripe'
import type { StripePlan } from '@better-auth/stripe'
import { getPlanEntitlements } from '~/server/utils/billing-entitlements'
import { isKnownRecurringPlan, isNewSalePlan, planMeters } from '~/shared/billing-model'
import { assertStripeCatalogPrice, readStripeCatalog, selectMeteredPrices, selectStripeCatalogPrice, type StripeCatalog } from '~/server/utils/stripe-catalog'

export async function getBetterAuthStripePlans(stripe: Stripe): Promise<StripePlan[]> {
  return plansFromCatalog(await readStripeCatalog(stripe))
}

function plansFromCatalog(catalog: StripeCatalog, replacement = false): StripePlan[] {
  const metered = selectMeteredPrices(catalog, replacement)
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

export type StripePlanLoader = (existingItems?: ReadonlySet<string>) => Promise<StripePlan[]>

interface PlanSnapshot {
  plans: StripePlan[]
  replacementPlans?: StripePlan[]
}

function selectContractPlans(snapshot: PlanSnapshot, existingItems?: ReadonlySet<string>): StripePlan[] {
  if (!existingItems || !snapshot.replacementPlans?.some(plan => plan.lineItems?.some(item => typeof item.price === 'string' && existingItems.has(item.price)))) {
    return copyPlans(snapshot.plans)
  }
  if (snapshot.plans.some(plan => plan.lineItems?.some(item => typeof item.price === 'string' && existingItems.has(item.price)))) {
    throw new Error('The Stripe subscription combines legacy and replacement billing meters')
  }
  return copyPlans(snapshot.replacementPlans)
}

const STRIPE_PLAN_CACHE_TTL_MS = 60_000
const stripePlanSnapshots = new Map<string, PlanSnapshot & { expiresAt: number }>()
const stripePlanPending = new Map<string, Promise<PlanSnapshot>>()

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
  const migrateMeters = env?.STRIPE_BILLING_METER_MIGRATION === 'true'
  return async (existingItems) => {
    const key = `${cacheScope}:${migrateMeters}`
    const now = Date.now()
    const snapshot = stripePlanSnapshots.get(key)
    if (snapshot && snapshot.expiresAt > now) return selectContractPlans(snapshot, existingItems)

    const existing = stripePlanPending.get(key)
    if (existing) return selectContractPlans(await existing, existingItems)

    const refresh = readStripeCatalog(stripe)
      .then((catalog) => {
        const refreshed = {
          plans: plansFromCatalog(catalog),
          replacementPlans: migrateMeters ? plansFromCatalog(catalog, true) : undefined,
        }
        stripePlanSnapshots.set(key, { ...refreshed, expiresAt: Date.now() + ttlMs })
        return refreshed
      })
      .finally(() => stripePlanPending.delete(key))
    stripePlanPending.set(key, refresh)
    return selectContractPlans(await refresh, existingItems)
  }
}

function copyPlans(plans: StripePlan[]): StripePlan[] {
  return plans.map(plan => ({ ...plan, ...(plan.lineItems ? { lineItems: plan.lineItems.map(item => ({ ...item })) } : {}) }))
}
