import { definePlugin } from 'nitro'
import type { PlatformProxy } from 'wrangler'

let platformProxy: Promise<PlatformProxy> | undefined

async function loadWrangler() {
  const packageName = 'wrangler'
  return await import(/* @vite-ignore */ packageName) as typeof import('wrangler')
}

// `GUEST_INBOX_HUBS` reaches the Durable Object Worker that
// build/guest-inbox-hub-dev.ts keeps running for the whole `nuxt dev` process;
// the proxy follows it through Wrangler's dev registry.
async function createPlatformProxy() {
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

  // Each rebuild replaces this app's worker thread; the patched env-runner
  // closes the old one first, so its proxy and the local D1 it holds go with it.
  nitroApp.hooks.hook('close', async () => {
    if (platformProxy) await (await platformProxy).dispose()
    platformProxy = undefined
  })
})
