import type Stripe from 'stripe'
import { buildPostLoginUrl } from '~/shared/auth/return-target'
import { createStripeClient } from '~/server/utils/stripe-client'
import { getPlanEntitlements } from './billing-entitlements'
import {
  assertStripeCatalogPrices,
  PLAN_PRICE_LIST_EXPAND,
  planPriceAmount,
  selectStripeCatalogPrice,
} from './stripe-catalog'
import {
  isNewSalePlan,
  isKnownRecurringPlan,
  GROWTH_PLAN_ID,
  COMMERCE_PLAN_ID,
  NEW_SALE_PAID_PLAN_IDS,
  PAID_PLAN_PRICES,
  STARTER_PLAN_ID,
} from '~/shared/billing-model'

// ── Types ────────────────────────────────────────────────────────────────────

export interface PlanPrice {
  id: string
  amount: number // cents, for the included locations
  currency: string
  interval: 'month' | 'year'
}

export interface PlanLimits {
  customDomain: boolean
  googlePlaces: boolean
  support: string
}

export interface Plan {
  id: string
  name: string
  tagline: string
  highlighted: boolean
  badge?: string
  image?: string
  prices: PlanPrice[]
  features: string[]
  limits: PlanLimits
  cta: { label: string; href: string }
}

export type EnvWithOrganizationCache = Record<string, string | undefined> & {
  ORGANIZATION_CACHE?: KVNamespace
}

export class BillingPlansError extends Error {
  readonly statusCode = 503
  readonly code: string

  constructor(code: string, message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'BillingPlansError'
    this.code = code
  }
}

// ── Internal constants ───────────────────────────────────────────────────────

interface MarketingFeature {
  name: string
}

// Starter has no Stripe product — it is genuinely free with no subscription.
const STARTER_PLAN: Plan = {
  id: STARTER_PLAN_ID,
  name: 'Basic',
  tagline: 'Get your business online for free',
  highlighted: false,
  prices: [],
  features: [
    'Free Krabiclaw ChatGPT app — build & edit your site by chatting',
    'Bookings, ticketed experiences & consultation requests',
    'Email notifications for reservations & bookings',
    'Structured SEO schema for restaurants, experiences & legal practices',
  ],
  limits: publicPlanLimits(STARTER_PLAN_ID),
  image: '/pricing/plan-basic-photo.png',
  cta: { label: 'Start Free', href: '/signup' },
}

// CTA labels and hrefs are app config — not Stripe data.
const PLAN_CTA: Record<string, { label: string; href: string }> = {
  [GROWTH_PLAN_ID]: { label: 'Get Growth', href: `/signup?plan=${GROWTH_PLAN_ID}&redirect=${encodeURIComponent(buildPostLoginUrl({ plan: GROWTH_PLAN_ID }))}` },
  [COMMERCE_PLAN_ID]: { label: 'Get Commerce', href: `/signup?plan=${COMMERCE_PLAN_ID}&redirect=${encodeURIComponent(buildPostLoginUrl({ plan: COMMERCE_PLAN_ID }))}` },
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function publicPlanLimits(planId: string): PlanLimits {
  const entitlements = getPlanEntitlements(planId)
  return {
    customDomain: entitlements.custom_domains === true,
    googlePlaces: entitlements.google_places === true,
    support: 'Documentation and help form',
  }
}

function isMarketingFeatureArray(value: ApiValue): value is MarketingFeature[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as MarketingFeature).name === 'string',
    )
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlanPrice(value: unknown): value is PlanPrice {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.amount === 'number'
    && Number.isFinite(value.amount)
    && Number.isInteger(value.amount)
    && value.amount > 0
    && typeof value.currency === 'string'
    && value.currency.length > 0
    && (value.interval === 'month' || value.interval === 'year')
  )
}

function isPlanLimits(value: unknown, planId: string): value is PlanLimits {
  if (!isRecord(value)) return false
  const expected = publicPlanLimits(planId)
  return (
    typeof value.customDomain === 'boolean'
    && typeof value.googlePlaces === 'boolean'
    && typeof value.support === 'string'
    && value.customDomain === expected.customDomain
    && value.googlePlaces === expected.googlePlaces
    && value.support === expected.support
  )
}

function isPlan(value: unknown): value is Plan {
  if (!isRecord(value)) return false
  const id = value.id
  const hasPublicId = id === STARTER_PLAN_ID || isNewSalePlan(id)
  const optionalString = (key: 'badge' | 'image') =>
    !(key in value) || typeof value[key] === 'string'

  return (
    hasPublicId
    && typeof value.name === 'string'
    && typeof value.tagline === 'string'
    && typeof value.highlighted === 'boolean'
    && optionalString('badge')
    && optionalString('image')
    && Array.isArray(value.prices)
    && value.prices.every(isPlanPrice)
    && Array.isArray(value.features)
    && value.features.every((feature) => typeof feature === 'string')
    && isPlanLimits(value.limits, id as string)
    && isRecord(value.cta)
    && typeof value.cta.label === 'string'
    && typeof value.cta.href === 'string'
  )
}

