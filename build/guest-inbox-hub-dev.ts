import { resolve } from 'node:path'
import { defineNuxtModule } from 'nuxt/kit'
import type { Unstable_DevWorker } from 'wrangler'

// The Durable Object cannot run inside the platform proxy (it proxies an empty
// script), so under `nuxt dev` its class is served by a second local Worker
// that `[env.dev]` reaches by script_name through Wrangler's dev registry.
//
// It lives as long as the `nuxt dev` process, not as long as one Nitro build.
// Started from a Nitro plugin, every rebuild started a new one while the old
// one's registry entry outlived its Nitro worker; Miniflare will not take over
// a name another instance touched in the last 90 seconds, so for that long
// every call went to the dead instance ("Network connection lost").
export default defineNuxtModule({
  meta: { name: 'guest-inbox-hub-dev' },
  setup(_options, nuxt) {
    if (!nuxt.options.dev) return

    let worker: Unstable_DevWorker | undefined

    nuxt.hook('ready', async () => {
      const { unstable_dev, unstable_readConfig } = await import('wrangler')
      const rootDir = nuxt.options.rootDir
      const config = unstable_readConfig({ config: resolve(rootDir, 'wrangler.toml'), env: 'dev' }, { hideWarnings: true })
      worker = await unstable_dev(resolve(rootDir, 'server/cloudflare/dev/guest-inbox-hub.worker.ts'), {
        config: resolve(rootDir, 'server/cloudflare/dev/wrangler.toml'),
        envFiles: [resolve(rootDir, '.env')],
        persistTo: resolve(rootDir, '.wrangler/state'),
        local: true,
        logLevel: 'warn',
        experimental: {
          d1Databases: config.d1_databases,
          disableExperimentalWarning: true,
        },
      })
    })

    nuxt.hook('close', async () => {
      await worker?.stop()
      worker = undefined
    })
  },
})
