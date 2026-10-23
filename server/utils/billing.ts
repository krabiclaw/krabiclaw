import type Stripe from 'stripe'
import { HTTPError } from 'nitro';
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { hasPermission } from 'better-auth/plugins'
import { organizationAdapter } from '~/server/utils/member-access'
import { getPlanEntitlements, type EntitlementsMap } from '~/server/utils/billing-entitlements'
import { entitlingSubscription, getOrganizationEntitlements, planFromSubscriptions, readOrganizationSubscriptions } from '~/server/utils/billing-access'
import { BILLING_METER_KEYS, BILLING_METERS, INCLUDED_HOMES, INCLUDED_LOCATIONS, isKnownRecurringPlan, type BillingMeterKey } from '~/shared/billing-model'
import { isCurrencyCode, type CurrencyCode } from '~/shared/currencies'
import { createStripeClient } from '~/server/utils/stripe-client'
import { createStripePlanLoader } from '~/server/utils/better-auth-stripe'
import { planSubscriptionItem, readStripeCatalog, recurringPriceAmount, selectMeteredPrices } from '~/server/utils/stripe-catalog'
import { organizationAccessControl, organizationRoles } from '~/utils/organization-access'

export interface BillingEnv {
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  /** Deadline of a bounded background operation; ordinary billing calls keep SDK defaults. */
  requestSignal?: AbortSignal
}

export interface OrganizationBillingStatus {
  plan: string
  stripeCustomerId?: string
  stripeSubscriptionId?: string
  subscriptionStatus?: string
  currentPeriodEnd?: string
  cancelAtPeriodEnd?: boolean
  /** Better Auth's subscription schedule for a plan change at the end of the period. */
  stripeScheduleId?: string
  billingInterval?: 'month'
  /** The plan item's own charge, and the metered prices the subscription carries: an earlier contract may lack one added since. */
  subscriptionPrice?: { name: string; amount: number; currency: CurrencyCode; interval: 'month'; meters: BillingMeterKey[]; trial: SubscriptionTrial | null }
  /** What the plan bills by count: its active locations and live homes. */
  usage: BillingCapacity
  entitlements: EntitlementsMap
}

/** A free trial as Stripe runs it: when it ends, and what Stripe does then when no card is on file. */
export interface SubscriptionTrial {
  end: string
  withoutPaymentMethod: Stripe.Subscription.TrialSettings.EndBehavior.MissingPaymentMethod
}

const billingAuthorizationOptions = {
  ac: organizationAccessControl,
  roles: organizationRoles,
} as const

export function getStripe(env: BillingEnv): Stripe {
  if (!env.STRIPE_SECRET_KEY) throw new Error('Stripe secret key not configured')
  return createStripeClient(env.STRIPE_SECRET_KEY, 'canonical', env.requestSignal)
}


export async function getOrganizationBillingStatus(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
): Promise<OrganizationBillingStatus> {
  const adapter = await organizationAdapter(env)
  // One read of the subscription rows answers both questions asked of them
  // here: which subscription this organization is billed on, and which plan it
  // is entitled to. Those are different rules — a past_due row is the current
  // subscription but grants nothing — so both are applied to the same rows
  // rather than read twice.
  const [organization, subscriptionsByOrganization, locations, homes] = await Promise.all([
    adapter.findOrganizationById(organizationId),
    readOrganizationSubscriptions(env, [organizationId]),
    countActiveLocations(db, organizationId),
    countActiveHomes(db, organizationId),
  ])
  if (!organization) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
  const subscriptions = subscriptionsByOrganization.get(organizationId) ?? []
  const current = subscriptions.filter(row => row.status !== 'canceled' && row.status !== 'incomplete_expired')
  if (current.length > 1) throw new Error('Organization has multiple current subscriptions')
  const subscription = current[0]
  const plan = planFromSubscriptions(organizationId, subscriptions)
  const customerId = 'stripeCustomerId' in organization && typeof organization.stripeCustomerId === 'string'
    ? organization.stripeCustomerId
    : undefined
  if (subscription?.stripeCustomerId && subscription.stripeCustomerId !== customerId) {
    throw new Error('Subscription customer does not match its organization')
  }
  return {
    plan,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription?.stripeSubscriptionId ?? undefined,
    subscriptionStatus: subscription?.status ?? undefined,
    currentPeriodEnd: subscription?.periodEnd?.toISOString(),
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd,
    stripeScheduleId: subscription?.stripeScheduleId ?? undefined,
    billingInterval: billingInterval(subscription?.billingInterval),
    usage: { plan, locations, homes },
    entitlements: getPlanEntitlements(plan),
  }
}


