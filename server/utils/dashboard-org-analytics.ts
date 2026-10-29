import { HTTPError } from 'nitro'
import type { H3Event } from 'nitro/h3'
import { cloudflareEnv } from '~/server/utils/api-response'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import { getAnalyticsReport } from '~/server/utils/analytics-report'
import { AnalyticsQueryError, queryOrganizationAnalytics, type AnalyticsQueryInput } from '~/server/utils/analytics-query'
import { queryAll, type DbClient } from '~/server/db'

import { organizationAnalyticsSchema, type OrganizationAnalyticsReport } from '~/shared/analytics-report'

type OrganizationReviewsSummary = OrganizationAnalyticsReport['reviews']

/**
 * The published reviews: what the website shows, imported Google reviews
 * included and named by their source. This is the overall rating's average,
 * its per-star distribution and the most recent few; the category scores
 * invited guests give are internal feedback (review-feedback.ts).
 */
async function loadReviewsSummary(db: DbClient, organizationIds: readonly string[]): Promise<OrganizationReviewsSummary> {
  if (!organizationIds.length) return { total: 0, average: null, distribution: [], recent: [] }
  const placeholders = organizationIds.map(() => '?').join(', ')
  const rows = await queryAll<{ id: string; author_name: string | null; rating: number; title: string | null; content: string | null; source: string; created_at: string }>(
    db,
    `SELECT id, author_name, rating, title, content, source, created_at
       FROM reviews
      WHERE organization_id IN (${placeholders}) AND status = 'approved'
      ORDER BY created_at DESC`,
    [...organizationIds],
  )

  const distribution = [5, 4, 3, 2, 1].map(rating => ({
    rating,
    count: rows.filter(row => row.rating === rating).length,
  }))

  return {
    total: rows.length,
    average: rows.length
      ? Math.round((rows.reduce((sum, row) => sum + row.rating, 0) / rows.length) * 100) / 100
      : null,
    distribution,
    recent: rows.slice(0, 8).map(row => {
      // Every review writer (direct, review request, Google) requires its author.
      if (!row.author_name?.trim()) throw new HTTPError({ statusCode: 500, message: `Review ${row.id} has no author`, data: { code: 'INVALID_REVIEW', field: 'author_name', review_id: row.id } })
      return {
      id: row.id,
      author: row.author_name,
      rating: row.rating,
      title: row.title,
      content: row.content,
      source: row.source,
      createdAt: row.created_at,
      }
    }),
  }
}

/**
 * Analytics for the tenant.
 *
 * This used to report across every site in the organization and combine them,
 * with a filter to pick one. A business is its organization, so there is one
 * report and nothing to combine or choose between.
 */
export async function loadDashboardOrganizationAnalytics(
  event: H3Event,
  query: { startDate?: string; endDate?: string },
): Promise<OrganizationAnalyticsReport> {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) throw new HTTPError({ statusCode: 500, statusMessage: 'Database not available' })
  const session = await getAuthSession(event, env)
  if (!session?.user?.id) throw new HTTPError({ statusCode: 401, statusMessage: 'Authentication required' })

  const context = await getDashboardContext(event, {})
  const organization = context.organization
  if (!organization) throw new HTTPError({ statusCode: 403, statusMessage: 'Organization access required' })

  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { analytics: ['read'] } })

  const [report, reviews] = await Promise.all([
    getAnalyticsReport(db, {
      organizationId: organization.id,
      startDate: query.startDate,
      endDate: query.endDate,
    }),
    loadReviewsSummary(db, [organization.id]),
  ])

  return organizationAnalyticsSchema.parse({ organizationId: organization.id, report, reviews })
}

/**
 * The dashboard's adapter over the one native analytics query. It authorizes the caller and
 * resolves the organization; the query itself is the same function the MCP tool calls.
 */
export async function loadDashboardOrganizationAnalyticsQuery(event: H3Event, request: Omit<AnalyticsQueryInput, 'organizationId' | 'cursorSecret' | 'now'>) {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) throw new HTTPError({ statusCode: 500, statusMessage: 'Database not available' })
  const session = await getAuthSession(event, env)
  if (!session?.user?.id) throw new HTTPError({ statusCode: 401, statusMessage: 'Authentication required' })
  const context = await getDashboardContext(event, {})
  const organization = context.organization
  if (!organization) throw new HTTPError({ statusCode: 403, statusMessage: 'Organization access required' })
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { analytics: ['read'] } })
  try {
    return await queryOrganizationAnalytics(db, { ...request, organizationId: organization.id, cursorSecret: env.BETTER_AUTH_SECRET })
  } catch (error) {
    if (error instanceof AnalyticsQueryError) throw new HTTPError({ statusCode: 400, statusMessage: error.message })
    throw error
  }
}
