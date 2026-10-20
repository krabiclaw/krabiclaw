import type Stripe from 'stripe'
import { HTTPError } from 'nitro';
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { hasPermission } from 'better-auth/plugins'
import { organizationAdapter } from '~/server/utils/member-access'
import { getPlanEntitlements, type EntitlementsMap } from '~/server/utils/billing-entitlements'
import { getOrganizationEntitlements, planFromSubscriptions, readOrganizationSubscriptions } from '~/server/utils/billing-access'
import { BILLING_METERS, BUSINESS_PLAN_ID, INCLUDED_LOCATIONS, isKnownRecurringPlan, type BillingMeterKey } from '~/shared/billing-model'
import { isCurrencyCode, type CurrencyCode } from '~/shared/currencies'
import { createStripeClient } from '~/server/utils/stripe-client'
import { createStripePlanLoader } from '~/server/utils/better-auth-stripe'
import { planSubscriptionItem, recurringPriceAmount } from '~/server/utils/stripe-catalog'
import { organizationAccessControl, organizationRoles } from '~/utils/organization-access'

export interface BillingEnv {
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
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
  billingInterval?: 'month' | 'year'
  subscriptionPrice?: { name: string; amount: number; currency: CurrencyCode; interval: 'month' | 'year' }
  /** What the plan bills by count: the locations in use and, on Business, the rental units. */
  usage: BillingCapacity
  entitlements: EntitlementsMap
}

const billingAuthorizationOptions = {
  ac: organizationAccessControl,
  roles: organizationRoles,
} as const

