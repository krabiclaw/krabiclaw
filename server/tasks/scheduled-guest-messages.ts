import type { CloudflareEnv } from '~/server/utils/auth'
import { sendDueScheduledGuestMessages } from '~/server/domain/scheduled-guest-messages'
import { defineScheduledTask } from '~/server/utils/scheduled-task'

export default defineScheduledTask({
  meta: { name: 'scheduled-guest-messages', description: 'Send every outbox guest message that is due: automatic messages and members’ send-later replies' },
  async run({ context }) {
    const env = (context as { cloudflare: { env: CloudflareEnv } }).cloudflare.env
    return { result: { messages: await sendDueScheduledGuestMessages(env.DB, env) } }
  },
})
