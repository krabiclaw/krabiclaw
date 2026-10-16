import { HTTPError } from 'nitro'
import type { H3Event } from 'nitro/h3'
import { cloudflareEnv } from '~/server/utils/api-response'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import { getAnalyticsReport } from '~/server/utils/analytics-report'
import { AnalyticsQueryError, queryOrganizationAnalytics, type AnalyticsQueryInput } from '~/server/utils/analytics-query'
import { loadOnboardingChecklist } from '~/server/utils/onboarding-checklist'
import { queryAll, type DbClient } from '~/server/db'

import { organizationAnalyticsSchema, type OrganizationAnalyticsReport } from '~/shared/analytics-report'

type OrganizationReviewsSummary = OrganizationAnalyticsReport['reviews']
type OrganizationSetupProgress = OrganizationAnalyticsReport['setup']

const SETUP_ITEM_LABELS: Record<string, string> = {
  business_info: 'Business details',
  hero_image: 'Hero image',
  core_offering: 'Products or services',
  story: 'Your story',
  post: 'A first post',
}

/**
 * Approved reviews across the sites in scope.
 *
 * Only an overall rating exists on a review, so this reports the average, the
 * per-star distribution and the most recent few. There are no per-category
 * scores to break down; the schema has one `rating` column.
 */
async function loadReviewsSummary(db: DbClient, organizationIds: readonly string[]): Promise<OrganizationReviewsSummary> {
  if (!organizationIds.length) return { total: 0, average: null, distribution: [], recent: [] }
  const placeholders = organizationIds.map(() => '?').join(', ')
  const rows = await queryAll<{ id: string; author_name: string | null; rating: number; title: string | null; content: string | null; created_at: string }>(
    db,
    `SELECT id, author_name, rating, title, content, created_at
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
      createdAt: row.created_at,
      }
    }),
  }
}

/** The tenant's setup progress. A checklist belongs to one tenant. */
async function loadSetupProgress(
  event: H3Event,
  organization: { id: string; label: string },
): Promise<OrganizationSetupProgress> {
  const checklist = await loadOnboardingChecklist(event, organization.id)
  const items = Object.entries(checklist.items).map(([id, done]) => ({
    id,
    label: SETUP_ITEM_LABELS[id] ?? id,
    done: Boolean(done),
  }))
  return {
    organizationId: organization.id,
    label: organization.label,
    completed: items.filter(item => item.done).length,
    total: items.length,
    items,
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

  const [report, reviews, setup] = await Promise.all([
    getAnalyticsReport(db, {
      organizationId: organization.id,
      startDate: query.startDate,
      endDate: query.endDate,
    }),
    loadReviewsSummary(db, [organization.id]),
    loadSetupProgress(event, { id: organization.id, label: organization.name }),
  ])

  return organizationAnalyticsSchema.parse({ organizationId: organization.id, report, reviews, setup })
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
