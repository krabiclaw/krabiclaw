import type Stripe from 'stripe'
import type { Subscription } from '@better-auth/stripe'
import { HTTPError } from 'nitro';
import { executeBatch, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { hasPermission } from 'better-auth/plugins'
import { organizationAdapter } from '~/server/utils/member-access'
import { getPlanEntitlements, type EntitlementsMap } from '~/server/utils/billing-entitlements'
import { entitlingSubscription, getOrganizationEntitlements, planFromSubscriptions, readOrganizationSubscriptions } from '~/server/utils/billing-access'
import { additionalLocationPrice, additionalRentalUnitPrice, BUSINESS_PLAN_ID, coveredLocations, coveredRentalUnits, INCLUDED_LOCATIONS, INCLUDED_RENTAL_UNITS, isKnownRecurringPlan } from '~/shared/billing-model'
import { isCurrencyCode, type CurrencyCode } from '~/shared/currencies'
import { createStripeClient } from '~/server/utils/stripe-client'
import { createStripePlanLoader } from '~/server/utils/better-auth-stripe'
import { isCurrentBusinessPrice, planSubscriptionItems, recurringPriceAmount } from '~/server/utils/stripe-catalog'
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
  /** The subscription is on the current Business offer, which bills rental units. */
  billsRentalUnits: boolean
  locations: BillingUsage
  /** Rental units in use against the ones the current Business offer covers; null on every other plan. */
  rentalUnits: BillingUsage | null
  /** What the current Business offer would bill this organization for today. */
  businessUsage: { locations: number; rentalUnits: number }
  entitlements: EntitlementsMap
}

/** How many of a billed thing the organization has in use, and how many its plan pays for. */
export interface BillingUsage {
  used: number
  covered: number
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
  const [organization, subscriptionsByOrganization, usage] = await Promise.all([
    adapter.findOrganizationById(organizationId),
    readOrganizationSubscriptions(env, [organizationId]),
    readBillingUsage(db, organizationId),
  ])
  if (!organization) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
  const subscriptions = subscriptionsByOrganization.get(organizationId) ?? []
  const current = subscriptions.filter(row => row.status !== 'canceled' && row.status !== 'incomplete_expired')
  if (current.length > 1) throw new Error('Organization has multiple current subscriptions')
  const subscription = current[0]
  const entitling = entitlingSubscription(organizationId, subscriptions)
  const plan = planFromSubscriptions(organizationId, subscriptions)
  const capacity = await capacityFrom(env, plan, entitling, usage)
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
    billsRentalUnits: capacity.billsRentalUnits,
    locations: capacity.locations,
    rentalUnits: capacity.rentalUnits,
    businessUsage: { locations: usage.nonLodgingLocations, rentalUnits: usage.rentalUnits },
    entitlements: getPlanEntitlements(plan),
  }
}


