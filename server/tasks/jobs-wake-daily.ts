import type { CloudflareEnv } from '~/server/utils/auth'
import { queryAll } from '~/server/db'
import { defineScheduledTask } from '~/server/utils/scheduled-task'
import { publishBusinessInvalidation } from '~/server/cloudflare/guest-inbox-events'
import { JOB_TASK_SQL, SUPPORTED_TASK_KINDS } from '~/server/domain/tasks'

/**
 * A business's jobs are woken by its own stay and business changes, and each
 * wake re-arms the hub to the next reminder. A business that changes nothing
 * for a day, or whose hub was just created by a deploy, still has reminders
 * due: this names every business with an open job or a timed task in the next
 * two days and wakes it once a day, so the chain starts without waiting for a
 * change. Nothing is sent here; the hub reads D1 and posts what is due.
 */
export default defineScheduledTask<{ woken: number }>({
  meta: { name: 'jobs-wake-daily', description: 'Wake every business with open jobs or timed tasks so their reminders are armed' },
  async run({ context }) {
    const env = (context as { cloudflare?: { env?: CloudflareEnv } } | undefined)?.cloudflare?.env
    if (!env?.DB) throw new Error('DB is required')
    const horizon = new Date(Date.now() + 2 * 86_400_000).toISOString()
    const organizations = await queryAll<{ organization_id: string }>(env.DB, `SELECT DISTINCT t.organization_id FROM tasks t
      WHERE t.status = 'open' AND t.kind IN (SELECT value FROM json_each(?))
        AND (${JOB_TASK_SQL('t')} OR (t.starts_at IS NOT NULL AND t.starts_at <= ?))`, [SUPPORTED_TASK_KINDS, horizon])
    const failures: unknown[] = []
    for (const row of organizations) {
      try { await publishBusinessInvalidation(env, row.organization_id) } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, `${failures.length} of ${organizations.length} businesses could not be woken`)
    return { result: { woken: organizations.length } }
  },
})
