import type { H3Event } from 'nitro'
import { getCookie, setCookie } from 'nitro/h3'
import { symmetricDecodeJWT, symmetricEncodeJWT } from 'better-auth/crypto'
import { createAuth, type CloudflareEnv } from '~/server/utils/auth'

const SOCKET_PATH = '/api/dashboard/guest-inbox/socket'
const PURPOSE = 'dashboard-socket-scope'
const STARTUP_SECONDS = 45
type Scope = { slug: string; organizationId: string; sessionId: string; userId: string }

function cookieName(slug: string) {
  return `dashboard-socket-${slug}`
}

/** Carry the document's verified workspace to the browser's first upgrade.
 * Better Auth still authenticates the browser, and the hub checks current
 * session, membership and audience before delivering a private event. */
export async function setDashboardSocketScope(event: H3Event, env: CloudflareEnv, scope: Scope) {
  const token = await symmetricEncodeJWT(scope, env.BETTER_AUTH_SECRET, PURPOSE, STARTUP_SECONDS)
  setCookie(event, cookieName(scope.slug), token, {
    path: SOCKET_PATH, httpOnly: true, secure: event.url.protocol === 'https:', sameSite: 'strict', maxAge: STARTUP_SECONDS,
  })
}

export async function readDashboardSocketScope(event: H3Event, env: CloudflareEnv, slug: string) {
  const token = getCookie(event, cookieName(slug))
  if (!token) return null
  const scope = await symmetricDecodeJWT<Scope>(token, env.BETTER_AUTH_SECRET, PURPOSE)
  if (!scope || scope.slug !== slug || !scope.organizationId) return null
  const session = await createAuth(env).api.getSession({ headers: event.req.headers, query: { disableRefresh: true } })
  if (!session || scope.sessionId !== session.session.id || scope.userId !== session.user.id) return null
  return { session, organizationId: scope.organizationId }
}
