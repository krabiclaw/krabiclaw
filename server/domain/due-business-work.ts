import { execute, queryAllPages, queryFirst } from '~/server/db'
import { publishAirbnbSync, publishEvent, type DomainEvent } from '~/server/events'
import type { CloudflareEnv } from '~/server/utils/auth'
import { runScheduledManagedAdSpend } from '~/server/domain/payments/ad-spend'
import { cleanupMcpToolCallEvents, MCP_AUDIT_RETENTION_DAYS, MCP_DIAGNOSTIC_RETENTION_DAYS } from '~/server/utils/mcp-telemetry'
import { expireStripeGa4Intents, STRIPE_GA4_CONSUMED_RETENTION_DAYS } from '~/server/utils/stripe-ga4-intents'
import { sendDueReviewInvitations } from '~/server/utils/review-request-delivery'
import { REVIEW_REQUEST_TTL_DAYS } from '~/server/utils/review-requests'
import { CACHE_INVALIDATION_TERMINAL_RETENTION_DAYS } from '~/server/utils/public-resource-cache'
import { SOCIAL_CARD_REFRESH_PREFIX } from '~/server/utils/social-card'

export const RETENTION_HUB = 'platform:analytics-retention'

/** Recover pending work after the deployed Worker has converged. */
export async function enqueueOutstandingWork(env: CloudflareEnv): Promise<void> {
  const due = Date.now()
  // Keep each compound read under D1’s term limit, then page the combined result.
  const work = await queryAllPages<{ organization_id: string } & (
    { kind: 'airbnb'; job_id: string }
    | { kind: Extract<DomainEvent, { type: 'business.wake' }>['kind'] | 'site' | 'calendar' | 'calendar_cleanup'; job_id: null }
  )>(env.DB, `
    WITH deadlines AS MATERIALIZED (
      SELECT DISTINCT organization_id, 'reviews' AS kind
      FROM bookings WHERE channel = 'direct' AND status = 'confirmed' AND length(ends_at) > 10 AND ends_at > ?
      UNION ALL SELECT DISTINCT organization_id, 'checkout'
      FROM bookings WHERE status = 'pending' AND product_session_id IS NULL
        AND owner = 'app' AND channel = 'direct' AND json_type(policy_json, '$.stay_request.respond_by') = 'text'
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
    ), projections AS MATERIALIZED (
      SELECT DISTINCT organization_id, 'site' AS kind
      FROM public_resource_cache_invalidations
      WHERE status IN ('pending', 'failed') OR (status='processing' AND reason LIKE ?)
      UNION ALL SELECT organization_id, 'calendar'
      FROM organization_integrations WHERE provider='google_calendar' AND status <> 'setting_up'
      UNION ALL SELECT DISTINCT organization_id, 'calendar_cleanup'
      FROM google_calendar_cleanup_jobs WHERE state IN ('pending', 'error')
        AND NOT EXISTS (SELECT 1 FROM organization WHERE organization.id=google_calendar_cleanup_jobs.organization_id)
    )
    SELECT organization_id, kind, job_id FROM (
      SELECT organization_id, kind, NULL AS job_id, 0 AS phase FROM deadlines
      UNION ALL SELECT organization_id, kind, NULL, 1 FROM projections
      UNION ALL SELECT organization_id, 'airbnb', id, 2 FROM airbnb_sync_jobs WHERE state = 'pending'
    )
    ORDER BY phase, kind, COALESCE(job_id, organization_id)
  `, [new Date(due - REVIEW_REQUEST_TTL_DAYS * 86_400_000).toISOString(), `${SOCIAL_CARD_REFRESH_PREFIX}%`])
  await publishEvent(env, { type: 'business.wake', organization_id: RETENTION_HUB, kind: 'retention', due_at: due })
  for (const { organization_id, kind, job_id } of work) {
    if (kind === 'site') await publishEvent(env, { type: 'site.cache_changed', organization_id, invalidation_id: null })
    else if (kind === 'calendar') await publishEvent(env, { type: 'calendar.changed', organization_id, booking_id: null })
    else if (kind === 'calendar_cleanup') await publishEvent(env, { type: 'calendar.cleanup', organization_id })
    else if (kind === 'airbnb') await publishAirbnbSync(env, { type: 'airbnb.sync_step', organization_id, job_id })
    else await publishEvent(env, { type: 'business.wake', organization_id, kind, due_at: due })
  }
}

/** Run the retention window once for its UTC day, only when it has due rows. */
export function retentionWakeAt(expiresAt: number): number {
  return Math.ceil(expiresAt / 86_400_000) * 86_400_000
}

export async function runDueBusinessWork(env: CloudflareEnv, organizationId: string, kind: 'reviews' | 'retention' | 'ad_spend', now: number): Promise<{ next: number | null }> {
  if (kind === 'ad_spend') return runScheduledManagedAdSpend(env, organizationId, now)
  if (kind === 'reviews') return sendDueReviewInvitations(env, organizationId, now)
  if (organizationId !== RETENTION_HUB) throw new Error('Analytics retention requires the platform hub')

  // One retention alarm serves site receipts, Stripe attribution, and all MCP calls.
  const instant = new Date(now)
  await cleanupMcpToolCallEvents(env.DB, instant)
  await expireStripeGa4Intents(env.DB, instant)
  const cacheCutoff = new Date(now - CACHE_INVALIDATION_TERMINAL_RETENTION_DAYS * 86_400_000).toISOString()
  const socialCardReason = `${SOCIAL_CARD_REFRESH_PREFIX}%`
  await execute(env.DB, `DELETE FROM public_resource_cache_invalidations
    WHERE status IN ('processed', 'failed') AND reason NOT LIKE ? AND created_at <= ? AND processed_at <= ?`, [socialCardReason, cacheCutoff, cacheCutoff])
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
      FROM public_resource_cache_invalidations WHERE status IN ('processed', 'failed') AND reason NOT LIKE ?
    )`, [socialCardReason])
  return { next: row?.next == null ? null : retentionWakeAt(Date.parse(row.next)) }
}
