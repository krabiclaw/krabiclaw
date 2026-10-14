import type Stripe from 'stripe'
import { HTTPError } from 'nitro';
import { queryFirst, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { hasPermission } from 'better-auth/plugins'
import { organizationAdapter } from '~/server/utils/member-access'
import { getPlanEntitlements, type EntitlementsMap } from '~/server/utils/billing-entitlements'
import { entitlingSubscription, getOrganizationEntitlements, planFromSubscriptions, readOrganizationSubscriptions } from '~/server/utils/billing-access'
import { coveredLocations } from '~/shared/billing-model'
import { createStripeClient } from '~/server/utils/stripe-client'
import { createStripePlanLoader } from '~/server/utils/better-auth-stripe'
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
  locations: OrganizationLocations
  entitlements: EntitlementsMap
}

/** How many locations the organization has, and how many its plan pays for. */
export interface OrganizationLocations {
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
  const [organization, subscriptionsByOrganization, used] = await Promise.all([
    adapter.findOrganizationById(organizationId),
    readOrganizationSubscriptions(env, [organizationId]),
    countOrganizationLocations(db, organizationId),
  ])
  if (!organization) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
  const subscriptions = subscriptionsByOrganization.get(organizationId) ?? []
  const current = subscriptions.filter(row => row.status !== 'canceled' && row.status !== 'incomplete_expired')
  if (current.length > 1) throw new Error('Organization has multiple current subscriptions')
  const subscription = current[0]
  const entitling = entitlingSubscription(organizationId, subscriptions)
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
    locations: { used, covered: coveredLocations(plan, entitling?.seats) },
    entitlements: getPlanEntitlements(plan),
  }
}

function billingInterval(value: string | undefined): 'month' | 'year' | undefined {
  if (value === undefined || value === 'month' || value === 'year') return value
  throw new Error(`Subscription billing interval ${value} is not a plan interval`)
}

async function countOrganizationLocations(db: DbClient, organizationId: string): Promise<number> {
  const row = await queryFirst<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM business_locations WHERE organization_id = ?', [organizationId])
  if (!row) throw new Error('Location count could not be read')
  return row.count
}

/**
 * The locations this organization has against the ones its plan covers. Every
 * surface that adds a location — dashboard and MCP — asks here first.
 */
export async function organizationLocations(env: CloudflareEnv, db: DbClient, organizationId: string): Promise<OrganizationLocations & { plan: string }> {
  const [subscriptions, used] = await Promise.all([
    readOrganizationSubscriptions(env, [organizationId]),
    countOrganizationLocations(db, organizationId),
  ])
  const rows = subscriptions.get(organizationId) ?? []
  const plan = planFromSubscriptions(organizationId, rows)
  return { plan, used, covered: coveredLocations(plan, entitlingSubscription(organizationId, rows)?.seats) }
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
  const item = next.items[0]
  const priceId = typeof item?.price === 'string' ? item.price : item?.price?.id
  const plan = (await createStripePlanLoader(stripe, env)()).find(row => row.priceId === priceId || row.annualDiscountPriceId === priceId)
  if (!plan) throw new Error(`Subscription schedule ${scheduleId} moves to a price outside the plan catalog`)
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
