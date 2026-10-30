import type { CloudflareEnv } from '~/server/utils/auth'
import { deliverPendingChannelNights } from '~/server/domain/stays'
import { defineScheduledTask } from '~/server/utils/scheduled-task'

export default defineScheduledTask({
  meta: { name: 'channex-ari-delivery', description: 'Send due Channex nights and weekend prices for dates entering the booking window' },
  async run({ context }) {
    const env = (context as { cloudflare: { env: CloudflareEnv } }).cloudflare.env
    return { result: await deliverPendingChannelNights(env.DB, env) }
  },
})
