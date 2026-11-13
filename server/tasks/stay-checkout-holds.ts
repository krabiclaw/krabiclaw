import type { CloudflareEnv } from '~/server/utils/auth'
import { expireStayRequests, releaseLapsedStayHolds } from '~/server/domain/stays'
import { defineScheduledTask } from '~/server/utils/scheduled-task'

export default defineScheduledTask({
  meta: { name: 'stay-checkout-holds', description: 'Give back the nights of lapsed stay checkout holds and reopen them on each home\'s channel' },
  async run({ context }) {
    const env = (context as { cloudflare: { env: CloudflareEnv } }).cloudflare.env
    const settle = <T>(run: Promise<T>) => run.then(value => ({ value }), (error: unknown) => ({ error }))
    const requests = await settle(expireStayRequests(env.DB, env))
    const holds = await settle(releaseLapsedStayHolds(env.DB, env))
    if ('error' in requests || 'error' in holds) {
      const errors = [requests, holds].flatMap(outcome => 'error' in outcome ? [outcome.error] : [])
      throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('. '))
    }
    return { result: { ...holds.value, expired_requests: requests.value } }
  },
})