function parseCachedPlans(value: unknown): Plan[] {
  if (!Array.isArray(value) || !value.every(isPlan)) {
    throw new BillingPlansError(
      'BILLING_PLANS_CACHE_INVALID',
      'Billing plans cache contains an invalid response',
    )
  }

  const ids = value.map((plan) => plan.id)
  if (new Set(ids).size !== ids.length) {
    throw new BillingPlansError(
      'BILLING_PLANS_CACHE_INVALID',
      'Billing plans cache contains duplicate plan IDs',
    )
  }

  const expectedIds: readonly string[] = [STARTER_PLAN_ID, ...NEW_SALE_PAID_PLAN_IDS]
  if (ids.length !== expectedIds.length || ids.some((id) => !expectedIds.includes(id))) {
    throw new BillingPlansError(
      'BILLING_PLANS_CACHE_INVALID',
      'Billing plans cache must contain every current plan',
    )
  }

  const starter = value.find((plan) => plan.id === STARTER_PLAN_ID)
  if (!starter || starter.prices.length !== 0) {
    throw new BillingPlansError(
      'BILLING_PLANS_CACHE_INVALID',
      'Billing plans cache contains an invalid Starter price set',
    )
  }
  const paid = NEW_SALE_PAID_PLAN_IDS.map(planId => {
    const plan = value.find(plan => plan.id === planId)
    const amounts = PAID_PLAN_PRICES[planId]
    const monthlyPrices = plan?.prices.filter(price => price.interval === 'month') ?? []
    const annualPrices = plan?.prices.filter(price => price.interval === 'year') ?? []
    const monthly = monthlyPrices[0]
    const annual = annualPrices[0]
    if (!plan || monthlyPrices.length !== 1 || annualPrices.length > 1
      || plan.prices.length !== monthlyPrices.length + annualPrices.length
      || monthly?.amount !== amounts.monthly || monthly.currency.toLowerCase() !== 'usd'
      || (annual && (amounts.annual === undefined || annual.amount !== amounts.annual || annual.currency.toLowerCase() !== 'usd'))) {
      throw new BillingPlansError('BILLING_PLANS_CACHE_INVALID', `Billing plans cache contains an invalid ${planId} price set`)
    }
    return plan
  })

  // Keep the public response order stable even if a valid cache was written
  // by an older worker that serialized plans in a different order.
  return [starter, ...paid]
}

// ── Stripe fetch ─────────────────────────────────────────────────────────────

