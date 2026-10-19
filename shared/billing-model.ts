/**
 * Canonical billing-plan policy shared by server loaders and client billing
 * callers. Stripe may retain products for plans that are no longer sold; those
 * catalog records remain runtime identities only for the contracts already
 * using them; only the current offers may be purchased.
 */

export const STARTER_PLAN_ID = 'free' as const
export const GROWTH_PLAN_ID = 'growth' as const
export const COMMERCE_PLAN_ID = 'commerce' as const
export const MARKETING_PLAN_ID = 'marketing' as const
export const BUSINESS_PLAN_ID = 'business' as const

/** Paid plans that may be purchased or attached to a new handoff. */
export const NEW_SALE_PAID_PLAN_IDS = Object.freeze([GROWTH_PLAN_ID, BUSINESS_PLAN_ID] as const)

/** Recurring plan identities accepted by runtime billing projections. */
export const KNOWN_RECURRING_PLAN_IDS = Object.freeze([
  ...NEW_SALE_PAID_PLAN_IDS,
  COMMERCE_PLAN_ID,
  MARKETING_PLAN_ID,
] as const)

export type StarterPlanId = typeof STARTER_PLAN_ID
export type NewSalePlanId = typeof NEW_SALE_PAID_PLAN_IDS[number]
export type KnownRecurringPlanId = typeof KNOWN_RECURRING_PLAN_IDS[number]
export type BillingPlanId = StarterPlanId | KnownRecurringPlanId

/** Fixed USD recurring offers. An absent annual amount authorizes no annual offer. */
export const PAID_PLAN_PRICES: Readonly<Record<NewSalePlanId, { monthly: number; annual?: number }>> = Object.freeze({
  [GROWTH_PLAN_ID]: Object.freeze({ monthly: 4900, annual: 58800 }),
  [BUSINESS_PLAN_ID]: Object.freeze({ monthly: 9900 }),
})

/** Services KrabiClaw's people perform, priced in USD cents per month and sold beside the plan. */
export const SERVICE_PRICES = Object.freeze({
  strategy: Object.freeze({ monthly: 200000 }),
})

/** Managed ads' share of the connected account's spend: the flat `payments_ad_spend` rate on the Payments rate card. */
export const AD_SPEND_RATE = 0.1

/**
 * The services as they are offered everywhere — the pricing page and its
 * Markdown, the plan screen, Insights and Today — each turned on and off only
 * in Payments → Plan → Services.
 */
export const SERVICES = Object.freeze({
  managed_ads: Object.freeze({
    name: 'Managed ads',
    description: 'Chris hand-manages the campaigns in your connected Google Ads account — budgets, creative direction and conversion rate — and meets with you weekly.',
    price: `${AD_SPEND_RATE * 100}% of monthly ad spend`,
    billing: 'Billed with your KrabiClaw usage fees. Connecting Google Ads and reading its results in Insights is free.',
  }),
  strategy: Object.freeze({
    name: 'SEO and marketing strategy',
    description: 'Julia leads your SEO strategy, hand-writes blog posts written to rank, meets with you weekly and is on chat with you.',
    price: `$${(SERVICE_PRICES.strategy.monthly / 100).toLocaleString('en-US')} per month`,
    billing: 'Added to your plan subscription and billed monthly by Stripe, prorated from the day you agree.',
  }),
})

/** Locations every plan's price includes. */
export const INCLUDED_LOCATIONS = 2

/** USD cents for each location beyond the included ones, per billing interval. */
export const ADDITIONAL_LOCATION_PRICES = Object.freeze({ monthly: 4900, annual: 58800 })

/** Stripe's phrasing for the per-unit charge after an included allowance: "$49 per additional location per month". */
export function additionalLocationPrice(interval: 'month' | 'year' = 'month'): string {
  const cents = interval === 'year' ? ADDITIONAL_LOCATION_PRICES.annual : ADDITIONAL_LOCATION_PRICES.monthly
  return `$${cents / 100} per additional location per ${interval}`
}

/**
 * A paid plan's Stripe price is graduated: its subscription quantity is the
 * number of locations it covers, the first tier is the plan amount for the
 * included locations, and each further unit is one additional location.
 */
export function planPriceTiers(amount: number, interval: 'month' | 'year'): Array<{ up_to: number | 'inf'; flat_amount?: number; unit_amount?: number }> {
  // Each tier sets only the charge it makes, so the invoice reads "Growth" and
  // "1 location × Growth" with no $0.00 lines beside them.
  return [
    { up_to: INCLUDED_LOCATIONS, flat_amount: amount },
    { up_to: 'inf', unit_amount: interval === 'year' ? ADDITIONAL_LOCATION_PRICES.annual : ADDITIONAL_LOCATION_PRICES.monthly },
  ]
}

/**
 * Locations an organization may have: the included ones on Basic, and on a
 * paid plan the quantity its subscription is billed for. Quantities below the
 * included count are charged the same flat tier, so they cover it too.
 */
export function coveredLocations(plan: string, quantity: number | null | undefined): number {
  if (!isKnownRecurringPlan(plan)) return INCLUDED_LOCATIONS
  if (!Number.isSafeInteger(quantity) || (quantity as number) < 1) throw new Error(`Subscription location quantity ${String(quantity)} is invalid`)
  return Math.max(INCLUDED_LOCATIONS, quantity as number)
}

/**
 * A serializable view for consumers that need to render or test the policy
 * without duplicating its arrays. The arrays are readonly so callers cannot
 * mutate the process-wide policy.
 */
export const BILLING_PLAN_POLICY = Object.freeze({
  starter: STARTER_PLAN_ID,
  newSalePaid: NEW_SALE_PAID_PLAN_IDS,
  knownRecurring: KNOWN_RECURRING_PLAN_IDS,
})

export function normalizeBillingPlanId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return normalized || null
}

export function isKnownBillingPlan(value: unknown): value is BillingPlanId {
  return value === STARTER_PLAN_ID || isKnownRecurringPlan(value)
}

export function isKnownRecurringPlan(value: unknown): value is KnownRecurringPlanId {
  return typeof value === 'string'
    && (KNOWN_RECURRING_PLAN_IDS as readonly string[]).includes(value)
}

export function isNewSalePlan(value: unknown): value is NewSalePlanId {
  return typeof value === 'string'
    && (NEW_SALE_PAID_PLAN_IDS as readonly string[]).includes(value)
}

/**
 * Validate a paid plan used by a new sale, checkout, or ownership handoff.
 * Starter is intentionally not accepted here because it has no subscription;
 * callers that support cancellation/free state should handle `free` explicitly.
 */
export function assertNewSalePlan(value: unknown): NewSalePlanId {
  const normalized = normalizeBillingPlanId(value)
  if (isNewSalePlan(normalized)) return normalized
  throw new Error(`Unknown paid plan "${normalized ?? String(value)}"`)
}

/**
 * Return a normalized new-sale plan, or null for free/unknown input.
 * This is useful for UI filtering where throwing would be unnecessarily noisy.
 */
export function getNewSalePlan(value: unknown): NewSalePlanId | null {
  const normalized = normalizeBillingPlanId(value)
  return isNewSalePlan(normalized) ? normalized : null
}