export function getStripe(env: BillingEnv): Stripe {
  if (!env.STRIPE_SECRET_KEY) throw new Error('Stripe secret key not configured')
  return createStripeClient(env.STRIPE_SECRET_KEY)
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
  const [organization, subscriptionsByOrganization, counts] = await Promise.all([
    adapter.findOrganizationById(organizationId),
    readOrganizationSubscriptions(env, [organizationId]),
    readBillingUsage(db, organizationId),
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
    usage: capacityFrom(plan, counts),
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
  return { name: product.name, amount: recurringPriceAmount(item.price, item.quantity), currency, interval }
}

function billingInterval(value: string | undefined): 'month' | 'year' | undefined {
  if (value === undefined || value === 'month' || value === 'year') return value
  throw new Error(`Subscription billing interval ${value} is not a plan interval`)
}

// A rental unit is one home, counted once however many channels list it,
// while it is on sale or a connected channel still takes its stays. Closing
// its dates does not take it out; turning it off and disconnecting it does.
const RENTAL_UNIT_SQL = `p.kind = 'stay' AND (p.active = 1 OR EXISTS (SELECT 1 FROM product_channel_mappings m
  WHERE m.organization_id = p.organization_id AND m.product_id = p.id AND m.enabled = 1))`
// A location that holds homes and offers nothing else. Business bills it by
// its rental units, not as a location.
const LODGING_ONLY_SQL = `EXISTS (SELECT 1 FROM product_stay_configs c WHERE c.organization_id = l.organization_id AND c.location_id = l.id)
  AND NOT EXISTS (SELECT 1 FROM product_locations pl JOIN products p ON p.organization_id = pl.organization_id AND p.id = pl.product_id
    WHERE pl.organization_id = l.organization_id AND pl.location_id = l.id AND pl.active = 1 AND p.active = 1 AND p.kind <> 'stay')`
// Only an active location is on the site, so only an active one is counted.
const ACTIVE_LOCATIONS_SQL = "SELECT COUNT(*) FROM business_locations l WHERE l.organization_id = ? AND l.status = 'active'"
const NON_LODGING_LOCATIONS_SQL = `${ACTIVE_LOCATIONS_SQL} AND NOT (${LODGING_ONLY_SQL})`
const RENTAL_UNITS_SQL = `SELECT COUNT(*) FROM products p WHERE p.organization_id = ? AND ${RENTAL_UNIT_SQL}`

export interface BillingUsageCounts { activeLocations: number; nonLodgingLocations: number; rentalUnits: number }

/** One organization's billed usage; each `?` is its ID. */
export const BILLING_USAGE_SQL = `SELECT (${ACTIVE_LOCATIONS_SQL}) AS activeLocations,
    (${NON_LODGING_LOCATIONS_SQL}) AS nonLodgingLocations, (${RENTAL_UNITS_SQL}) AS rentalUnits`

export async function readBillingUsage(db: DbClient, organizationId: string): Promise<BillingUsageCounts> {
  const row = await queryFirst<BillingUsageCounts>(db, BILLING_USAGE_SQL, [organizationId, organizationId, organizationId])
  if (!row) throw new Error('Billing usage could not be read')
  return row
}

/**
 * What a plan bills by count. Business bills a location that holds only homes
 * by its rental units; every other plan bills every active location and no
 * units. A paid plan bills whatever is in use at the end of the period; Basic
 * includes its locations and no more.
 */
export interface BillingCapacity {
  plan: string
  billsRentalUnits: boolean
  locations: number
  rentalUnits: number | null
}

function capacityFrom(plan: string, counts: BillingUsageCounts): BillingCapacity {
  const billsRentalUnits = plan === BUSINESS_PLAN_ID
  return {
    plan,
    billsRentalUnits,
    locations: billsRentalUnits ? counts.nonLodgingLocations : counts.activeLocations,
    rentalUnits: billsRentalUnits ? counts.rentalUnits : null,
  }
}

/** Every surface that adds or reactivates a location, a home or an offering asks here first. */
export async function billingCapacity(env: CloudflareEnv, db: DbClient, organizationId: string): Promise<BillingCapacity> {
  const [subscriptions, counts] = await Promise.all([
    readOrganizationSubscriptions(env, [organizationId]),
    readBillingUsage(db, organizationId),
  ])
  return capacityFrom(planFromSubscriptions(organizationId, subscriptions.get(organizationId) ?? []), counts)
}

/**
 * Report the organization's billed counts to their Stripe meters. Each meter
 * keeps the last count reported in the billing period, and the subscription's
 * metered prices bill it on the invoice at the end of the period, so there is
 * no charge in the middle of one. Called after every write that can change a
 * count and at each subscription change, which starts each period with its
 * count. An organization on Basic has no subscription and nothing to report.
 */
export async function reportBillingUsage(env: CloudflareEnv, db: DbClient, organizationId: string): Promise<void> {
  // An organization that never had a Stripe customer has never subscribed.
  const organization = await queryFirst<{ customer: string | null }>(db, 'SELECT "stripeCustomerId" AS customer FROM organization WHERE id=?', [organizationId])
  if (!organization?.customer) return
  const rows = (await readOrganizationSubscriptions(env, [organizationId])).get(organizationId) ?? []
  const billed = rows.filter(row => row.status === 'active' || row.status === 'trialing' || row.status === 'past_due')
  if (billed.length > 1) throw new Error(`Organization ${organizationId} has more than one billed subscription`)
  const subscription = billed[0]
  if (!subscription) return
  if (subscription.stripeCustomerId !== organization.customer) throw new Error(`Subscription ${subscription.id} does not belong to its organization's Stripe customer`)
  const capacity = capacityFrom(subscription.plan, await readBillingUsage(db, organizationId))
  const stripe = getStripe(env)
  const report = (key: BillingMeterKey, value: number) => stripe.billing.meterEvents.create({
    event_name: BILLING_METERS[key].eventName,
    payload: { stripe_customer_id: subscription.stripeCustomerId!, value: String(value) },
  })
  await report('locations', capacity.locations)
  if (capacity.rentalUnits !== null) await report('rental_units', capacity.rentalUnits)
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

// A write batch ends with a guard that aborts it — a NOT NULL failure on a
// column no other statement clears — when it leaves more active locations in
// use than the bound. D1 rolls the batch back whole.
function locationGuard(organizationId: string, bound: number): BatchQuery {
  return {
    query: `UPDATE business_locations SET status = NULL WHERE organization_id = ? AND status = 'active' AND (${ACTIVE_LOCATIONS_SQL}) > ?`,
    params: [organizationId, organizationId, bound],
  }
}

/** Statements the guard adds to a batch, which a caller counts against D1's limit. */
export const CAPACITY_GUARD_STATEMENTS = 1

function isLocationGuardFailure(error: unknown): boolean {
  return /NOT NULL constraint failed: business_locations\.status/.test(error instanceof Error ? error.message : String(error))
}

export interface CapacityRefusal {
  status: 402
  data: { error: string; code: 'LOCATION_LIMIT'; locations: { used: number; covered: number } }
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

export function capacityRefusalError(refusal: CapacityRefusal): HTTPError {
  return new HTTPError({ statusCode: refusal.status, statusMessage: refusal.data.error, data: refusal.data })
}

/** A refusal thrown by `executeWithinCapacity`, for callers that answer with a result instead. */
export function capacityRefusalOf(error: unknown): CapacityRefusal | null {
  if (!(error instanceof HTTPError) || error.status !== 402) return null
  const data = error.data as CapacityRefusal['data'] | undefined
  return data?.code === 'LOCATION_LIMIT' ? { status: 402, data } : null
}

/**
 * Run a write that may change a billed count: a location, a home, or an
 * offering at a location that held only homes. It runs first guarded at the
 * locations in use now, which reads nothing from billing, so a write that adds
 * none never depends on the plan. Only a write that adds one reads the plan:
 * a paid plan bills it, so it runs again unguarded; Basic runs it again
 * guarded at the locations it includes and refuses past them with the 402
 * naming `action`. The first attempt was rolled back whole, so the second is
 * the only write. The counts are then reported to Stripe.
 */
export async function executeWithinCapacity(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
  writes: BatchQuery[],
  options: { operation?: string; action: string },
): Promise<D1Result[]> {
  const counts = await readBillingUsage(db, organizationId)
  let results: D1Result[] | null = null
  try {
    results = await executeBatch(db, [...writes, locationGuard(organizationId, counts.activeLocations)], { operation: options.operation })
  } catch (error) {
    if (!isLocationGuardFailure(error)) throw error
  }
  if (!results) {
    const capacity = await billingCapacity(env, db, organizationId)
    if (isKnownRecurringPlan(capacity.plan)) {
      results = await executeBatch(db, writes, { operation: options.operation })
    } else {
      try {
        results = await executeBatch(db, [...writes, locationGuard(organizationId, Math.max(counts.activeLocations, INCLUDED_LOCATIONS))], { operation: options.operation })
      } catch (error) {
        if (!isLocationGuardFailure(error)) throw error
        throw capacityRefusalError(locationLimit(counts.activeLocations))
      }
    }
  }
  await reportBillingUsage(env, db, organizationId)
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