export async function fetchStripeProducts(
  env: Record<string, string | undefined>,
): Promise<Plan[]> {
  const stripe = createStripeClient(env.STRIPE_SECRET_KEY!)

  // Paginate all products
  let products: Stripe.Product[] = []
  let prodStartingAfter: string | undefined
  do {
    const page = await stripe.products.list({
      active: true,
      limit: 100,
      expand: ['data.default_price'],
      ...(prodStartingAfter ? { starting_after: prodStartingAfter } : {}),
    })
    products = products.concat(page.data)
    prodStartingAfter =
      page.has_more && page.data.length > 0
        ? page.data[page.data.length - 1]!.id
        : undefined
  } while (prodStartingAfter)

  // Paginate all prices
  const priceLookup: Record<string, Stripe.Price[]> = {}
  let startingAfter: string | undefined
  while (true) {
    const prices = await stripe.prices.list({
      active: true,
      type: 'recurring',
      limit: 100,
      expand: PLAN_PRICE_LIST_EXPAND,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    for (const price of prices.data) {
      const interval = price.recurring?.interval
      if (interval !== 'month' && interval !== 'year') continue
      const pid =
        typeof price.product === 'string' ? price.product : price.product.id
      if (!priceLookup[pid]) priceLookup[pid] = []
      priceLookup[pid].push(price)
    }
    if (!prices.has_more || prices.data.length === 0) break
    startingAfter = prices.data[prices.data.length - 1]?.id
  }

  const plans: Plan[] = []

  const productsByNewSalePlan = new Map<string, Stripe.Product[]>()
  for (const product of products) {
    const planId = product.metadata?.plan_id
    if (!isNewSalePlan(planId)) continue
    const matching = productsByNewSalePlan.get(planId) ?? []
    matching.push(product)
    productsByNewSalePlan.set(planId, matching)
  }
  for (const [planId, matching] of productsByNewSalePlan) {
    if (matching.length <= 1) continue
    throw new BillingPlansError(
      'BILLING_PLANS_INVALID_CATALOG',
      `Stripe has multiple active products for plan ${planId}: ${matching.map(product => product.id).sort().join(', ')}`,
    )
  }

  for (const product of products) {
    const meta = (product.metadata ?? {}) as Record<string, string>
    const planId = meta.plan_id
    if (!planId || !isKnownRecurringPlan(planId) || !isNewSalePlan(planId)) continue

    const productWithMarketing = product as Stripe.Product & {
      marketing_features?: ApiValue
    }
    const features = isMarketingFeatureArray(
      productWithMarketing.marketing_features,
    )
      ? productWithMarketing.marketing_features.map((f) => f.name)
      : []

    let monthly: Stripe.Price | null
    let yearly: Stripe.Price | null
    try {
      monthly = selectStripeCatalogPrice(product, priceLookup[product.id] ?? [], 'month')
      yearly = selectStripeCatalogPrice(product, priceLookup[product.id] ?? [], 'year')
      assertStripeCatalogPrices(planId, monthly, yearly)
    } catch (error) {
      throw new BillingPlansError(
        'BILLING_PLANS_INVALID_CATALOG',
        error instanceof Error ? error.message : `Invalid Stripe catalog for plan ${planId}`,
        error,
      )
    }
    if (!monthly) {
      throw new BillingPlansError(
        'BILLING_PLANS_INVALID_CATALOG',
        `Stripe product ${product.id} for plan ${planId} is missing a canonical monthly price`,
      )
    }
    const prices: PlanPrice[] = [monthly, yearly]
      .filter((price): price is Stripe.Price => Boolean(price))
      .map((price) => ({
        id: price.id,
        amount: planPriceAmount(price),
        currency: price.currency,
        interval: price.recurring?.interval === 'year' ? 'year' : 'month',
      }))

    plans.push({
      id: planId,
      name: product.name,
      tagline: product.description ?? '',
      highlighted: meta.highlighted === 'true',
      badge: meta.badge || undefined,
      image: product.images?.[0],
      prices: prices.sort((a, b) => {
        const rank: Record<string, number> = { month: 0, year: 1 }
        return (rank[a.interval] ?? 0) - (rank[b.interval] ?? 0)
      }),
      features,
      limits: publicPlanLimits(planId),
      cta: PLAN_CTA[planId] ?? { label: 'Get started', href: '/signup' },
    })
  }

  plans.sort((a, b) => {
    const aPrice = a.prices.find((p) => p.interval === 'month')?.amount ?? 0
    const bPrice = b.prices.find((p) => p.interval === 'month')?.amount ?? 0
    return aPrice - bPrice
  })

  if (plans.length !== NEW_SALE_PAID_PLAN_IDS.length || NEW_SALE_PAID_PLAN_IDS.some(id => !plans.some(plan => plan.id === id))) {
    throw new BillingPlansError(
      'BILLING_PLANS_INVALID_CATALOG',
      'Stripe public catalog must contain exactly one active product for every current paid plan',
    )
  }

  return [STARTER_PLAN, ...plans]
}

// ── KV-backed cache with in-flight coalescing ────────────────────────────────

const PLANS_CACHE_TTL_SECONDS = 3600

// The cached catalog carries copy written in this file — the Starter plan's
// feature lines — as well as Stripe's, so it is the build's to invalidate:
// keyed by the build id, as the HTML cache is, a deploy that changes the copy
// is read at once rather than served stale for the hour the TTL allows, which
// is how the home page kept the old product name after the rename shipped.
// The caller passes the build id from its own runtime config: during SSR this
// module runs inside the app bundle, where Nitro's runtime-config import is a
// stub under `nuxt dev`, and Nuxt's useRuntimeConfig() is the real one.
function plansCacheKey(buildId: string | undefined): string {
  if (!buildId) throw new BillingPlansError('BILLING_PLANS_UNAVAILABLE', 'Billing plans cache has no build id to key on')
  return `stripe-plans:v6:${buildId}`
}

// Single-instance in-flight guard — prevents a cache stampede where multiple
// concurrent Worker requests all miss the KV cache simultaneously and each
// fire a separate Stripe paginated fetch. Workers run in a single isolate per
// request within one instance, but warm instances handle multiple requests in
// the same event loop tick, so a shared module-level promise is the correct
// primitive here (unlike multi-process servers where you'd need a distributed
// lock).
let _inflight: Promise<Plan[]> | null = null

export async function getCachedPlans(env: EnvWithOrganizationCache, buildId: string | undefined): Promise<Plan[]> {
  try {
    const kv = env.ORGANIZATION_CACHE
    const cacheKey = plansCacheKey(buildId)

    if (kv) {
      const cached = await kv.get(cacheKey, 'text')
      if (cached !== null) {
        let parsed: unknown
        try {
          parsed = JSON.parse(cached)
        } catch (error) {
          throw new BillingPlansError('BILLING_PLANS_CACHE_INVALID', 'Billing plans cache contains invalid data', error)
        }
        return parseCachedPlans(parsed)
      }
    }

    // Coalesce concurrent cache misses: if the canonical Stripe fetch is
    // already in progress, wait for it rather than firing a duplicate.
    if (_inflight) return await _inflight

    _inflight = (async () => {
      const plans = await fetchStripeProducts(env)
      if (kv) {
        await kv.put(cacheKey, JSON.stringify(plans), {
          expirationTtl: PLANS_CACHE_TTL_SECONDS,
        })
      }
      return plans
    })()

    try {
      return await _inflight
    } finally {
      _inflight = null
    }
  } catch (error) {
    if (error instanceof BillingPlansError) throw error
    throw new BillingPlansError(
      'BILLING_PLANS_UNAVAILABLE',
      'Billing plans are temporarily unavailable',
      error,
    )
  }
}
