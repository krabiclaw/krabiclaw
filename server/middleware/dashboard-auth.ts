import { defineHandler } from 'nitro'
import { redirect } from 'nitro/h3'
import { cloudflareEnv } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { buildLoginUrl } from '~/shared/auth/return-target'

// Keep authentication at the private dashboard boundary so external deep links survive sign-in.
export default defineHandler(async (event) => {
  const path = event.url.pathname
  if (event.req.method !== 'GET') return
  if (path !== '/dashboard' && !path.startsWith('/dashboard/')) return

  const session = await getAuthSession(event, cloudflareEnv(event))
  if (session?.user?.id) return

  return redirect(buildLoginUrl({
    redirect: `${event.url.pathname}${event.url.search}`,
  }), 302)
})
