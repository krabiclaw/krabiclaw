import { definePlugin } from 'nitro'
import { resolve } from 'node:path'
import type { PlatformProxy, Unstable_DevWorker } from 'wrangler'

let platformProxy: Promise<PlatformProxy> | undefined
let guestInboxHubWorker: Promise<Unstable_DevWorker> | undefined

async function loadWrangler() {
  const packageName = 'wrangler'
  return await import(/* @vite-ignore */ packageName) as typeof import('wrangler')
}

// The Durable Object cannot run inside the platform proxy (it proxies an empty
// script), so its class is served by a second local Worker that `[env.dev]`
// reaches by script_name through Wrangler's dev registry. It must be up before
// the proxy resolves the binding.
async function startGuestInboxHubWorker() {
  const { unstable_dev, unstable_readConfig } = await loadWrangler()
  const config = unstable_readConfig({ config: 'wrangler.toml', env: 'dev' }, { hideWarnings: true })
  return await unstable_dev('server/cloudflare/dev/guest-inbox-hub.worker.ts', {
    config: 'server/cloudflare/dev/wrangler.toml',
    envFiles: [resolve('.env')],
    persistTo: resolve('.wrangler/state'),
    local: true,
    logLevel: 'warn',
    experimental: {
      d1Databases: config.d1_databases,
      disableExperimentalWarning: true,
    },
  })
}

async function createPlatformProxy() {
  await (guestInboxHubWorker ??= startGuestInboxHubWorker())
  const { getPlatformProxy } = await loadWrangler()
  return await getPlatformProxy({
    configPath: 'wrangler.toml',
    environment: 'dev',
    persist: true,
    remoteBindings: false,
  })
}

export default definePlugin((nitroApp) => {
  if (!import.meta.dev) return

  platformProxy ??= createPlatformProxy()

  nitroApp.hooks.hook('request', async (event) => {
    const proxy = await platformProxy!
    const request = event.req

    request.runtime ??= { name: 'cloudflare' }
    request.runtime.cloudflare = {
      ...request.runtime.cloudflare,
      env: proxy.env,
      context: proxy.ctx as NonNullable<typeof request.runtime.cloudflare>['context'],
    }
    request.waitUntil = proxy.ctx.waitUntil.bind(proxy.ctx)
    ;(request as unknown as { cf: PlatformProxy['cf'] }).cf = proxy.cf
  })

  nitroApp.hooks.hook('close', async () => {
    if (platformProxy) await (await platformProxy).dispose()
    platformProxy = undefined
    if (guestInboxHubWorker) await (await guestInboxHubWorker).stop()
    guestInboxHubWorker = undefined
  })
})
