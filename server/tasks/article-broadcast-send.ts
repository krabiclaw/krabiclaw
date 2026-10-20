import { runArticleBroadcast, type BroadcastEnv, type BroadcastRunResult } from '~/server/domain/article-broadcast'
import { defineScheduledTask } from '~/server/utils/scheduled-task'

export default defineScheduledTask({
  meta: { name: 'article-broadcast-send', description: 'Announce newly published KrabiClaw articles through a Resend Broadcast' },
  async run({ context }): Promise<{ result: BroadcastRunResult }> {
    const env = (context as { cloudflare?: { env?: BroadcastEnv & { DB?: D1Database } } } | undefined)?.cloudflare?.env
    const db = env?.DB
    if (!db && import.meta.dev) {
      return { result: { broadcast_id: null, article_id: null, provider_broadcast_id: null, mode: null, reconciliation: null, skipped: 'DB unavailable in local scheduled task context' } }
    }
    if (!db || !env) throw new Error('DB is required')
    return { result: await runArticleBroadcast(db, env) }
  },
})
