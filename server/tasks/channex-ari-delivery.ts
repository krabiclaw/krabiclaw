import type { CloudflareEnv } from '~/server/utils/auth'
import { deliverPendingChannelNights } from '~/server/domain/stays'
import { defineScheduledTask } from '~/server/utils/scheduled-task'

export default defineScheduledTask({
  meta: { name: 'channex-ari-delivery', description: 'Send Channex the pending nights of connected homes once their rate-limit or retry wait is over' },
  async run({ context }) {
    const env = (context as { cloudflare: { env: CloudflareEnv } }).cloudflare.env
    return { result: await deliverPendingChannelNights(env.DB, env) }
  },
})
