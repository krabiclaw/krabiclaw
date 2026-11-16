import { execute, queryAllPages, queryFirst } from '~/server/db'
import { publishEvent } from '~/server/events'
import type { CloudflareEnv } from '~/server/utils/auth'
import { runScheduledManagedAdSpend } from '~/server/domain/payments/ad-spend'
import { cleanupMcpToolCallEvents, MCP_AUDIT_RETENTION_DAYS, MCP_DIAGNOSTIC_RETENTION_DAYS } from '~/server/utils/mcp-telemetry'
import { expireStripeGa4Intents, STRIPE_GA4_CONSUMED_RETENTION_DAYS } from '~/server/utils/stripe-ga4-intents'
import { sendDueReviewInvitations } from '~/server/utils/review-request-delivery'
import { REVIEW_REQUEST_TTL_DAYS } from '~/server/utils/review-requests'
import { CACHE_INVALIDATION_TERMINAL_RETENTION_DAYS } from '~/server/utils/public-resource-cache'

export const RETENTION_HUB = 'platform:analytics-retention'

/** Deployment adopts work that has no Worker wake yet, including writes made by the old build. */
export async function enqueueOutstandingWork(env: CloudflareEnv): Promise<void> {
  const due = Date.now()
  const deadlines = await queryAllPages<{
    organization_id: string
    kind: 'reviews' | 'checkout' | 'channex_ari' | 'ad_spend'
  }>(env.DB, `
    SELECT DISTINCT organization_id, 'reviews' AS kind
    FROM bookings WHERE channel = 'direct' AND status = 'confirmed' AND length(ends_at) > 10 AND ends_at > ?
    UNION ALL SELECT DISTINCT organization_id, 'checkout' FROM (
      SELECT h.organization_id FROM payment_checkout_holds h WHERE h.session_id IS NULL
        AND EXISTS (SELECT 1 FROM stay_nights n WHERE n.hold_id = h.id AND n.organization_id = h.organization_id)
      UNION SELECT b.organization_id FROM bookings b WHERE b.status = 'pending' AND b.product_session_id IS NULL
        AND b.owner = 'app' AND b.channel = 'direct' AND json_type(b.policy_json, '$.stay_request.respond_by') = 'text'
    )
    UNION ALL SELECT DISTINCT organization_id, 'channex_ari'
    FROM product_channel_mappings WHERE provider = 'channex' AND enabled = 1
    UNION ALL SELECT organization_id, 'ad_spend' FROM (
      SELECT s.organization_id
      FROM organization_services s JOIN organization_integrations i
        ON i.organization_id=s.organization_id AND i.provider IN ('google_ads', 'meta_ads') AND i.status IS NOT 'setting_up'
      WHERE s.service='managed_ads' AND (s.ended_at IS NULL OR s.ended_at > i.created_at)
      UNION SELECT organization_id FROM usage_events WHERE resource='ad_spend'
        AND provider_occurred_at IS NOT NULL AND delivery_at IS NULL
    )
    ORDER BY kind, organization_id
  `, [new Date(due - REVIEW_REQUEST_TTL_DAYS * 86_400_000).toISOString()])
  const projections = await queryAllPages<{
    organization_id: string
    kind: 'site' | 'calendar' | 'calendar_cleanup'
  }>(env.DB, `
    SELECT DISTINCT organization_id, 'site' AS kind
    FROM public_resource_cache_invalidations WHERE status IN ('pending', 'failed')
    UNION ALL SELECT organization_id, 'calendar'
    FROM organization_integrations WHERE provider='google_calendar' AND status <> 'setting_up'
    UNION ALL SELECT DISTINCT organization_id, 'calendar_cleanup'
    FROM google_calendar_cleanup_jobs WHERE state IN ('pending', 'error')
      AND NOT EXISTS (SELECT 1 FROM organization WHERE organization.id=google_calendar_cleanup_jobs.organization_id)
    ORDER BY kind, organization_id
  `, [])
  await publishEvent(env, { type: 'business.wake', organization_id: RETENTION_HUB, kind: 'retention', due_at: due })
  for (const { organization_id, kind } of deadlines) {
    await publishEvent(env, { type: 'business.wake', organization_id, kind, due_at: due })
  }
  for (const { organization_id, kind } of projections) {
    if (kind === 'site') await publishEvent(env, { type: 'site.cache_changed', organization_id, invalidation_id: null })
    else if (kind === 'calendar') await publishEvent(env, { type: 'calendar.changed', organization_id, booking_id: null })
    else await publishEvent(env, { type: 'calendar.cleanup', organization_id })
  }
  const jobs = await queryAllPages<{ organization_id: string; id: string }>(env.DB,
    "SELECT organization_id, id FROM airbnb_sync_jobs WHERE state = 'pending' ORDER BY id", [])
  for (const { organization_id, id } of jobs) {
    await publishEvent(env, { type: 'airbnb.sync', organization_id, job_id: id })
  }
}

