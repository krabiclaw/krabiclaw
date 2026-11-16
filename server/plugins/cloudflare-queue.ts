import { definePlugin } from 'nitro'
import { consumeEvent, type DomainEvent } from '~/server/events'
import type { CloudflareEnv } from '~/server/utils/auth'

export default definePlugin((nitroApp) => {
  // Each message is acknowledged once it is done; a throw leaves the rest of the batch for Cloudflare to deliver again.
  nitroApp.hooks.hook('cloudflare:queue', async ({ batch, env }) => {
    for (const message of batch.messages) {
      await consumeEvent(env as CloudflareEnv, message.body as DomainEvent)
      message.ack()
    }
  })
})
