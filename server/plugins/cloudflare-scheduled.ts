import { definePlugin } from 'nitro';
import { runScheduledTasks } from '~/server/scheduled-tasks'
import { bindDatabaseEvents } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:scheduled', async ({ controller, env }) => {
    const workerEnv = env as ApiRecord
    const bindings = env as CloudflareEnv
    bindDatabaseEvents(bindings.DB, bindings)
    await runScheduledTasks(controller.cron, workerEnv, {
      scheduledTime: controller.scheduledTime,
    })
  })
})
