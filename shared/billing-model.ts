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

/** Fixed USD monthly offers: each plan is one flat price at quantity 1. */
export const PAID_PLAN_PRICES: Readonly<Record<NewSalePlanId, { monthly: number }>> = Object.freeze({
  [GROWTH_PLAN_ID]: Object.freeze({ monthly: 4900 }),
  [BUSINESS_PLAN_ID]: Object.freeze({ monthly: 14900 }),
})

/** Services KrabiClaw's people perform, priced in USD cents per month and sold beside the plan. */
export const SERVICE_PRICES = Object.freeze({
  strategy: Object.freeze({ monthly: 200000 }),
})

/** Locations every plan's price includes. A home's location is not a location: homes are counted apart. */
export const INCLUDED_LOCATIONS = 2

/** USD cents for each location beyond the included ones, per month. */
export const ADDITIONAL_LOCATION_PRICE = 4900

/** Homes (places to stay, each a lodging unit) every plan's price includes. */
export const INCLUDED_HOMES = 2

/** USD cents for each home beyond the included ones, per month, the same on Growth and Business. */
export const ADDITIONAL_HOME_PRICE = 900

/** Business's Payments fee: a share of the payment volume it captures. */
export const PAYMENTS_FEE_RATE = 0.014

/** Managed ads' share of the connected Google Ads account's spend. */
export const AD_SPEND_RATE = 0.1

/** USD cents as the pricing page writes a plan price: "$49", "$2,000". The catalog sells in USD only. */
export function formatPlanPrice(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

/** A rate as the percent Stripe writes it: 0.014 → "1.4". */
export function ratePercent(rate: number): string {
  return String(Math.round(rate * 1e6) / 1e4)
}

/** Stripe's phrasing for the per-unit charge after an included allowance: "$49 per additional location per month". */
export function additionalLocationPrice(): string {
  return `$${ADDITIONAL_LOCATION_PRICE / 100} per additional location per month`
}

/** The same phrasing for homes: "$9 per additional home per month". */
export function additionalHomePrice(): string {
  return `$${ADDITIONAL_HOME_PRICE / 100} per additional home per month`
}

/** The fee as the pricing page and the plan screen state it. */
export const PAYMENTS_FEE = `${ratePercent(PAYMENTS_FEE_RATE)}% of payment volume, plus Stripe fees`

/** What Business adds to Growth, each with its one line: what an upgrade gains and a change to Growth ends. */
export const BUSINESS_ADDITIONS = Object.freeze([
  { id: 'payments', label: 'Online payments and direct stay booking', summary: PAYMENTS_FEE },
  { id: 'google-ads', label: 'Google Ads campaigns', summary: 'List and inspect campaigns; create Search campaigns and update status or budgets' },
] as const)

/**
 * What a plan subscription bills beside its flat price, each a Stripe meter
 * and the monthly metered price that bills it at the end of the period:
 *
 * - locations and homes each report their active count (`last`), billed in
 *   graduated tiers after the included ones; a home's location is a home,
 *   never a location;
 * - captured volume, Stripe cost and ad spend report USD cents as they occur
 *   (`sum`), billed at a flat rate per cent.
 *
 * `plans` names the plans whose subscription carries the price.
 */
export const BILLING_METERS = Object.freeze({
  locations: Object.freeze({
    name: 'Additional location',
    eventName: 'krabiclaw_locations',
    formula: 'last',
    unitLabel: 'location',
    plans: [GROWTH_PLAN_ID, BUSINESS_PLAN_ID],
    tiers: [{ up_to: INCLUDED_LOCATIONS, unit_amount: 0 }, { up_to: 'inf', unit_amount: ADDITIONAL_LOCATION_PRICE }],
    description: `${INCLUDED_LOCATIONS} locations included, then ${additionalLocationPrice()}. Homes are counted separately and are not locations.`,
  }),
  homes: Object.freeze({
    name: 'Additional home',
    eventName: 'krabiclaw_homes',
    formula: 'last',
    unitLabel: 'home',
    plans: [GROWTH_PLAN_ID, BUSINESS_PLAN_ID],
    tiers: [{ up_to: INCLUDED_HOMES, unit_amount: 0 }, { up_to: 'inf', unit_amount: ADDITIONAL_HOME_PRICE }],
    description: `${INCLUDED_HOMES} homes included, then ${additionalHomePrice()}.`,
  }),
  captured_volume: Object.freeze({
    name: 'Payments fee',
    eventName: 'krabiclaw_captured_volume',
    formula: 'sum',
    unitLabel: 'cent',
    plans: [BUSINESS_PLAN_ID],
    unitAmountDecimal: String(PAYMENTS_FEE_RATE),
    description: `${ratePercent(PAYMENTS_FEE_RATE)}% of payment volume.`,
  }),
  stripe_cost: Object.freeze({
    name: 'Stripe fees',
    eventName: 'krabiclaw_stripe_cost',
    formula: 'sum',
    unitLabel: 'cent',
    plans: [BUSINESS_PLAN_ID],
    unitAmountDecimal: '1',
    description: 'Stripe fees on your payments, at cost.',
  }),
  ad_spend: Object.freeze({
    name: 'Managed ads',
    eventName: 'krabiclaw_ad_spend',
    formula: 'sum',
    unitLabel: 'cent',
    plans: [BUSINESS_PLAN_ID],
    unitAmountDecimal: String(AD_SPEND_RATE),
    description: `${ratePercent(AD_SPEND_RATE)}% of monthly ad spend for campaigns we manage.`,
  }),
} as const)

export type BillingMeterKey = keyof typeof BILLING_METERS
export const BILLING_METER_KEYS = Object.freeze(Object.keys(BILLING_METERS) as BillingMeterKey[])

/** The metered prices a plan's subscription carries, in catalog order. */
export function planMeters(planId: string): BillingMeterKey[] {
  return BILLING_METER_KEYS.filter(key => (BILLING_METERS[key].plans as readonly string[]).includes(planId))
}

/**
 * The services as they are offered everywhere — the pricing page and its
 * Markdown, the plan screen, Insights and Today — each turned on and off only
 * in Plan and billing.
 */
export const SERVICES = Object.freeze({
  managed_ads: Object.freeze({
    name: 'Managed ads',
    description: 'Chris hand-manages the campaigns in your connected Google Ads account — budgets, creative direction and conversion rate — and meets with you weekly.',
    price: `${ratePercent(AD_SPEND_RATE)}% of monthly ad spend`,
    billing: 'Billed at the end of each month on your Business subscription. Connecting Google Ads and reading its results in Insights is free.',
  }),
  strategy: Object.freeze({
    name: 'SEO and marketing strategy',
    description: 'Julia leads your SEO strategy, hand-writes blog posts written to rank, meets with you weekly and is on chat with you.',
    price: `$${(SERVICE_PRICES.strategy.monthly / 100).toLocaleString('en-US')} per month`,
    billing: 'Added to your plan subscription and billed monthly by Stripe, prorated from the day you agree.',
  }),
})

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