/** Explicit dashboard price read: the plan item's own charge, as Stripe bills it. */
export async function getOrganizationSubscriptionPrice(
  env: CloudflareEnv,
  status: OrganizationBillingStatus,
): Promise<OrganizationBillingStatus['subscriptionPrice']> {
  if (!status.stripeSubscriptionId) return undefined
  const native = await getStripe(env).subscriptions.retrieve(status.stripeSubscriptionId, { expand: ['items.data.price.product', 'items.data.price.tiers'] })
  const customerId = typeof native.customer === 'string' ? native.customer : native.customer.id
  if (customerId !== status.stripeCustomerId) throw new Error('Stripe subscription customer does not match its organization')
  const item = planSubscriptionItem(native)
  const product = item.price.product
  if (typeof product === 'string' || product.deleted) throw new Error('Stripe subscription product is unavailable')
  if (status.plan !== 'free' && product.metadata.plan_id !== status.plan) throw new Error('Stripe subscription plan does not match Better Auth')
  const interval = billingInterval(item.price.recurring?.interval)
  if (!interval || item.price.recurring?.interval_count !== 1) throw new Error('Stripe subscription has an unsupported billing interval')
  const currency = item.price.currency.toUpperCase()
  if (!isCurrencyCode(currency)) throw new Error(`Stripe subscription has unsupported currency ${item.price.currency}`)
  return { name: product.name, amount: recurringPriceAmount(item.price, item.quantity), currency, interval, meters: subscriptionMeters(native), trial: subscriptionTrial(native) }
}

/** The subscription's free trial while it is in one. */
function subscriptionTrial(native: Stripe.Subscription): SubscriptionTrial | null {
  if (native.status !== 'trialing') return null
  if (!native.trial_end || !native.trial_settings) throw new Error(`Stripe subscription ${native.id} is trialing without its trial end and settings`)
  return { end: new Date(native.trial_end * 1000).toISOString(), withoutPaymentMethod: native.trial_settings.end_behavior.missing_payment_method }
}

/** The metered prices a subscription carries, read from its items' products (expanded): one from before a meter was added lacks it. */
function subscriptionMeters(native: Stripe.Subscription): BillingMeterKey[] {
  return BILLING_METER_KEYS.filter(key => native.items.data.some(row => typeof row.price.product !== 'string' && !row.price.product.deleted && row.price.product.metadata.product_family === key))
}

/** Every plan is monthly: a subscription on any other interval is not one KrabiClaw sells. */
function billingInterval(value: string | undefined): 'month' | undefined {
  if (value === undefined || value === 'month') return value
  throw new Error(`Subscription billing interval ${value} is not a plan interval`)
}

// Only an active location is on the site, so only an active one is billed. A
// location a home (a stay product) is at is the home's, not a location: the
// home is billed in its place while it is live.
const HOME_LOCATIONS_SQL = "SELECT c.location_id FROM product_stay_configs c JOIN products p ON p.id = c.product_id WHERE p.organization_id = ? AND p.kind = 'stay'"
const ACTIVE_LOCATIONS_SQL = `SELECT COUNT(*) FROM business_locations l WHERE l.organization_id = ? AND l.status = 'active' AND l.id NOT IN (${HOME_LOCATIONS_SQL})`

/**
 * Whether the stay product `alias` is a live home, the one definition billing,
 * the plan's limit and every home's `live` read: an active home at its active
 * location that is published on the site or syncs with Airbnb (its Channex
 * mapping is enabled). Any other home is a draft, which is free.
 */