/** Run the retention window once for its UTC day, only when it has due rows. */
export function retentionWakeAt(expiresAt: number): number {
  return Math.ceil(expiresAt / 86_400_000) * 86_400_000
}

/** One retention alarm serves site receipts, Stripe attribution, and MCP calls, including anonymous calls. */
async function retainAnalytics(env: CloudflareEnv, now: number): Promise<{ next: number | null }> {
  const instant = new Date(now)
  await cleanupMcpToolCallEvents(env.DB, instant)
  await expireStripeGa4Intents(env.DB, instant)
  const cacheCutoff = new Date(now - CACHE_INVALIDATION_TERMINAL_RETENTION_DAYS * 86_400_000).toISOString()
  await execute(env.DB, `DELETE FROM public_resource_cache_invalidations
    WHERE status IN ('processed', 'failed') AND created_at <= ? AND processed_at <= ?`, [cacheCutoff, cacheCutoff])
  const row = await queryFirst<{ next: string | null }>(env.DB, `
    SELECT MIN(expires) AS next FROM (
      SELECT strftime('%Y-%m-%dT%H:%M:%fZ', MIN(created_at), '+${MCP_AUDIT_RETENTION_DAYS} days') AS expires
      FROM mcp_tool_call_events
      UNION ALL
      SELECT strftime('%Y-%m-%dT%H:%M:%fZ', MIN(created_at), '+${MCP_DIAGNOSTIC_RETENTION_DAYS} days')
      FROM mcp_tool_call_events WHERE json_extract(arguments_summary_json, '$._diagnostic') = 1
      UNION ALL
      SELECT MIN(expires_at) FROM stripe_ga4_subscription_intents WHERE status = 'pending'
      UNION ALL
      SELECT strftime('%Y-%m-%dT%H:%M:%fZ', MIN(consumed_at), '+${STRIPE_GA4_CONSUMED_RETENTION_DAYS} days')
      FROM stripe_ga4_subscription_intents WHERE status = 'consumed'
      UNION ALL
      SELECT strftime('%Y-%m-%dT%H:%M:%fZ', MIN(processed_at), '+${CACHE_INVALIDATION_TERMINAL_RETENTION_DAYS} days')
      FROM public_resource_cache_invalidations WHERE status IN ('processed', 'failed')
    )`)
  return { next: row?.next == null ? null : retentionWakeAt(Date.parse(row.next)) }
}

export async function runDueBusinessWork(env: CloudflareEnv, organizationId: string, kind: 'reviews' | 'retention' | 'ad_spend', now: number): Promise<{ next: number | null }> {
  if (kind === 'ad_spend') return runScheduledManagedAdSpend(env, organizationId, now)
  if (kind === 'reviews') return sendDueReviewInvitations(env, organizationId, now)
  if (organizationId !== RETENTION_HUB) throw new Error('Analytics retention requires the platform hub')
  return retainAnalytics(env, now)
}
