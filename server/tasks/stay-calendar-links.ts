import type { CloudflareEnv } from '~/server/utils/auth'
import { syncStayCalendarLinks } from '~/server/domain/stays'
import { defineScheduledTask } from '~/server/utils/scheduled-task'

export default defineScheduledTask({
  meta: { name: 'stay-calendar-links', description: 'Read each home\'s linked Vrbo calendar, claim the nights it shows taken and tell Airbnb' },
  async run({ context }) {
    const env = (context as { cloudflare: { env: CloudflareEnv } }).cloudflare.env
    return { result: await syncStayCalendarLinks(env.DB, env) }
  },
})
