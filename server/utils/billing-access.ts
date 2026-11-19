import type { Subscription } from '@better-auth/stripe'
import { HTTPError } from 'nitro'
import { executeBatch, queryAll, type BatchQuery, type DbClient } from '~/server/db'
import type { stripe_connected_accounts } from '~/server/db/schema'
import { createAuth, type CloudflareEnv } from '~/server/utils/auth'
import { getPlanEntitlements, type EntitlementsMap } from '~/server/utils/billing-entitlements'

/**
 * Better Auth's Stripe plugin owns the `subscription` table — its webhook
 * handlers are the only writers — and this module is the only reader. There is
 * no second projection of subscription state.
 *
 * An organization's plan is the plan of the single `active`/`trialing` row
 * whose `periodEnd` has not passed. No qualifying row means `free`: the absence
 * of a subscription, not a substituted source. Two qualifying rows is corrupt
 * state and throws SUBSCRIPTION_STATE_INVALID, because picking one would hide
 * the corruption; scheduled scans that serve other organizations too refuse
 * that organization and go on.
 */
export const FREE_PLAN = 'free'
export const SUBSCRIPTION_STATE_INVALID = 'SUBSCRIPTION_STATE_INVALID'

const ORGANIZATION_CHUNK = 50
const SUBSCRIPTION_PAGE = 100
const ENTITLING_STATUSES = ['active', 'trialing']

type EntitlementRow = Pick<Subscription, 'id' | 'referenceId' | 'plan'> & {
  status: string
  periodEnd?: Date | null
}

export function isSubscriptionStateInvalid(error: unknown): boolean {
  return error instanceof HTTPError && error.data?.code === SUBSCRIPTION_STATE_INVALID
}

function subscriptionStateInvalid(organizationId: string, detail: string): never {
  throw new HTTPError({
    statusCode: 409,
    statusMessage: `Organization ${organizationId} ${detail}`,
    data: { code: SUBSCRIPTION_STATE_INVALID, organization_id: organizationId },
  })
}

/**
 * Every subscription row these organizations have, as the table holds them.
 *
 * Exposed because a caller that needs both the plan and the subscription
 * itself (billing status) must not read the same rows twice to get them.
 */
export async function readOrganizationSubscriptions(
  env: CloudflareEnv,
  organizationIds: string[],
): Promise<Map<string, Subscription[]>> {
  const uniqueIds = Array.from(new Set(organizationIds.filter(id => id.trim())))
  const byOrganization = new Map<string, Subscription[]>(uniqueIds.map(id => [id, []]))
  if (uniqueIds.length === 0) return byOrganization

  const adapter = (await createAuth(env).$context).adapter
  for (let offset = 0; offset < uniqueIds.length; offset += ORGANIZATION_CHUNK) {
    const chunk = uniqueIds.slice(offset, offset + ORGANIZATION_CHUNK)
    // Better Auth caps findMany at 100 rows unless a limit is given, and a chunk
    // of 50 organizations can carry more subscription rows than that once
    // canceled ones accumulate. A truncated read would leave a paying
    // organization on free with no error, so read every page.
    for (let page = 0; ; page += SUBSCRIPTION_PAGE) {
      const batch = await adapter.findMany<Subscription>({
        model: 'subscription',
        where: [{ field: 'referenceId', operator: 'in', value: chunk }],
        sortBy: { field: 'id', direction: 'asc' },
        limit: SUBSCRIPTION_PAGE,
        offset: page,
      })
      for (const row of batch) byOrganization.get(row.referenceId)?.push(row)
      if (batch.length < SUBSCRIPTION_PAGE) break
    }
  }
  return byOrganization
}

/** Better Auth's polymorphic subscription reference has no adapter relation to these seller tables. */
export async function readCheckoutSeller(db: DbClient, organizationId: string) {
  const { query, params } = checkoutSellerQuery({ query: '?', params: [organizationId] })
  return checkoutSellerFromRows(await queryAll(db, query, params))
}

export function checkoutSellerQuery(organization: BatchQuery): BatchQuery {
  return {
    query: `SELECT a.*, o.id AS seller_id, o.slug AS seller_slug, o.subdomain AS seller_subdomain,
      o.stripeCustomerId AS seller_customer_id,
      EXISTS (SELECT 1 FROM payment_servicing_tenants ps WHERE ps.organization_id=o.id) AS servicing,
      s.id AS subscription_id, s.plan AS subscription_plan, s.status AS subscription_status, s.periodEnd AS period_end,
      s.stripeCustomerId AS subscription_customer_id, s.stripeSubscriptionId AS subscription_stripe_id
      FROM organization o LEFT JOIN stripe_connected_accounts a ON a.organization_id=o.id
      LEFT JOIN subscription s ON s.referenceId=o.id AND s.status IN (${ENTITLING_STATUSES.map(() => '?').join(', ')})
      WHERE o.id=${organization.query} ORDER BY s.id`,
    params: [...ENTITLING_STATUSES, ...organization.params ?? []],
  }
}

