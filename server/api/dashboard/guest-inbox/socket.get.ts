import { HTTPError, defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { guestInboxTarget } from '~/server/cloudflare/guest-inbox-events'
import { cloudflareEnv } from '~/server/utils/api-response'
import { createAuth } from '~/server/utils/auth'
import { requireFinancialBrowserOrAppRequest } from '~/server/utils/financial-browser'
import { membershipBySlugQuery } from '~/server/utils/member-access'
import { queryFirst } from '~/server/db'
import { readDashboardSocketScope } from '~/server/utils/dashboard-socket-scope'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const { org, scope } = getQuery(event)
  const personal = scope === 'account' && org === undefined
  const slug = scope === undefined && typeof org === 'string' && /^[a-z0-9-]+$/.test(org) ? org : null
  const startup = slug ? await readDashboardSocketScope(event, env, slug) : null
  const session = startup?.session ?? await createAuth(env).api.getSession({ headers: event.req.headers, query: { disableCookieCache: true, disableRefresh: true } })
  if (!session) throw new HTTPError({ statusCode: 401, message: 'Authentication required', data: { code: 'UNAUTHORIZED', field: 'session' } })
  requireFinancialBrowserOrAppRequest(event)
  if (event.req.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new HTTPError({ statusCode: 426, message: 'Expected WebSocket upgrade' })
  const namespace = env.GUEST_INBOX_HUBS
  if (!namespace) throw new HTTPError({ statusCode: 503, message: 'Dashboard realtime binding is not configured', data: { code: 'REALTIME_CONFIGURATION_REQUIRED', field: 'GUEST_INBOX_HUBS' } })
  if (!personal && !slug) throw new HTTPError({ statusCode: 400, message: 'A workspace or account scope is required' })
  let organizationId = startup?.organizationId ?? null
  if (slug && !organizationId) {
    const { query, params } = membershipBySlugQuery(slug, session.user.id)
    const membership = await queryFirst<{ organization_id: string }>(env.DB, query, params)
    if (!membership) {
      throw new HTTPError({ statusCode: 404, message: 'Organization not found', data: { code: 'ORGANIZATION_NOT_FOUND', field: 'org' } })
    }
    organizationId = membership.organization_id
  }
  const headers = {
    upgrade: 'websocket',
    'x-blawby-user-id': session.user.id,
    'x-blawby-session-id': session.session.id,
    'x-blawby-session-token': session.session.token,
    ...(organizationId !== null && { 'x-blawby-organization-id': organizationId }),
  }

  // URL and init rather than a Request: Wrangler's platform proxy stub for a
  // Durable Object (nuxt dev) stringifies a Request it is handed, and the
  // upgrade failed with "Failed to parse URL from [object Request]".
  const response = await namespace.get(namespace.idFromName(guestInboxTarget(organizationId, session.user.id))).fetch(event.req.url, {
    method: event.req.method,
    headers,
  })
  return response.status === 101 ? response : new Response(response.body, response)
})
