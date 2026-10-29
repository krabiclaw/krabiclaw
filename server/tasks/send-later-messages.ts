import type { CloudflareEnv } from '~/server/utils/auth'
import { sendDueSendLaterMessages } from '~/server/domain/send-later'
import { defineScheduledTask } from '~/server/utils/scheduled-task'

export default defineScheduledTask({
  meta: { name: 'send-later-messages', description: 'Send members’ send-later guest replies that are due' },
  async run({ context }) {
    const env = (context as { cloudflare: { env: CloudflareEnv } }).cloudflare.env
    return { result: await sendDueSendLaterMessages(env.DB, env) }
  },
})
