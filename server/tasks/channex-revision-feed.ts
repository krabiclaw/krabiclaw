import { queryFirst } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { runRevisionFeed } from '~/server/integrations/channex/booking-revisions'
import { defineScheduledTask } from '~/server/utils/scheduled-task'

export default defineScheduledTask({
  meta: { name: 'channex-revision-feed', description: 'Land Channex booking revisions the webhook did not acknowledge' },
  async run({ context }) {
    const env = (context as { cloudflare: { env: CloudflareEnv } }).cloudflare.env
    // An environment where no organization ever made a Channex group has no revision to take.
    // Once one has, a missing Channex key fails the run.
    const connected = await queryFirst<{ n: number }>(env.DB, 'SELECT COUNT(*) AS n FROM channex_connections WHERE group_id IS NOT NULL')
    const result = connected?.n ? await runRevisionFeed(env.DB, env) : { acknowledged: 0, ignored: 0 }
    return { result }
  },
})
