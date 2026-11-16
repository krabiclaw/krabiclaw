import { execute, queryAll, queryFirst } from '~/server/db'
import { publishEvent } from '~/server/events'
import type { CloudflareEnv } from '~/server/utils/auth'
import { runScheduledManagedAdSpend } from '~/server/domain/payments/ad-spend'
import { cleanupMcpToolCallEvents, MCP_AUDIT_RETENTION_DAYS, MCP_DIAGNOSTIC_RETENTION_DAYS } from '~/server/utils/mcp-telemetry'
import { expireStripeGa4Intents, STRIPE_GA4_CONSUMED_RETENTION_DAYS } from '~/server/utils/stripe-ga4-intents'
import { sendDueReviewInvitations } from '~/server/utils/review-request-delivery'
import { REVIEW_REQUEST_TTL_DAYS } from '~/server/utils/review-requests'
import { CACHE_INVALIDATION_TERMINAL_RETENTION_DAYS } from '~/server/utils/public-resource-cache'

export const RETENTION_HUB = 'platform:analytics-retention'

/** Adopt work recorded before booking and integration writes started sending events. */
export async function enqueueOutstandingBusinessDeadlines(env: CloudflareEnv): Promise<void> {
  const due = Date.now()
  const rows = await queryAll<{ organization_id: string; kind: 'reviews' | 'checkout' | 'channex_ari' }>(env.DB, `
    SELECT DISTINCT organization_id, 'reviews' AS kind
    FROM bookings WHERE channel = 'direct' AND status = 'confirmed' AND length(ends_at) > 10 AND ends_at > ?
    UNION ALL SELECT DISTINCT organization_id, 'checkout' FROM (
      SELECT h.organization_id FROM payment_checkout_holds h WHERE h.session_id IS NULL
        AND EXISTS (SELECT 1 FROM stay_nights n WHERE n.hold_id = h.id AND n.organization_id = h.organization_id)
      UNION SELECT b.organization_id FROM bookings b WHERE b.status = 'pending' AND b.product_session_id IS NULL
        AND b.owner = 'app' AND b.channel = 'direct' AND json_type(b.policy_json, '$.stay_request.respond_by') = 'text'
    )
    UNION ALL SELECT DISTINCT organization_id, 'channex_ari'
    FROM product_channel_mappings WHERE provider = 'channex' AND enabled = 1`,
  [new Date(due - REVIEW_REQUEST_TTL_DAYS * 86_400_000).toISOString()])
  await publishEvent(env, { type: 'business.wake', organization_id: RETENTION_HUB, kind: 'retention', due_at: due })
  for (const row of rows) {
    await publishEvent(env, { type: 'business.wake', organization_id: row.organization_id, kind: row.kind, due_at: due })
  }
  const syncJobs = await queryAll<{ organization_id: string; id: string }>(env.DB, "SELECT organization_id, id FROM airbnb_sync_jobs WHERE state = 'pending'")
  for (const job of syncJobs) {
    await publishEvent(env, { type: 'airbnb.sync', organization_id: job.organization_id, job_id: job.id })
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
