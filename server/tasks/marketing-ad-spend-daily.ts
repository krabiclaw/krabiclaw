import type { CloudflareEnv } from '~/server/utils/auth'
import { queryAll, queryFirst } from '~/server/db'
import { defineScheduledTask } from '~/server/utils/scheduled-task'
import { recordAdSpend, recordMetaAdSpend, unrecordedDaysForIntegration } from '~/server/domain/payments/ad-spend'
import { readIntegration } from '~/server/utils/organization-integrations'
import { deliverPaymentsUsage } from '~/server/domain/payments/usage'

/**
 * Captures missing managed days once they are two days old, including ended
 * agreements and previously failed reads, then delivers the existing outbox.
 * One business's failure is reported after the others have been billed.
 */
export default defineScheduledTask<{ billed: number; skipped: number }>({
  meta: { name: 'marketing:ad-spend-daily', description: 'Capture managed Google and Meta Ads spend and deliver pending usage' },
  async run({ context }) {
    const env = (context as { cloudflare?: { env?: CloudflareEnv } } | undefined)?.cloudflare?.env
    if (!env?.DB) throw new Error('DB is required')
    const now = new Date()
    const organizations = await queryAll<{ organization_id: string }>(env.DB, "SELECT organization_id FROM organization_integrations WHERE provider IN ('google_ads', 'meta_ads') UNION SELECT organization_id FROM usage_events WHERE resource='ad_spend' AND provider_occurred_at IS NOT NULL AND delivery_at IS NULL ORDER BY organization_id")
    const failures: string[] = []
    let billed = 0
    let skipped = 0
    for (const { organization_id } of organizations) {
      try {
        for (const provider of ['google_ads', 'meta_ads'] as const) {
          const ads = await readIntegration(env.DB, organization_id, provider)
          if (ads?.account_id && ads.target_id) {
            const missing = await unrecordedDaysForIntegration(env.DB, env, organization_id, {
              provider,
              account_id: ads.account_id,
              target_id: ads.target_id,
              created_at: ads.created_at,
            }, now, 2)
            for (const day of missing) {
              if (provider === 'meta_ads') {
                await recordMetaAdSpend(env.DB, env, organization_id, day)
              } else {
                await recordAdSpend(env.DB, env, organization_id, day)
              }
            }
          }
        }
        const pending = await queryFirst<{ amount: number }>(env.DB, "SELECT SUM(quantity) AS amount FROM usage_events WHERE organization_id=? AND resource='ad_spend' AND provider_occurred_at IS NOT NULL AND delivery_at IS NULL HAVING COUNT(*)>0", [organization_id])
        if (!pending) { skipped++; continue }
        await deliverPaymentsUsage(env.DB, env, organization_id)
        if (pending.amount > 0) billed++
      } catch (error) {
        failures.push(`${organization_id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (failures.length) throw new Error(`Managed ad spend was not billed for ${failures.length} of ${organizations.length} businesses: ${failures.join('; ')}`)
    return { result: { billed, skipped } }
  },
})
