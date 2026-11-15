import type { CloudflareEnv } from '~/server/utils/auth'
import { defineScheduledTask } from '~/server/utils/scheduled-task'
import { expireStripeGa4Intents } from '~/server/utils/stripe-ga4-intents'
import { cleanupMcpToolCallEvents } from '~/server/utils/mcp-telemetry'

interface StripeGa4IntentRetentionTaskContext {
  cloudflare?: { env?: CloudflareEnv }
}

export default defineScheduledTask({
  meta: {
    name: 'analytics:stripe-ga4-intent-retention',
    description: 'Retire expired Stripe GA4 analytics intents and MCP tool audit rows past their retention',
  },
  async run({ context }) {
    const env = (context as StripeGa4IntentRetentionTaskContext | undefined)?.cloudflare?.env
    if (!env?.DB && import.meta.dev) {
      return { result: { expiredStripeGa4Intents: false, mcpToolCallEventsCleaned: 0 } }
    }
    if (!env?.DB) throw new Error('DB is required')

    // GA4 analytics intents are read with an `expires_at > now` filter, so this
    // sweep is retention only: it marks lapsed intents expired and drops
    // consumed ones past the 90-day window. It rode on the hourly Stripe
    // reconciliation task before that task and the billing layer it reconciled
    // were deleted.
    // A retention pass that did not run is a retention pass that did not run, and
    // the scheduler is the only thing positioned to notice.
    // The MCP tool audit's 180-day retention rides on the same daily pass, first, so a failed GA4
    // pass never stops it; a thrown pass reaches the scheduler, which reports it.
    const mcpToolCallEventsCleaned = await cleanupMcpToolCallEvents(env.DB)
    await expireStripeGa4Intents(env.DB)
    return { result: { expiredStripeGa4Intents: true, mcpToolCallEventsCleaned } }
  },
})
