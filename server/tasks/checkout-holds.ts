import type { CloudflareEnv } from '~/server/utils/auth'
import { closeConfirmationsBeforeHoldsLapse } from '~/server/domain/payments/events'
import { releaseLapsedStayHolds } from '~/server/domain/stays'
import { defineScheduledTask } from '~/server/utils/scheduled-task'

export default defineScheduledTask({
  meta: { name: 'checkout-holds', description: 'Close payment confirmations before their holds lapse, then give back the nights of lapsed stay holds' },
  async run({ context }) {
    const env = (context as { cloudflare: { env: CloudflareEnv } }).cloudflare.env
    const [confirmations, stays] = await Promise.all([closeConfirmationsBeforeHoldsLapse(env.DB, env), releaseLapsedStayHolds(env.DB, env)])
    return { result: { confirmations, stays } }
  },
})