export function liveHomeSql(alias: string): string {
  return `(${alias}.kind = 'stay' AND ${alias}.active = 1
    AND EXISTS (SELECT 1 FROM product_stay_configs lc JOIN business_locations ll ON ll.organization_id = lc.organization_id AND ll.id = lc.location_id
      WHERE lc.organization_id = ${alias}.organization_id AND lc.product_id = ${alias}.id AND ll.status = 'active')
    AND (EXISTS (SELECT 1 FROM product_publications lp WHERE lp.organization_id = ${alias}.organization_id AND lp.product_id = ${alias}.id AND lp.published = 1)
      OR EXISTS (SELECT 1 FROM product_channel_mappings lm WHERE lm.organization_id = ${alias}.organization_id AND lm.product_id = ${alias}.id AND lm.enabled = 1)))`
}

const ACTIVE_HOMES_SQL = `SELECT COUNT(*) FROM products p WHERE p.organization_id = ? AND ${liveHomeSql('p')}`
const DRAFT_HOMES_SQL = `SELECT COUNT(*) FROM products p WHERE p.organization_id = ? AND p.kind = 'stay' AND NOT ${liveHomeSql('p')}`

/** The locations a plan bills: every active location that is not a home's. */
export async function countActiveLocations(db: DbClient, organizationId: string): Promise<number> {
  const row = await queryFirst<{ locations: number }>(db, `SELECT (${ACTIVE_LOCATIONS_SQL}) AS locations`, [organizationId, organizationId])
  if (!row) throw new Error('Billing usage could not be read')
  return row.locations
}

/** The homes a plan bills: every live home. */
export async function countActiveHomes(db: DbClient, organizationId: string): Promise<number> {
  const row = await queryFirst<{ homes: number }>(db, `SELECT (${ACTIVE_HOMES_SQL}) AS homes`, [organizationId])
  if (!row) throw new Error('Billing usage could not be read')
  return row.homes
}

/**
 * What a plan bills by count: its active locations and its live homes. A
 * paid plan bills those past the included ones at the end of the period;
 * Basic includes its locations and homes and no more.
 */
export interface BillingCapacity {
  plan: string
  locations: number
  homes: number
}

/**
 * Report the organization's active locations and live homes to their Stripe
 * meters. Each meter keeps the last count reported in the billing period, and
 * the subscription's metered price bills it on the invoice at the end of the
 * period, so there is no charge in the middle of one. Called after every write
 * that can change a count and at each subscription change, which starts each
 * period with its counts. An organization on Basic has no subscription and
 * nothing to report. A subscription from before homes were metered carries no
 * homes price: Stripe keeps the count and bills nothing for it.
 * A caller completing an already committed write supplies that context so a
 * failed report tells it the write is saved and still needs completion.
 */
export async function reportBillingUsage(env: CloudflareEnv, db: DbClient, organizationId: string, context?: { committed: true }): Promise<void> {
  try {
    // An organization that never had a Stripe customer has never subscribed.
    const organization = await queryFirst<{ customer: string | null }>(db, 'SELECT "stripeCustomerId" AS customer FROM organization WHERE id=?', [organizationId])
    if (!organization?.customer) return
    const rows = (await readOrganizationSubscriptions(env, [organizationId])).get(organizationId) ?? []
    const billed = rows.filter(row => row.status === 'active' || row.status === 'trialing' || row.status === 'past_due')
    if (billed.length > 1) throw new Error(`Organization ${organizationId} has more than one billed subscription`)
    const subscription = billed[0]
    if (!subscription) return
    if (subscription.stripeCustomerId !== organization.customer) throw new Error(`Subscription ${subscription.id} does not belong to its organization's Stripe customer`)
    const stripe = getStripe(env)
    const [locations, homes] = await Promise.all([countActiveLocations(db, organizationId), countActiveHomes(db, organizationId)])
    for (const [meter, value] of [[BILLING_METERS.locations, locations], [BILLING_METERS.homes, homes]] as const) {
      await stripe.billing.meterEvents.create({
        event_name: meter.eventName,
        payload: { stripe_customer_id: subscription.stripeCustomerId, value: String(value) },
      })
    }
  } catch (cause) {
    if (!context?.committed) throw cause
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new HTTPError({ statusCode: 503, message: `The changes were saved, but their billing usage report did not complete. ${reason}`,
      data: { code: 'POST_WRITE_COMPLETION_FAILED', field: 'billing_usage', committed: true, organization_id: organizationId, reason }, cause })
  }
}

