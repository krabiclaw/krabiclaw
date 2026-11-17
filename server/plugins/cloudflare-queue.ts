import { definePlugin } from 'nitro'
import { consumeEventBatch } from '~/server/cloudflare/queue-consumer'
import type { CloudflareEnv } from '~/server/utils/auth'

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:queue', async ({ batch, env }) => {
    await consumeEventBatch(env as CloudflareEnv, batch)
  })
})
