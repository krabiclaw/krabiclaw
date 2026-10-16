import type { CloudflareEnv } from '~/server/utils/auth'
import { sendDueScheduledGuestMessages } from '~/server/domain/scheduled-guest-messages'
import { defineScheduledTask } from '~/server/utils/scheduled-task'

export default defineScheduledTask({
  meta: { name: 'scheduled-guest-messages', description: 'Send saved guest messages that are due at their homes' },
  async run({ context }) {
    const env = (context as { cloudflare: { env: CloudflareEnv } }).cloudflare.env
    return { result: await sendDueScheduledGuestMessages(env.DB, env) }
  },
})
