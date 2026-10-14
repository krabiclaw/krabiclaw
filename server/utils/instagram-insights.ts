import { HTTPError } from 'nitro'
import { readLinkedAccount, type CloudflareEnv } from '~/server/utils/auth'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { readIntegration } from '~/server/utils/organization-integrations'
import { resolveOrganizationAnalyticsContext } from '~/server/utils/analytics-report'
import { localDateBounds, parseAnalyticsRange } from '~/server/utils/analytics-calendar'
import { ACCOUNT_INSIGHT_METRICS, MEDIA_INSIGHT_METRICS, instagramAccessToken, listMedia, readAccountInsights, readMediaInsights, type InstagramTarget } from '~/server/utils/instagram'
import { MetaDeadline, MetaGraphError } from '~/server/utils/meta-graph'
import { failureOf } from '~/server/utils/social-publication'
import type { InstagramInsights } from '~/shared/instagram-insights'

const INSIGHTS_SCOPE = 'instagram_business_manage_insights'
const MEDIA_PAGE = 25
const MEDIA_LIMIT = 100

/**
 * The organization's connected Instagram account's insights for the range, in
 * the organization's own calendar days, read live from Instagram and never
 * stored. Instagram's own failures are thrown with its message.
 */
export async function loadInstagramInsights(env: CloudflareEnv, organizationId: string, query: { startDate?: string; endDate?: string }): Promise<InstagramInsights> {
  if (!(await hasOrganizationEntitlement(env, organizationId, 'managed_service'))) return { status: 'growth_plan_required', message: 'Instagram insights require the Growth plan.' }
  const connection = await readIntegration(env.DB, organizationId, 'instagram')
  if (!connection) return { status: 'not_connected', message: 'No Instagram professional account is connected. Connect one in Settings → Integrations → Instagram.' }
  const account = await readLinkedAccount(env, connection.account_id)
  if (!account) return { status: 'account_unlinked', message: 'The Instagram login this connection was made through is no longer linked. Connect Instagram again.' }
  if (!account.scope?.split(',').some(scope => scope.trim() === INSIGHTS_SCOPE)) return { status: 'permission_missing', message: 'Instagram has not granted access to insights for this account. Connect Instagram again and allow insights.' }

  const context = await resolveOrganizationAnalyticsContext(env.DB, organizationId)
  const range = parseAnalyticsRange({ startDate: query.startDate, endDate: query.endDate, timeZone: context.timezone, now: new Date() })
  const since = new Date(localDateBounds(range.startDate, context.timezone).start)
  const until = new Date(localDateBounds(range.endDate, context.timezone).end)
  const deadline = new MetaDeadline(25_000)
  try {
    const target: InstagramTarget = { userId: connection.target_id, accessToken: await instagramAccessToken(env, connection.account_id) }
    const [totals, posted] = await Promise.all([readAccountInsights(target, { since, until }, deadline), mediaPostedIn(target, since, until, deadline)])
    const media = await inBatches(posted.items, 10, async (item) => {
      const carousel = item.media_type === 'CAROUSEL_ALBUM'
      const insights = carousel ? null : await readMediaInsights(target, item.id, deadline)
      return {
        id: item.id, permalink: item.permalink ?? null, caption: item.caption ?? null, mediaType: item.media_type,
        productType: item.media_product_type ?? null, postedAt: item.timestamp, thumbnailUrl: item.thumbnail_url ?? item.media_url ?? null,
        insights: insights && Object.fromEntries(MEDIA_INSIGHT_METRICS.map(name => [name, insights[name] ?? null])) as Record<typeof MEDIA_INSIGHT_METRICS[number], number | null>,
        unavailableReason: carousel ? 'Instagram reports no insights for carousel posts.' : null,
      }
    })
    return {
      status: 'connected', username: connection.target_name, period: { startDate: range.startDate, endDate: range.endDate },
      account: Object.fromEntries(ACCOUNT_INSIGHT_METRICS.map(name => [name, totals[name] ?? null])) as Record<typeof ACCOUNT_INSIGHT_METRICS[number], number | null>,
      media, moreMedia: posted.more,
    }
  } catch (error) {
    if (!(error instanceof MetaGraphError)) throw error
    const failure = failureOf(error)
    throw new HTTPError({ statusCode: 502, statusMessage: `Instagram: ${failure.message}`, data: { code: failure.code } })
  }
}

/** The account's own media posted in [since, until), newest first, up to MEDIA_LIMIT. */
async function mediaPostedIn(target: InstagramTarget, since: Date, until: Date, deadline: MetaDeadline) {
  const items: Awaited<ReturnType<typeof listMedia>>['items'] = []
  let after: string | null = null
  do {
    const page = await listMedia(target, { after, limit: MEDIA_PAGE }, deadline)
    for (const item of page.items) {
      const postedAt = new Date(item.timestamp)
      if (postedAt < since) return { items, more: false }
      if (postedAt >= until) continue
      if (items.length === MEDIA_LIMIT) return { items, more: true }
      items.push(item)
    }
    after = page.after
  } while (after)
  return { items, more: false }
}

/** Instagram's requests, a few at a time rather than one per post at once. */
async function inBatches<T, R>(items: readonly T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let index = 0; index < items.length; index += size) results.push(...await Promise.all(items.slice(index, index + size).map(run)))
  return results
}