/** A subscription created or changed, a new period among them: its organization's counts are reported again. */
export async function reportBillingUsageForSubscriptionEvent(env: CloudflareEnv, db: DbClient, event: Stripe.Event): Promise<void> {
  if (event.account || (event.type !== 'customer.subscription.created' && event.type !== 'customer.subscription.updated')) return
  const subscription = event.data.object
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
  const organizations = await queryAll<{ id: string }>(db, 'SELECT id FROM organization WHERE "stripeCustomerId"=?', [customerId])
  if (organizations.length > 1) throw new Error('Stripe customer belongs to more than one organization')
  if (organizations[0]) await reportBillingUsage(env, db, organizations[0].id)
}

// A write batch ends with guards that abort it — a NOT NULL failure on a
// column no other statement clears — when it leaves more active locations or
// live homes than the bound. D1 rolls the batch back whole.
function locationGuard(organizationId: string, bound: number): BatchQuery {
  return {
    query: `UPDATE business_locations SET status = NULL WHERE organization_id = ? AND status = 'active' AND (${ACTIVE_LOCATIONS_SQL}) > ?`,
    params: [organizationId, organizationId, organizationId, bound],
  }
}

function homeGuard(organizationId: string, bound: number): BatchQuery {
  return {
    query: `UPDATE products SET active = NULL WHERE organization_id = ? AND kind = 'stay' AND active = 1 AND (${ACTIVE_HOMES_SQL}) > ?`,
    params: [organizationId, organizationId, bound],
  }
}

type GuardFailure = 'locations' | 'homes' | null

function guardFailure(error: unknown): GuardFailure {
  const message = error instanceof Error ? error.message : String(error)
  if (/NOT NULL constraint failed: business_locations\.status/.test(message)) return 'locations'
  if (/NOT NULL constraint failed: products\.active/.test(message)) return 'homes'
  return null
}

export interface CapacityRefusal {
  status: 402
  data: { error: string; code: 'LOCATION_LIMIT'; locations: { used: number; covered: number } }
    | { error: string; code: 'HOME_LIMIT'; homes: { used: number; covered: number } }
}

/** The refusal for a location past what Basic includes. */
export function locationLimit(used: number): CapacityRefusal {
  return {
    status: 402,
    data: {
      error: `Basic includes ${INCLUDED_LOCATIONS} locations. Choose Growth or Business in Billing to add more.`,
      code: 'LOCATION_LIMIT',
      locations: { used, covered: INCLUDED_LOCATIONS },
    },
  }
}

/** The refusal for a home past what Basic includes. */
export function homeLimit(used: number): CapacityRefusal {
  return {
    status: 402,
    data: {
      error: `Basic includes ${INCLUDED_HOMES} homes. Choose Growth or Business in Billing to add more.`,
      code: 'HOME_LIMIT',
      homes: { used, covered: INCLUDED_HOMES },
    },
  }
}

export function capacityRefusalError(refusal: CapacityRefusal): HTTPError {
  return new HTTPError({ statusCode: refusal.status, statusMessage: refusal.data.error, data: refusal.data })
}

/** A refusal thrown by `executeWithinCapacity`, for callers that answer with a result instead. */
export function capacityRefusalOf(error: unknown): CapacityRefusal | null {
  if (!(error instanceof HTTPError) || error.status !== 402) return null
  const data = error.data as CapacityRefusal['data'] | undefined
  return data?.code === 'LOCATION_LIMIT' || data?.code === 'HOME_LIMIT' ? { status: 402, data } : null
}

