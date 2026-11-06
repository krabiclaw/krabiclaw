import type { CloudflareEnv } from '~/server/utils/auth'
import { sendDueScheduledGuestMessages } from '~/server/domain/scheduled-guest-messages'
import { notifyStartingTurnovers } from '~/server/utils/notifications'
import { defineScheduledTask } from '~/server/utils/scheduled-task'

export default defineScheduledTask({
  meta: { name: 'scheduled-guest-messages', description: 'Send saved guest messages that are due at their homes, and tell cleaners their turnovers start today' },
  async run({ context }) {
    const env = (context as { cloudflare: { env: CloudflareEnv } }).cloudflare.env
    // Each runs whether or not the other failed; a failure of either fails the run.
    const [messages, turnovers] = await Promise.allSettled([sendDueScheduledGuestMessages(env.DB, env), notifyStartingTurnovers(env, env.DB)])
    const failures = [messages, turnovers].flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Scheduled guest messages or turnover alerts failed')
    return { result: { messages: (messages as PromiseFulfilledResult<Awaited<ReturnType<typeof sendDueScheduledGuestMessages>>>).value, turnovers: (turnovers as PromiseFulfilledResult<{ alerted: number }>).value } }
  },
})
