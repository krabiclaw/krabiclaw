import { HTTPError, type H3Event } from 'nitro'
import { paymentPerformance, preparePaymentPerformance, readStripePayouts } from '~/server/domain/payments/earnings'
import { authorizePayments } from '~/server/domain/payments'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { BATCH_VIEWER, withViewer } from '~/server/utils/member-access'
import { roleMatchesSql, rolesAllowing } from '~/utils/organization-access'
import type { BatchQuery } from '~/server/db'
import { stripeConnectedAccountFromRow, stripeConnectedAccountQuery, type StripeConnectedAccount } from '~/server/utils/stripe-connect'
import { timeRequestPhase } from '~/server/utils/request-metrics'
import type { EarningsPerformance } from '~/shared/earnings-display'

export async function readDashboardEarnings(event: H3Event, query: { year?: unknown; month?: unknown }, orgSlug?: string) {
  const { db, organization, userId } = await getDashboardContext(event, { organizationSlug: orgSlug })
  const principal = { organizationId: organization.id, userId, role: organization.role }
  const now = new Date()
  const year = Number(query.year ?? now.getUTCFullYear())
  const month = typeof query.month === 'string' ? query.month : now.toISOString().slice(0, 7)
  const preloaded = event.context.dashboardEarnings as { slug: string; periods: Map<string, EarningsPerformance> } | undefined
  const answer = preloaded?.slug === organization.slug ? preloaded.periods.get(month) : undefined
  if (answer && Number(month.slice(0, 4)) === year) {
    await authorizePayments(principal, 'read')
    return answer
  }
  return paymentPerformance(db, principal, year, month)
}

export async function readDashboardPayoutsDocument(event: H3Event, orgSlug: string, after?: unknown) {
  if (after !== undefined && (typeof after !== 'string' || !after)) throw new HTTPError({ statusCode: 400, statusMessage: 'Valid page cursor is required' })
  const { env, organization, userId } = await getDashboardContext(event, { organizationSlug: orgSlug })
  const principal = { organizationId: organization.id, userId, role: organization.role }
  await authorizePayments(principal, 'read')
  await authorizePayments(principal, 'payouts')
  const payout = event.context.dashboardPayoutAccount as { organizationId: string; account: StripeConnectedAccount | null } | undefined
  if (!payout || payout.organizationId !== organization.id) throw new HTTPError({ statusCode: 500, message: 'Earnings document is missing the Stripe account lookup' })
  return timeRequestPhase(event, 'stripe_payouts', () => readStripePayouts(env, organization.id, payout.account, after))
}

export function prepareDashboardEarningsDocument(membership: BatchQuery, months: ReadonlySet<string>, includePayouts: boolean) {
  const readsPayments = roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ payments: ['read'] }))
  const readsPayouts = roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ payments: ['payouts'] }))
  const organization = { sql: `CASE WHEN ${BATCH_VIEWER.organizationWide} = 1 AND ${readsPayments} THEN ${BATCH_VIEWER.organization} END` }
  const payout = includePayouts ? stripeConnectedAccountQuery({
    sql: `CASE WHEN ${readsPayouts} THEN ${organization.sql} END`,
  }) : null
  const reads = [...months].map(month => {
    return { month, ...preparePaymentPerformance(organization, Number(month.slice(0, 4)), month, { sql: readsPayouts }) }
  })
  return {
    queries: [...reads.flatMap(plan => plan.queries), ...(payout ? [payout] : [])].map(query => withViewer(membership, query)),
    apply(event: H3Event, rows: D1Result[], organization: { slug: string; id: string }) {
      let offset = 0
      const periods = new Map(reads.map(plan => {
        const values = rows.slice(offset, offset + plan.queries.length)
        offset += plan.queries.length
        return [plan.month, plan.read(values, organization.id)]
      }))
      if (payout) event.context.dashboardPayoutAccount = { organizationId: organization.id, account: stripeConnectedAccountFromRow(rows[offset]?.results[0]) }
      event.context.dashboardEarnings = { slug: organization.slug, periods }
    },
  }
}
