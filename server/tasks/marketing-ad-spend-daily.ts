import type { CloudflareEnv } from '~/server/utils/auth'
import { queryAll, queryFirst } from '~/server/db'
import { defineScheduledTask } from '~/server/utils/scheduled-task'
import { recordAdSpend, unrecordedAdSpendDays } from '~/server/domain/payments/ad-spend'
import { deliverPaymentsUsage } from '~/server/domain/payments/usage'

/**
 * Captures missing managed days once they are two days old, including ended
 * agreements and previously failed reads, then delivers the existing outbox.
 * One business's failure is reported after the others have been billed.
 */
export default defineScheduledTask<{ billed: number; skipped: number }>({
  meta: { name: 'marketing:ad-spend-daily', description: 'Capture managed Google Ads spend and deliver pending usage' },
  async run({ context }) {
    const env = (context as { cloudflare?: { env?: CloudflareEnv } } | undefined)?.cloudflare?.env
    if (!env?.DB) throw new Error('DB is required')
    const now = new Date()
    const organizations = await queryAll<{ organization_id: string }>(env.DB, "SELECT organization_id FROM organization_integrations WHERE provider='google_ads' UNION SELECT organization_id FROM payment_usage_events WHERE kind='ad_spend' AND delivery_at IS NULL AND dead_letter_at IS NULL ORDER BY organization_id")
    const failures: string[] = []
    let billed = 0
    let skipped = 0
    for (const { organization_id } of organizations) {
      try {
        for (const day of await unrecordedAdSpendDays(env.DB, env, organization_id, now, 2)) await recordAdSpend(env.DB, env, organization_id, day)
        const pending = await queryFirst<{ amount: number }>(env.DB, "SELECT SUM(amount) AS amount FROM payment_usage_events WHERE organization_id=? AND kind='ad_spend' AND delivery_at IS NULL AND dead_letter_at IS NULL HAVING COUNT(*)>0", [organization_id])
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
