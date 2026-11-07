import type { CloudflareEnv } from '~/server/utils/auth'
import { expireReplyTasks } from '~/server/domain/guest-threads/repository'
import { defineScheduledTask } from '~/server/utils/scheduled-task'

export default defineScheduledTask({
  meta: { name: 'reply-task-expiry', description: 'Close guest reply tasks whose question has gone unanswered for 30 days' },
  async run({ context }) {
    const env = (context as { cloudflare: { env: CloudflareEnv } }).cloudflare.env
    return { result: await expireReplyTasks(env.DB, new Date().toISOString()) }
  },
})