/** The most homes one quote may ask about: an Airbnb account's listings, not a count to bill. */
export const MAX_HOMES_QUOTE = 500

/**
 * What adding homes costs, as the host sees it before adding them and as the
 * capacity check decides it: the plan, the homes in use now, the included
 * ones and the price of each further one; for the `count` being added, how
 * many fall beyond the included ones and what they add to the bill, and
 * whether the plan allows them at all; and the end of the current period,
 * when a paid plan's invoice bills them. Nothing is prorated: a meter bills
 * the count at the end of the period.
 */
export interface HomesQuote {
  plan: string
  currency: 'USD'
  /** `additional_price_minor` is what each home past the included ones costs: 0 on a paid subscription from before homes were priced. */
  /** `used` counts live homes; `drafts` the homes not live, which are free. */
  homes: { used: number; drafts: number; included: number; additional_price_minor: number; amount_minor: number }
  /** `count` is homes about to go live. */
  adding: { count: number; additional_homes: number; amount_minor: number; allowed: boolean }
  /** `trial_end` is when a subscription's free trial ends, `null` when it has none: usage in a trial is not billed. */
  billing: { period_end: string | null; trial_end: string | null; prorated: false }
}

/** The `adding` query of a homes quote, homes about to go live: absent is one home; otherwise an integer from 0 to the most one quote covers. */
export function parseHomesAdding(value: unknown): number {
  if (value === undefined) return 1
  const count = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN
  if (!Number.isSafeInteger(count) || count > MAX_HOMES_QUOTE) {
    throw new HTTPError({ statusCode: 422, statusMessage: `adding must be a whole number from 0 to ${MAX_HOMES_QUOTE}`, data: { code: 'INVALID_QUERY', field: 'adding' } })
  }
  return count
}

/** Homes beyond the `included` ones, priced: what `used` homes cost now, or what `adding` more would add. */
function additionalHomes(included: number, used: number, adding: number): number {
  return Math.max(0, used + adding - included) - Math.max(0, used - included)
}

/**
 * A homes price as Stripe bills it: its graduated tiers at no charge are the
 * included homes, and the open-ended tier after them is each further home.
 * Any other shape is not one KrabiClaw sells and fails visibly.
 */
function homesPriceTerms(price: Stripe.Price): { included: number; additional: number } {
  const tiers = price.tiers
  if (price.billing_scheme !== 'tiered' || price.tiers_mode !== 'graduated' || !tiers?.length) throw new Error(`Stripe homes price ${price.id} is not read with graduated tiers`)
  const free = tiers.slice(0, -1)
  const further = tiers.at(-1)!
  if (free.some(tier => tier.up_to === null || tier.unit_amount !== 0 || (tier.flat_amount ?? 0) !== 0)
    || further.up_to !== null || !Number.isSafeInteger(further.unit_amount) || (further.flat_amount ?? 0) !== 0) {
    throw new Error(`Stripe homes price ${price.id} must include homes at no charge and price each further one`)
  }
  return { included: free.at(-1)?.up_to ?? 0, additional: further.unit_amount! }
}

/**
 * Whether this organization's plan allows `adding` more homes: Basic refuses
 * past the homes it includes, a paid plan never does. The capacity check and
 * the quote both decide by this, so a quote that allows the homes is one the
 * write will allow. Reads the subscription rows and nothing from Stripe.
 */
export async function homeAllowance(env: CloudflareEnv, db: DbClient, organizationId: string, adding: number) {
  const [used, subscriptions] = await Promise.all([countActiveHomes(db, organizationId), readOrganizationSubscriptions(env, [organizationId])])
  const rows = subscriptions.get(organizationId) ?? []
  const plan = planFromSubscriptions(organizationId, rows)
  const paid = isKnownRecurringPlan(plan)
  return { plan, used, subscription: paid ? entitlingSubscription(organizationId, rows) : null, allowed: paid || used + adding <= INCLUDED_HOMES }
}

