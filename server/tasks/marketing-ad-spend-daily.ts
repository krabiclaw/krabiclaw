import type { CloudflareEnv } from '~/server/utils/auth'
import { queryAll } from '~/server/db'
import { defineScheduledTask } from '~/server/utils/scheduled-task'
import { recordAdSpend } from '~/server/domain/payments/ad-spend'
import { organizationsOnService } from '~/server/utils/organization-services'

/**
 * Bills each business on managed ads for the Google Ads it spent two days ago: a
 * day Google has finished counting. Every connected account is read; one
 * business's failure is reported after the others have been billed.
 */
export default defineScheduledTask<{ date: string; billed: number; skipped: number }>({
  meta: { name: 'marketing:ad-spend-daily', description: 'Queue each Marketing business’s Google Ads spend as usage' },
  async run({ context }) {
    const env = (context as { cloudflare?: { env?: CloudflareEnv } } | undefined)?.cloudflare?.env
    if (!env?.DB) throw new Error('DB is required')
    const date = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)
    // Connecting Google Ads is free; the fee follows the business's agreement to managed ads.
    const connected = await queryAll<{ organization_id: string }>(env.DB, "SELECT organization_id FROM organization_integrations WHERE provider='google_ads' ORDER BY organization_id")
    const managed = new Set(await organizationsOnService(env.DB, 'managed_ads'))
    const billable = connected.filter(row => managed.has(row.organization_id))
    const failures: string[] = []
    let billed = 0
    for (const { organization_id } of billable) {
      try {
        if ((await recordAdSpend(env.DB, env, organization_id, date)).amount > 0) billed++
      } catch (error) {
        failures.push(`${organization_id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (failures.length) throw new Error(`Ad spend for ${date} was not billed for ${failures.length} of ${billable.length} businesses: ${failures.join('; ')}`)
    return { result: { date, billed, skipped: connected.length - billable.length } }
  },
})
