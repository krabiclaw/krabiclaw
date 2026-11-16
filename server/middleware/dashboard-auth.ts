import { defineHandler } from 'nitro'
import { redirect } from 'nitro/h3'
import { cloudflareEnv } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { buildLoginUrl } from '~/shared/auth/return-target'
import { isNonProductionHost, normalizeHost } from '~/server/utils/tenant-hosts'

// Keep authentication at the private dashboard boundary so external deep links survive sign-in.
export default defineHandler(async (event) => {
  const { pathname, search, hostname } = event.url
  const { method, headers } = event.req
  const path = pathname === '/' ? '/' : pathname.replace(/\/$/, '')
  const dashboard = path === '/dashboard' || path.startsWith('/dashboard/')
  const browserEntry = method === 'HEAD' || (method === 'GET' && headers.get('accept')?.includes('text/html'))
  if (browserEntry && (dashboard || path === '/login' || path === '/signup'
    || path === '/forgot-password' || /^\/accept-invitation\/[^/]+$/.test(path))) {
    const env = cloudflareEnv(event)
    const authOrigin = env.BETTER_AUTH_URL && new URL(env.BETTER_AUTH_URL)
    if (authOrigin && authOrigin.protocol === 'https:' && !isNonProductionHost(authOrigin.hostname)
      && authOrigin.hostname !== hostname && hostname === normalizeHost(env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN)) {
      // Start login on the host that receives the OAuth callback and owns the state cookie.
      return redirect(`${authOrigin.origin}${pathname}${search}`, 302)
    }
  }

  if (method !== 'GET' || !dashboard) return

  const session = await getAuthSession(event, cloudflareEnv(event))
  if (session?.user?.id) return

  return redirect(buildLoginUrl({
    redirect: `${pathname}${search}`,
  }), 302)
})