export function checkoutSellerFromRows(rows: unknown[]) {
  type Row = typeof stripe_connected_accounts.$inferSelect & {
    seller_id: string; seller_slug: string; seller_subdomain: string | null; seller_customer_id: string | null; servicing: number
    subscription_id: string | null; subscription_plan: string; subscription_status: string; period_end: number | null
    subscription_customer_id: string | null; subscription_stripe_id: string | null
  }
  const sellerRows = rows as Row[]
  const seller = sellerRows[0]
  if (!seller) return null
  const current = entitlingSubscription(seller.seller_id, sellerRows.flatMap(row => row.subscription_id ? [{
    id: row.subscription_id, referenceId: row.seller_id, plan: row.subscription_plan, status: row.subscription_status,
    periodEnd: row.period_end === null ? null : new Date(row.period_end * 1000),
    stripeCustomerId: row.subscription_customer_id, stripeSubscriptionId: row.subscription_stripe_id,
  }] : []))
  const { seller_id, seller_slug, seller_subdomain, seller_customer_id, servicing,
    subscription_id: _subscriptionId, subscription_plan: _plan, subscription_status: _status,
    period_end: _periodEnd, subscription_customer_id: _customerId, subscription_stripe_id: _stripeId, ...account } = seller
  return { organizationId: seller_id, slug: seller_slug, subdomain: seller_subdomain,
    stripeCustomerId: seller_customer_id, servicing: Boolean(servicing), account: account.id ? account : null,
    subscription: current, plan: subscriptionPlan(current) }
}

/**
 * The one subscription row that entitles this organization, by the rule at the
 * top of this file, or null on free. Pure, so the single read above can answer
 * the plan, its location quantity and the billing projection.
 */
export function entitlingSubscription<T extends EntitlementRow>(
  organizationId: string,
  rows: T[],
  now = new Date(),
): T | null {
  let current: T | null = null
  for (const row of rows) {
    if (row.referenceId !== organizationId) continue
    if (!ENTITLING_STATUSES.includes(row.status)) continue
    if (row.periodEnd != null) {
      if (row.periodEnd.getTime() <= now.getTime()) continue
    }
    if (current) subscriptionStateInvalid(organizationId, 'has multiple current subscriptions')
    if (!row.plan?.trim()) subscriptionStateInvalid(organizationId, `subscription ${row.id} has no plan`)
    current = row
  }
  return current
}

function subscriptionPlan(current: EntitlementRow | null): string {
  return current?.plan.trim().toLowerCase() ?? FREE_PLAN
}

export function planFromSubscriptions(
  organizationId: string,
  rows: EntitlementRow[],
  now = new Date(),
): string {
  return subscriptionPlan(entitlingSubscription(organizationId, rows, now))
}

export async function getOrganizationPlans(
  env: CloudflareEnv,
  organizationIds: string[],
  now = new Date(),
): Promise<Map<string, string>> {
  const rows = await readOrganizationSubscriptions(env, organizationIds)
  const plans = new Map<string, string>()
  for (const [organizationId, subscriptions] of rows) {
    plans.set(organizationId, planFromSubscriptions(organizationId, subscriptions, now))
  }
  return plans
}

export async function getOrganizationPlan(
  env: CloudflareEnv,
  organizationId: string,
  now = new Date(),
): Promise<string> {
  const plan = prepareOrganizationPlan(organizationId, now)
  const [result] = await executeBatch(env.DB, [plan.query], { operation: 'Read the organization plan' })
  return plan.read(result!)
}

export function prepareOrganizationPlan(organizationId: string | { sql: string }, now = new Date()) {
  const query = {
    query: `SELECT id, referenceId, plan, status, periodEnd FROM subscription
      WHERE referenceId = ${typeof organizationId === 'string' ? '?' : organizationId.sql} AND status IN (${ENTITLING_STATUSES.map(() => '?').join(', ')})`,
    params: [...(typeof organizationId === 'string' ? [organizationId] : []), ...ENTITLING_STATUSES],
  }
  return {
    query,
    read(result: D1Result, resolvedId?: string) {
      const id = resolvedId ?? (typeof organizationId === 'string' ? organizationId : null)
      if (!id?.trim()) throw new Error('An organization ID is required for the plan read')
      const rows = result.results as (Omit<EntitlementRow, 'periodEnd'> & { periodEnd: number | null })[]
      return planFromSubscriptions(id, rows.map(row => ({
        ...row, periodEnd: row.periodEnd === null ? null : new Date(row.periodEnd * 1000),
      })), now)
    },
  }
}

export async function getOrganizationEntitlements(
  env: CloudflareEnv,
  organizationId: string,
  now = new Date(),
): Promise<EntitlementsMap> {
  return getPlanEntitlements(await getOrganizationPlan(env, organizationId, now))
}

/**
 * Keep only the candidate rows whose organization's plan grants `entitlement`.
 * Scheduled integrations select their candidates from their own tables and then
 * filter here; they do not join subscription state into their SQL.
 */
export async function filterEntitledRows<T extends { organization_id: string }>(
  env: CloudflareEnv,
  rows: T[],
  entitlement: string,
  now = new Date(),
): Promise<T[]> {
  if (rows.length === 0) return []
  const organizationIds = Array.from(new Set(rows.map(row => row.organization_id)))
  let plans: Map<string, string>
  try {
    plans = await getOrganizationPlans(env, organizationIds, now)
  } catch (error) {
    if (!isSubscriptionStateInvalid(error)) throw error
    // One organization's corrupt subscription state is that organization's
    // problem: it is logged and left out, and every other organization in the
    // scan is still served.
    plans = new Map()
    for (const organizationId of organizationIds) {
      try {
        plans.set(organizationId, await getOrganizationPlan(env, organizationId, now))
      } catch (single) {
        if (!isSubscriptionStateInvalid(single)) throw single
        console.error('organization_subscription_state_invalid', { organizationId, error: single instanceof Error ? single.message : String(single) })
      }
    }
  }
  const entitled = new Map<string, boolean>()
  for (const [organizationId, plan] of plans) {
    entitled.set(organizationId, getPlanEntitlements(plan)[entitlement] === true)
  }
  return rows.filter(row => entitled.get(row.organization_id) === true)
}
