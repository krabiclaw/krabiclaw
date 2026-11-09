import { reconcileDueDomains } from '~/server/utils/domains'
import { defineScheduledTask } from '~/server/utils/scheduled-task'

export default defineScheduledTask({
  meta: {
    name: 'domains:reconcile',
    description: 'Read Cloudflare for custom domains still being set up'
  },
  async run({ payload, context }) {
    const taskContext = context as { cloudflare?: { env?: ApiRecord } } | undefined
    const env = taskContext?.cloudflare?.env ?? {}
    const db = env.DB
    if (!db && import.meta.dev) {
      return { result: { checked: 0, failed: 0, skipped: 'DB unavailable in local scheduled task context' } }
    }
    if (!db) throw new Error('DB is required')

    const rawLimit = typeof payload?.limit === 'number' ? payload.limit : Number.NaN
    const normalizedLimit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 25
    const limit = Math.min(1000, Math.max(1, normalizedLimit))
    const result = await reconcileDueDomains(env, db, limit)
    return { result }
  }
})
