import type { MessageBatch } from '@cloudflare/workers-types'
import { consumeEventBatch } from '../queue-consumer'
import type { CloudflareEnv } from '../../utils/auth'

// The Durable Object and its event queue as their own Worker for `nuxt dev`.
//
// Wrangler's platform proxy cannot host a Durable Object whose class lives in
// the Worker being proxied: it runs an empty script, so the production binding
// (class in this Worker, no script_name) resolves to nothing and every
// broadcast failed with 500 under `yarn dev`. Wrangler's answer is a separate
// Worker for the class, started with `wrangler dev` and reached through the
// local dev registry by `script_name`. build/guest-inbox-hub-dev.ts
// starts this one for the life of `nuxt dev`; `[env.dev]` in wrangler.toml binds to it. The built Worker
// (`yarn dev:worker`, staging, production) exports the same class itself
// through exports.cloudflare.ts and never uses this file.
export { GuestInboxHubObject } from '../durable-objects/guest-inbox-hub'

export default {
  queue(batch: MessageBatch, env: CloudflareEnv): Promise<void> {
    return consumeEventBatch(env, batch)
  },
  fetch(): Response {
    return new Response(null, { status: 404 })
  },
}