/**
 * The quote for adding `adding` homes to this organization, priced as Stripe
 * bills them. A paid plan bills each home past the included ones at the end of
 * the period through the homes price on its subscription, read with its tiers;
 * a subscription from before homes were priced carries none and is charged
 * nothing for them, so its price per home is 0. A subscription in its free
 * trial bills no usage until the trial ends, which `trial_end` says. Basic has
 * no period and is quoted the published homes price from the Stripe catalog,
 * what the homes past its included ones cost once Growth or Business is chosen.
 */
export async function homesQuote(env: CloudflareEnv, db: DbClient, organizationId: string, adding: number): Promise<HomesQuote> {
  const [{ plan, used, subscription, allowed }, drafts] = await Promise.all([homeAllowance(env, db, organizationId, adding), queryFirst<{ homes: number }>(db, `SELECT (${DRAFT_HOMES_SQL}) AS homes`, [organizationId])])
  if (!drafts) throw new Error('Billing usage could not be read')
  const stripe = getStripe(env)
  let terms: { included: number; additional: number }
  let trialEnd: string | null = null
  if (subscription) {
    if (!subscription.stripeSubscriptionId) throw new Error(`Subscription ${subscription.id} has no Stripe subscription`)
    const native = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId, { expand: ['items.data.price.product', 'items.data.price.tiers'] })
    const customerId = typeof native.customer === 'string' ? native.customer : native.customer.id
    if (customerId !== subscription.stripeCustomerId) throw new Error('Stripe subscription customer does not match its organization')
    const homes = native.items.data.find(row => typeof row.price.product !== 'string' && !row.price.product.deleted && row.price.product.metadata.product_family === 'homes')
    terms = homes ? homesPriceTerms(homes.price) : { included: INCLUDED_HOMES, additional: 0 }
    trialEnd = subscriptionTrial(native)?.end ?? null
  } else {
    terms = { included: INCLUDED_HOMES, additional: homesPriceTerms(selectMeteredPrices(await readStripeCatalog(stripe)).homes).additional }
  }
  const added = additionalHomes(terms.included, used, adding)
  return {
    plan,
    currency: 'USD',
    homes: { used, drafts: drafts.homes, included: terms.included, additional_price_minor: terms.additional, amount_minor: additionalHomes(terms.included, 0, used) * terms.additional },
    adding: { count: adding, additional_homes: added, amount_minor: added * terms.additional, allowed },
    billing: { period_end: subscription?.periodEnd?.toISOString() ?? null, trial_end: trialEnd, prorated: false },
  }
}

/**
 * Refuse, before any provider is asked to sync it, the home going live that
 * Basic does not include: Activate asks here before Channex maps the listing.
 * A home already live adds none. The allowance the quote reports decides; the
 * write that makes the home live is still guarded by `executeWithinCapacity`.
 */
export async function requireHomeCapacity(env: CloudflareEnv, db: DbClient, organizationId: string, productId: string): Promise<void> {
  const live = await queryFirst<{ live: number }>(db, `SELECT ${liveHomeSql('p')} AS live FROM products p WHERE p.organization_id = ? AND p.id = ?`, [organizationId, productId])
  if (!live) throw new HTTPError({ statusCode: 404, statusMessage: 'Home not found', data: { code: 'HOME_NOT_FOUND' } })
  if (live.live) return
  const { used, allowed } = await homeAllowance(env, db, organizationId, 1)
  if (!allowed) throw capacityRefusalError(homeLimit(used))
}

/**
 * Run a write that may make a location active or a home live: creating one,
 * turning one back on, publishing a home or enabling its Airbnb sync. It runs first guarded at the active counts now, which
 * reads nothing from billing, so a write that adds none never depends on the
 * plan. Only a write that adds one reads the plan: a paid plan bills it, so it
 * runs again unguarded; Basic runs it again guarded at the counts it includes
 * and refuses past them with the 402 naming what is past. The first attempt
 * was rolled back whole, so the second is the only write. The counts are then
 * reported to Stripe. A location written as a home's (`home`) is not guarded
 * as a location: its home's write is.
 */
