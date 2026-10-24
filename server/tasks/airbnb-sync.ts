import type { CloudflareEnv } from '~/server/utils/auth'
import { CRON_SLICE_MS, runAirbnbSyncJobs } from '~/server/integrations/channex/airbnb-sync'
import { defineScheduledTask } from '~/server/utils/scheduled-task'

export default defineScheduledTask({
  meta: { name: 'airbnb-sync', description: 'Advance the Airbnb listings hosts asked to sync or stop' },
  async run({ context }) {
    const env = (context as { cloudflare: { env: CloudflareEnv } }).cloudflare.env
    const result = await runAirbnbSyncJobs(env, Date.now() + CRON_SLICE_MS)
    if (result.failed) throw new Error(`${result.failed} Airbnb sync job(s) failed; inspect each listing's sync status and airbnb_sync_jobs.last_error`)
    return { result }
  },
})