/** Explicit dashboard price read; entitlement and location checks need only Better Auth's state. */
export async function getOrganizationSubscriptionPrice(
  env: CloudflareEnv,
  status: OrganizationBillingStatus,
): Promise<OrganizationBillingStatus['subscriptionPrice']> {
  if (!status.stripeSubscriptionId) return undefined
  const native = await getStripe(env).subscriptions.retrieve(status.stripeSubscriptionId, { expand: ['items.data.price.product', 'items.data.price.tiers'] })
  const customerId = typeof native.customer === 'string' ? native.customer : native.customer.id
  if (customerId !== status.stripeCustomerId) throw new Error('Stripe subscription customer does not match its organization')
  const { plan: item, rentalUnits } = planSubscriptionItems(native)
  const product = item.price.product
  if (typeof product === 'string' || product.deleted) throw new Error('Stripe subscription product is unavailable')
  if (status.plan !== 'free' && product.metadata.plan_id !== status.plan) throw new Error('Stripe subscription plan does not match Better Auth')
  const interval = billingInterval(item.price.recurring?.interval)
  if (!interval || item.price.recurring?.interval_count !== 1) throw new Error('Stripe subscription has an unsupported billing interval')
  const currency = item.price.currency.toUpperCase()
  if (!isCurrencyCode(currency)) throw new Error(`Stripe subscription has unsupported currency ${item.price.currency}`)
  const amount = recurringPriceAmount(item.price, item.quantity) + (rentalUnits ? recurringPriceAmount(rentalUnits.price, rentalUnits.quantity) : 0)
  return { name: product.name, amount, currency, interval }
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
// A location that holds homes and offers nothing else. The current Business
// offer bills it by its rental units, not as a location.
const LODGING_ONLY_SQL = `EXISTS (SELECT 1 FROM product_stay_configs c WHERE c.organization_id = l.organization_id AND c.location_id = l.id)
  AND NOT EXISTS (SELECT 1 FROM product_locations pl JOIN products p ON p.organization_id = pl.organization_id AND p.id = pl.product_id
    WHERE pl.organization_id = l.organization_id AND pl.location_id = l.id AND pl.active = 1 AND p.active = 1 AND p.kind <> 'stay')`
// Only an active location is on the site, so only an active one uses a slot.
const ACTIVE_LOCATIONS_SQL = "SELECT COUNT(*) FROM business_locations l WHERE l.organization_id = ? AND l.status = 'active'"
const NON_LODGING_LOCATIONS_SQL = `${ACTIVE_LOCATIONS_SQL} AND NOT (${LODGING_ONLY_SQL})`
const RENTAL_UNITS_SQL = `SELECT COUNT(*) FROM products p WHERE p.organization_id = ? AND ${RENTAL_UNIT_SQL}`

export interface BillingUsageCounts { activeLocations: number; nonLodgingLocations: number; rentalUnits: number }

export async function readBillingUsage(db: DbClient, organizationId: string): Promise<BillingUsageCounts> {
  const row = await queryFirst<BillingUsageCounts>(db, `SELECT (${ACTIVE_LOCATIONS_SQL}) AS activeLocations,
    (${NON_LODGING_LOCATIONS_SQL}) AS nonLodgingLocations, (${RENTAL_UNITS_SQL}) AS rentalUnits`, [organizationId, organizationId, organizationId])
  if (!row) throw new Error('Billing usage could not be read')
  return row
}

/**
 * What the organization's plan pays for against what it uses. On the current
 * Business offer a location holding only homes is billed by its rental units;
 * every other plan and contract bills every active location and no units.
 */
export interface BillingCapacity {
  plan: string
  billsRentalUnits: boolean
  locations: BillingUsage
  rentalUnits: BillingUsage | null
}

/**
 * The capacity of a Better Auth subscription. Only a Business subscription
 * needs Stripe: whether it is on the current offer, and how many additional
 * rental units it pays for, are its items, which Better Auth does not record.
 */
async function capacityFrom(env: CloudflareEnv, plan: string, entitling: Subscription | null, usage: BillingUsageCounts): Promise<BillingCapacity> {
  const locations = (used: number) => ({ used, covered: coveredLocations(plan, entitling?.seats) })
  if (plan !== BUSINESS_PLAN_ID) return { plan, billsRentalUnits: false, locations: locations(usage.activeLocations), rentalUnits: null }
  if (!entitling?.stripeSubscriptionId) throw new Error('Business subscription has no Stripe subscription')
  const native = await getStripe(env).subscriptions.retrieve(entitling.stripeSubscriptionId, { expand: ['items.data.price.product', 'items.data.price.tiers'] })
  const items = planSubscriptionItems(native)
  if (!isCurrentBusinessPrice(items.plan.price)) return { plan, billsRentalUnits: false, locations: locations(usage.activeLocations), rentalUnits: null }
  return {
    plan,
    billsRentalUnits: true,
    locations: locations(usage.nonLodgingLocations),
    rentalUnits: { used: usage.rentalUnits, covered: coveredRentalUnits(items.rentalUnits?.quantity ?? 0) },
  }
}

/** Every surface that adds or reactivates a location, a home or an offering asks here first. */
export async function billingCapacity(env: CloudflareEnv, db: DbClient, organizationId: string): Promise<BillingCapacity> {
  const [subscriptions, usage] = await Promise.all([
    readOrganizationSubscriptions(env, [organizationId]),
    readBillingUsage(db, organizationId),
  ])
  const rows = subscriptions.get(organizationId) ?? []
  return await capacityFrom(env, planFromSubscriptions(organizationId, rows), entitlingSubscription(organizationId, rows), usage)
}

// A write batch ends with guards that abort it — a NOT NULL failure on a
// column no other statement clears — when it leaves more billed locations or
// rental units in use than the bound. D1 rolls the batch back whole.
function usageGuards(organizationId: string, bounds: { activeLocations?: number; nonLodgingLocations?: number; rentalUnits?: number }): BatchQuery[] {
  const location = (sql: string, bound: number) => ({
    query: `UPDATE business_locations SET status = NULL WHERE organization_id = ? AND status = 'active' AND (${sql}) > ?`,
    params: [organizationId, organizationId, bound],
  })
  return [
    ...(bounds.activeLocations === undefined ? [] : [location(ACTIVE_LOCATIONS_SQL, bounds.activeLocations)]),
    ...(bounds.nonLodgingLocations === undefined ? [] : [location(NON_LODGING_LOCATIONS_SQL, bounds.nonLodgingLocations)]),
    ...(bounds.rentalUnits === undefined ? [] : [{
      query: `UPDATE products SET kind = NULL WHERE organization_id = ? AND kind = 'stay' AND (${RENTAL_UNITS_SQL}) > ?`,
      params: [organizationId, organizationId, bounds.rentalUnits],
    }]),
  ]
}

/** Statements the guards add to a batch, which a caller counts against D1's limit. */
export const CAPACITY_GUARD_STATEMENTS = 3

/**
 * The guards at what the plan covers. The bound is never below what was in use
 * before, so an organization already past its plan (after a downgrade) can
 * still make every change that adds nothing.
 */
export function capacityGuards(organizationId: string, capacity: BillingCapacity): BatchQuery[] {
  return usageGuards(organizationId, {
    [capacity.billsRentalUnits ? 'nonLodgingLocations' : 'activeLocations']: Math.max(capacity.locations.used, capacity.locations.covered),
    ...(capacity.rentalUnits ? { rentalUnits: Math.max(capacity.rentalUnits.used, capacity.rentalUnits.covered) } : {}),
  })
}

function isUsageGuardFailure(error: unknown): 'locations' | 'rental_units' | null {
  const message = error instanceof Error ? error.message : String(error)
  if (/NOT NULL constraint failed: business_locations\.status/.test(message)) return 'locations'
  if (/NOT NULL constraint failed: products\.kind/.test(message)) return 'rental_units'
  return null
}

export interface CapacityRefusal {
  status: 402
  data: { error: string; code: 'LOCATION_LIMIT' | 'RENTAL_UNIT_LIMIT'; locations?: BillingUsage; rental_units?: BillingUsage }
}

/** The refusal for one more billed location, naming the action it stopped. */
export function locationLimit(capacity: BillingCapacity, action: string): CapacityRefusal {
  const { used, covered } = capacity.locations
  return {
    status: 402,
    data: {
      error: !isKnownRecurringPlan(capacity.plan)
        ? `Basic includes ${INCLUDED_LOCATIONS} locations. Choose Growth or Business in Billing to add more.`
        : capacity.billsRentalUnits
          ? `Your plan covers ${covered} locations besides those with only rental units. Add a location to your plan in Billing (${INCLUDED_LOCATIONS} included, then ${additionalLocationPrice()}), then ${action}.`
          : `Your plan covers ${covered} locations. Add a location to your plan in Billing (${INCLUDED_LOCATIONS} included, then ${additionalLocationPrice()}), then ${action}.`,
      code: 'LOCATION_LIMIT',
      locations: { used, covered },
    },
  }
}

/** The refusal for one more rental unit on the current Business offer. */
export function rentalUnitLimit(capacity: BillingCapacity, action: string): CapacityRefusal {
  if (!capacity.rentalUnits) throw new Error('Only the current Business offer limits rental units')
  const { used, covered } = capacity.rentalUnits
  return {
    status: 402,
    data: {
      error: `Your plan covers ${covered} rental units. Add rental units to your plan in Billing (${INCLUDED_RENTAL_UNITS} included, then ${additionalRentalUnitPrice()}), then ${action}.`,
      code: 'RENTAL_UNIT_LIMIT',
      rental_units: { used, covered },
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
  return data?.code === 'LOCATION_LIMIT' || data?.code === 'RENTAL_UNIT_LIMIT' ? { status: 402, data } : null
}

/**
 * Run a write that may add a billed location or rental unit: a new location,
 * a home, or an offering at a location that held only homes. It runs first
 * guarded at what is in use now, which reads nothing from billing, so a write
 * that adds nothing never depends on the plan. Only a write that adds one
 * reads the plan and runs again, guarded at what the plan covers; the first
 * attempt was rolled back whole, so the second is the only write. Past the
 * plan, it throws the 402 refusal naming `action`; any other failure is
 * rethrown as it is.
 *
 * `guardsFor` narrows the guards on the second run (see createLocation).
 */
export async function executeWithinCapacity(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
  writes: BatchQuery[],
  options: { operation?: string; action: string; guardsFor?: (capacity: BillingCapacity) => BatchQuery[] },
): Promise<D1Result[]> {
  const usage = await readBillingUsage(db, organizationId)
  try {
    return await executeBatch(db, [...writes, ...usageGuards(organizationId, usage)], { operation: options.operation })
  } catch (error) {
    if (!isUsageGuardFailure(error)) throw error
  }
  const capacity = await billingCapacity(env, db, organizationId)
  try {
    return await executeBatch(db, [...writes, ...(options.guardsFor ?? (value => capacityGuards(organizationId, value)))(capacity)], { operation: options.operation })
  } catch (error) {
    const failed = isUsageGuardFailure(error)
    if (!failed) throw error
    throw capacityRefusalError(failed === 'locations' ? locationLimit(capacity, options.action) : rentalUnitLimit(capacity, options.action))
  }
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
  // The phase also carries any service or rental-unit item; the plan is the item on a plan price.
  const plans = await createStripePlanLoader(stripe, env)()
  const priceIds = next.items.map(item => typeof item.price === 'string' ? item.price : item.price.id)
  const matched = plans.filter(row => priceIds.some(id => row.priceId === id || row.annualDiscountPriceId === id))
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