export async function executeWithinCapacity(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
  writes: BatchQuery[],
  options: { operation?: string; action: string; home?: boolean },
): Promise<D1Result[]> {
  const [locations, homes] = await Promise.all([countActiveLocations(db, organizationId), countActiveHomes(db, organizationId)])
  const guards = (locationBound: number, homeBound: number) => [...(options.home ? [] : [locationGuard(organizationId, locationBound)]), homeGuard(organizationId, homeBound)]
  let results: D1Result[] | null = null
  try {
    results = await executeBatch(db, [...writes, ...guards(locations, homes)], { operation: options.operation })
  } catch (error) {
    if (!guardFailure(error)) throw error
  }
  if (!results) {
    const subscriptions = await readOrganizationSubscriptions(env, [organizationId])
    if (isKnownRecurringPlan(planFromSubscriptions(organizationId, subscriptions.get(organizationId) ?? []))) {
      results = await executeBatch(db, writes, { operation: options.operation })
    } else {
      try {
        results = await executeBatch(db, [...writes, ...guards(Math.max(locations, INCLUDED_LOCATIONS), Math.max(homes, INCLUDED_HOMES))], { operation: options.operation })
      } catch (error) {
        const failed = guardFailure(error)
        if (!failed) throw error
        throw capacityRefusalError(failed === 'homes' ? homeLimit(homes) : locationLimit(locations))
      }
    }
  }
  await reportBillingUsage(env, db, organizationId, { committed: true })
  return results
}

// ── Organization entitlements ─────────────────────────────────────────────────

export async function hasOrganizationEntitlement(
  env: CloudflareEnv,
  organizationId: string,
  key: string,
): Promise<boolean> {
  return (await getOrganizationEntitlements(env, organizationId))[key] === true
}

// ── Stripe helpers ────────────────────────────────────────────────────────────

/** The plan a Better Auth subscription schedule moves to at the end of the period, read from Stripe. */
export async function scheduledPlanChange(env: CloudflareEnv, scheduleId: string): Promise<{ plan: string; at: string } | null> {
  const stripe = getStripe(env)
  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId)
  if (schedule.status !== 'active' && schedule.status !== 'not_started') return null
  const next = schedule.phases.find(phase => phase.start_date * 1000 > Date.now())
  if (!next) return null
  // The phase also carries the metered items and any service item; the plan is the item on a plan price.
  const plans = await createStripePlanLoader(stripe, env)()
  const priceIds = next.items.map(item => typeof item.price === 'string' ? item.price : item.price.id)
  const matched = plans.filter(row => priceIds.includes(row.priceId!))
  if (new Set(matched.map(row => row.name)).size !== 1) throw new Error(`Subscription schedule ${scheduleId} does not move to exactly one plan in the catalog`)
  const plan = matched[0]!
  return { plan: plan.name.toLowerCase(), at: new Date(next.start_date * 1000).toISOString() }
}

export async function requireBillingAccess(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
  userId: string,
): Promise<void> {
  void db
  const adapter = await organizationAdapter(env)
  const membership = await adapter.findMemberByOrgId({
    userId,
    organizationId,
  })
  if (!membership) throw new HTTPError({ statusCode: 403, statusMessage: 'Access denied: Not a member of this organization' })
  if (!await hasBillingUpdatePermission(organizationId, String(membership.role))) {
    throw new HTTPError({ statusCode: 403, statusMessage: 'Access denied: Only owners can manage billing' })
  }
}

export async function hasBillingUpdatePermission(organizationId: string, role: string): Promise<boolean> {
  return await hasPermission({
    organizationId,
    role,
    options: billingAuthorizationOptions,
    permissions: { billing: ['update'] },
  }, undefined as never)
}

export async function verifyStripeWebhook(
  env: BillingEnv,
  payload: string,
  signature: string,
): Promise<{ ok: true; event: Stripe.Event } | { ok: false; error: string }> {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new Error('Stripe webhook secret not configured')
  const stripe = getStripe(env)
  try {
    const event = await stripe.webhooks.constructEventAsync(payload, signature, env.STRIPE_WEBHOOK_SECRET)
    return { ok: true, event }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown Stripe webhook verification error',
    }
  }
}
