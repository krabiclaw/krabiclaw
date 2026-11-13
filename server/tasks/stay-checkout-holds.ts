import type { CloudflareEnv } from '~/server/utils/auth'
import { expireStayRequests, releaseLapsedStayHolds } from '~/server/domain/stays'
import { defineScheduledTask } from '~/server/utils/scheduled-task'

export default defineScheduledTask({
  meta: { name: 'stay-checkout-holds', description: 'Give back the nights of lapsed stay checkout holds and reopen them on each home\'s channel' },
  async run({ context }) {
    const env = (context as { cloudflare: { env: CloudflareEnv } }).cloudflare.env
    const expired_requests = await expireStayRequests(env.DB, env)
    return { result: { ...await releaseLapsedStayHolds(env.DB, env), expired_requests } }
  },
})
